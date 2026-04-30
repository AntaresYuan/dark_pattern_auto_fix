import type {
  AdvertisementLabelFix,
  CssFix,
  IdentifiedDarkPattern,
  IssueTag,
  PageFix,
  PageFixArchive
} from "../shared/types";
import { logEvent, startStep, truncateText } from "../shared/logger";
import { applyFixesToPage } from "./patchInjector";

const FIXABLE_TYPES = new Set([
  "Disguised ad", "False hierarchy",
  "Preselection", "Pop-up ad", "Trick wording",
  "Confirm shaming", "Fake social proof", "Forced Action", "Hidden information"
]);
const POPUP_TYPES = new Set(["Pop-up ad"]);
const TEXT_DIM_TYPES = new Set([
  "Preselection", "Trick wording", "Confirm shaming",
  "Fake social proof", "Forced Action", "Hidden information"
]);
// Fallback when no issue-specific fix was generated:
// dim the deceptive element slightly to visually flag it without breaking layout.
const DIM_FALLBACK_TYPES = new Set([
  "Disguised ad", "False hierarchy"
]);
const FALLBACK_COLOR = "#222222";
const FALLBACK_FONT_SIZE = "16px";
const FALLBACK_BACKGROUND_COLOR = "#e7e0d2";
const ADVERTISEMENT_LABEL_TEXT = "ADVERTISEMENT";
const MIN_AD_LABEL_BLACKNESS = 0.5;
type FixTargetResolutionReason = "clickable_ancestor" | "styled_surface_ancestor";

function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function tryQuerySelector(selector: string): Element | null {
  // First attempt: exact selector
  try {
    const el = document.querySelector(selector);
    if (el) return el;
  } catch {
    // Invalid CSS — fall through to alternatives
  }

  // Handle jQuery-style :contains('text') which querySelector doesn't support
  const containsMatch = selector.match(/:contains\(['"]([^'"]+)['"]\)/);
  if (containsMatch) {
    const text = containsMatch[1];
    const baseSelector = selector.slice(0, selector.indexOf(":contains(")).trim() || "*";
    try {
      const candidates = Array.from(document.querySelectorAll(baseSelector));
      const found = candidates.find((el) => (el.textContent ?? "").trim().includes(text));
      if (found) return found;
    } catch {
      // baseSelector also invalid — search all leaf elements
    }
    // Fallback: search all leaf-level elements for the text
    return Array.from(document.querySelectorAll("*")).find(
      (el) => el.children.length === 0 && (el.textContent ?? "").trim().includes(text)
    ) ?? null;
  }

  // Strip Vue/Angular scoped attributes ([data-v-XXXXXXXX]) and retry
  const withoutScoped = selector.replace(/\[data-v-[a-f0-9]+\]/gi, "").trim();
  if (withoutScoped && withoutScoped !== selector) {
    try {
      const el = document.querySelector(withoutScoped);
      if (el) return el;
    } catch {
      // still invalid
    }
  }

  // Progressive shortening: drop leading ancestor segments one at a time.
  // ".product-main .button-primary" → ".button-primary"
  // Splits only on whitespace that is NOT inside brackets/parens to avoid
  // splitting inside attribute selectors like [attr='a b'].
  const parts = selector.split(/\s+(?=[.#\[a-zA-Z*])/);
  for (let drop = 1; drop < parts.length; drop++) {
    const shortened = parts.slice(drop).join(" ").trim();
    if (!shortened) continue;
    try {
      const el = document.querySelector(shortened);
      if (el) return el;
    } catch {
      // shortened selector still invalid, keep trying
    }
  }

  return null;
}

/**
 * Last-resort fallback: parse the raw HTML opening tag from html_evidence and
 * try to locate a matching DOM element by its id, data attributes, or class names.
 */
function findByHtmlEvidence(evidence: string): Element | null {
  if (!evidence) return null;

  // Extract id — highest specificity, always unique
  const idMatch = evidence.match(/\bid="([^"]+)"/);
  if (idMatch) {
    try {
      const el = document.getElementById(idMatch[1]);
      if (el) return el;
    } catch { /* ignore */ }
  }

  // Extract tag name (default "*")
  const tagMatch = evidence.match(/^<([a-z][a-z0-9-]*)/i);
  const tag = tagMatch ? tagMatch[1].toLowerCase() : "*";

  // Extract data-* attributes and try a selector built from them
  const dataAttrs = Array.from(evidence.matchAll(/\b(data-[a-z][\w-]*)="([^"]*)"/gi));
  for (const [, attr, val] of dataAttrs) {
    try {
      const el = document.querySelector(`${tag}[${attr}="${val}"]`);
      if (el) return el;
    } catch { /* ignore */ }
    try {
      const el = document.querySelector(`[${attr}="${val}"]`);
      if (el) return el;
    } catch { /* ignore */ }
  }

  // Extract class names and try combinations
  const classMatch = evidence.match(/\bclass="([^"]+)"/);
  if (classMatch) {
    const classes = classMatch[1].trim().split(/\s+/).filter((c) => !looksLikeDynamicClass(c));
    if (classes.length > 0) {
      // Try all stable classes together
      try {
        const sel = `${tag}.${classes.map((c) => CSS.escape(c)).join(".")}`;
        const el = document.querySelector(sel);
        if (el) return el;
      } catch { /* ignore */ }

      // Try subsets (drop one class at a time from the right)
      for (let take = classes.length - 1; take >= 1; take--) {
        try {
          const sel = `${tag}.${classes.slice(0, take).map((c) => CSS.escape(c)).join(".")}`;
          const el = document.querySelector(sel);
          if (el) return el;
        } catch { /* ignore */ }
      }

      // Try each class alone (most permissive)
      for (const cls of classes) {
        try {
          const el = document.querySelector(`${tag}.${CSS.escape(cls)}`);
          if (el) return el;
        } catch { /* ignore */ }
      }
    }
  }

  // Text content fallback: LLM sometimes hallucinates class names that don't exist
  // in the DOM but copies the real text content correctly. Strip HTML tags from the
  // evidence to get the visible text, then find the most specific element whose
  // textContent contains it (shortest textContent = deepest/most specific match).
  const inlineText = evidence.replace(/<[^>]+>/g, "").trim();
  if (inlineText.length >= 8) {
    const lower = inlineText.toLowerCase();

    // Tag-scoped search first (LLM got the tag right)
    const scopedMatches = Array.from(document.querySelectorAll(tag !== "*" ? tag : "*")).filter(
      (el) => (el.textContent ?? "").toLowerCase().includes(lower)
    );
    if (scopedMatches.length > 0) {
      scopedMatches.sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0));
      return scopedMatches[0];
    }

    // Full-DOM search: LLM got the tag wrong, find most specific match across all elements
    const allMatches = Array.from(document.querySelectorAll("*")).filter(
      (el) => (el.textContent ?? "").toLowerCase().includes(lower)
    );
    if (allMatches.length > 0) {
      allMatches.sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0));
      return allMatches[0];
    }
  }

  return null;
}

function isAdvertisementLabelText(text: string | null | undefined): boolean {
  return /^(ad|advertisement)$/i.test(text?.trim() ?? "");
}

function getClickableAncestor(element: Element): Element | null {
  return element.closest(
    "button, a, [role='button'], input[type='button'], input[type='submit'], input[type='reset']"
  );
}

function looksLikeDynamicClass(name: string): boolean {
  if (name.length < 2 || name.length > 60) return true;
  // Hashed names from CSS-in-JS / webpack: _3Bx2a, s1k9p4m, a3b2c1
  if (/^[_a-z]{0,2}[0-9a-f]{4,}$/i.test(name)) return true;
  // CSS-in-JS runtime prefixes: css-xyz, sc-xyz, emotion-xyz
  if (/^(css|sc|jss|emotion|hash|tw)-/i.test(name)) return true;
  // Purely numeric
  if (/^[0-9]+$/.test(name)) return true;
  return false;
}

function buildStableSelector(element: Element): string {
  if (element instanceof HTMLElement && element.id) {
    return `#${CSS.escape(element.id)}`;
  }

  const segments: string[] = [];
  let current: Element | null = element;

  while (current && current !== document.body && segments.length < 5) {
    const tag = current.tagName.toLowerCase();
    const classToken = Array.from(current.classList)
      .filter((name) => !looksLikeDynamicClass(name))
      .slice(0, 2)
      .map((name) => `.${CSS.escape(name)}`)
      .join("");
    const parent: Element | null = current.parentElement;

    if (!parent) {
      segments.unshift(`${tag}${classToken}`);
      break;
    }

    const currentTagName = current.tagName;
    const siblings = Array.from(parent.children).filter(
      (child: Element) => child.tagName === currentTagName
    );
    const index = siblings.indexOf(current) + 1;
    segments.unshift(`${tag}${classToken}:nth-of-type(${Math.max(index, 1)})`);
    current = parent;
  }

  return segments.join(" > ");
}

function getNearbyElements(element: Element): Element[] {
  const candidates = new Set<Element>();
  const parent = element.parentElement;

  if (parent) {
    candidates.add(parent);
    Array.from(parent.children).forEach((child) => {
      if (child !== element) {
        candidates.add(child);
      }
    });
  }

  if (element.previousElementSibling) {
    candidates.add(element.previousElementSibling);
  }

  if (element.nextElementSibling) {
    candidates.add(element.nextElementSibling);
  }

  if (parent?.parentElement) {
    candidates.add(parent.parentElement);
  }

  return Array.from(candidates).filter((candidate) => isVisible(candidate));
}

function inferSafeColor(element: Element): { value: string; usedFallback: boolean } {
  for (const candidate of getNearbyElements(element)) {
    const color = window.getComputedStyle(candidate).color;
    if (color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent") {
      return { value: color, usedFallback: false };
    }
  }

  return { value: FALLBACK_COLOR, usedFallback: true };
}

function isUsableBackground(style: CSSStyleDeclaration): boolean {
  return Boolean(style.backgroundColor)
    && style.backgroundColor !== "rgba(0, 0, 0, 0)"
    && style.backgroundColor !== "transparent";
}

function hasStyledBackground(style: CSSStyleDeclaration): boolean {
  return isUsableBackground(style) || style.backgroundImage !== "none";
}

function parsePixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCssColor(color: string): { r: number; g: number; b: number; a: number } | null {
  const normalized = color.trim().toLowerCase();

  const rgbMatch = normalized.match(
    /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/
  );
  if (rgbMatch) {
    return {
      r: Number.parseFloat(rgbMatch[1]),
      g: Number.parseFloat(rgbMatch[2]),
      b: Number.parseFloat(rgbMatch[3]),
      a: rgbMatch[4] ? Number.parseFloat(rgbMatch[4]) : 1
    };
  }

  const hexMatch = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (!hexMatch) {
    return null;
  }

  const hex = hexMatch[1];
  if (hex.length === 3) {
    return {
      r: Number.parseInt(`${hex[0]}${hex[0]}`, 16),
      g: Number.parseInt(`${hex[1]}${hex[1]}`, 16),
      b: Number.parseInt(`${hex[2]}${hex[2]}`, 16),
      a: 1
    };
  }

  if (hex.length === 6) {
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
      a: 1
    };
  }

  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
    a: Number.parseInt(hex.slice(6, 8), 16) / 255
  };
}

function computeBlackness(color: string): number {
  const parsed = parseCssColor(color);
  if (!parsed) {
    return 0;
  }

  const alpha = Math.min(Math.max(parsed.a, 0), 1);
  const blendedR = 255 - ((255 - parsed.r) * alpha);
  const blendedG = 255 - ((255 - parsed.g) * alpha);
  const blendedB = 255 - ((255 - parsed.b) * alpha);
  const averageLightness = (blendedR + blendedG + blendedB) / (255 * 3);

  return 1 - averageLightness;
}

function looksLikeCompactSurface(candidate: Element, reference: Element): boolean {
  const candidateRect = candidate.getBoundingClientRect();
  const referenceRect = reference.getBoundingClientRect();

  if (candidateRect.width === 0 || candidateRect.height === 0) {
    return false;
  }

  if (candidateRect.height > Math.max(referenceRect.height * 3.5, 140)) {
    return false;
  }

  if (candidateRect.width > Math.max(referenceRect.width * 1.9, referenceRect.width + 220)) {
    return false;
  }

  return true;
}

function looksButtonLike(element: Element): boolean {
  if (element.matches("button, a, [role='button'], input[type='button'], input[type='submit'], input[type='reset']")) {
    return true;
  }

  const style = window.getComputedStyle(element);
  const hasRoundedCorners =
    parsePixelValue(style.borderTopLeftRadius) > 0
    || parsePixelValue(style.borderTopRightRadius) > 0
    || parsePixelValue(style.borderBottomLeftRadius) > 0
    || parsePixelValue(style.borderBottomRightRadius) > 0;
  const hasPadding =
    parsePixelValue(style.paddingTop) + parsePixelValue(style.paddingBottom) > 0
    || parsePixelValue(style.paddingLeft) + parsePixelValue(style.paddingRight) > 0;

  return style.cursor === "pointer" || hasRoundedCorners || hasPadding;
}

function getBackgroundCandidates(element: Element): Element[] {
  const parent = element.parentElement;
  const siblingElements = parent
    ? Array.from(parent.children).filter((candidate) => candidate !== element && isVisible(candidate))
    : [];
  const sameTagSiblings = siblingElements.filter((candidate) => candidate.tagName === element.tagName);
  const peerSurfaces = siblingElements.filter((candidate) => looksLikeCompactSurface(candidate, element));
  const sameTagPeerSurfaces = peerSurfaces.filter((candidate) => candidate.tagName === element.tagName);
  const otherPeerSurfaces = peerSurfaces.filter((candidate) => !sameTagPeerSurfaces.includes(candidate));
  const nearbyPeers = getNearbyElements(element).filter(
    (candidate) => !sameTagSiblings.includes(candidate)
      && !sameTagPeerSurfaces.includes(candidate)
      && !otherPeerSurfaces.includes(candidate)
      && looksLikeCompactSurface(candidate, element)
  );
  const containerFallbacks = getNearbyElements(element).filter(
    (candidate) => !sameTagSiblings.includes(candidate)
      && !sameTagPeerSurfaces.includes(candidate)
      && !otherPeerSurfaces.includes(candidate)
      && !nearbyPeers.includes(candidate)
  );

  return [
    ...sameTagPeerSurfaces,
    ...otherPeerSurfaces,
    ...sameTagSiblings,
    ...nearbyPeers,
    ...containerFallbacks
  ];
}

function inferSafeBackgroundColor(element: Element): { value: string; usedFallback: boolean } {
  for (const candidate of getBackgroundCandidates(element)) {
    const style = window.getComputedStyle(candidate);
    if (hasStyledBackground(style) && looksButtonLike(candidate)) {
      return { value: style.backgroundColor, usedFallback: false };
    }
  }

  for (const candidate of getBackgroundCandidates(element)) {
    const style = window.getComputedStyle(candidate);
    if (isUsableBackground(style)) {
      return { value: style.backgroundColor, usedFallback: false };
    }
  }

  const parent = element.parentElement;
  if (parent) {
    const parentStyle = window.getComputedStyle(parent);
    if (isUsableBackground(parentStyle)) {
      return { value: parentStyle.backgroundColor, usedFallback: false };
    }
  }

  return { value: FALLBACK_BACKGROUND_COLOR, usedFallback: true };
}

function inferSafeFontSize(element: Element): { value: string; usedFallback: boolean } {
  for (const candidate of getNearbyElements(element)) {
    const fontSize = window.getComputedStyle(candidate).fontSize;
    if (fontSize) {
      return { value: fontSize, usedFallback: false };
    }
  }

  return { value: FALLBACK_FONT_SIZE, usedFallback: true };
}

function resolveFixTarget(
  element: Element,
  issues: IssueTag[]
): { target: Element; reason?: FixTargetResolutionReason } {
  if (
    !issues.includes("background_color")
    && !issues.includes("add_advertisement_title")
    && !issues.includes("enhance_advertisement_title")
  ) {
    return { target: element };
  }

  const clickableAncestor = getClickableAncestor(element);
  if (clickableAncestor && isVisible(clickableAncestor)) {
    return { target: clickableAncestor, reason: "clickable_ancestor" };
  }

  let current: Element | null = element;
  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    if (
      hasStyledBackground(style)
      && isVisible(current)
      && looksLikeCompactSurface(current, element)
      && looksButtonLike(current)
    ) {
      return { target: current, reason: "styled_surface_ancestor" };
    }
    current = current.parentElement;
  }

  return { target: element };
}

function findAdvertisementLabel(target: Element): HTMLElement | null {
  const parent = target.parentElement;
  if (!parent) {
    return null;
  }

  for (const sibling of Array.from(parent.children)) {
    if (sibling === target) {
      break;
    }

    if (sibling instanceof HTMLElement && isAdvertisementLabelText(sibling.textContent)) {
      return sibling;
    }
  }

  const directTextMatch = Array.from(parent.querySelectorAll("*")).find(
    (candidate) => candidate instanceof HTMLElement && isAdvertisementLabelText(candidate.textContent)
  );
  return directTextMatch instanceof HTMLElement ? directTextMatch : null;
}

function createAdvertisementLabelFix(
  target: Element,
  pattern: IdentifiedDarkPattern,
  traceId: string,
  stableSelector?: string
): AdvertisementLabelFix | null {
  const existingLabel = findAdvertisementLabel(target);
  if (existingLabel) {
    logEvent("content", "fix.pattern.ad_label.skip", {
      traceId,
      sourceSelector: truncateText(pattern.css_selector, 120),
      targetSelector: truncateText(buildStableSelector(target), 120),
      outcome: "existing_label_present"
    }, "debug");
    return null;
  }

  logEvent("content", "fix.pattern.ad_label.create", {
    traceId,
    sourceSelector: truncateText(pattern.css_selector, 120),
    targetSelector: truncateText(buildStableSelector(target), 120),
    outcome: "fix_created"
  }, "info");
  return {
    css_selector: stableSelector ?? buildStableSelector(target),
    patch_type: "advertisement_label",
    label_text: ADVERTISEMENT_LABEL_TEXT,
    source_dark_pattern_type: pattern.dark_pattern_type,
    applied_issues: ["add_advertisement_title"]
  };
}

function createAdvertisementLabelEnhancementFix(
  target: Element,
  pattern: IdentifiedDarkPattern,
  traceId: string
): CssFix | null {
  const existingLabel = findAdvertisementLabel(target);
  if (!existingLabel) {
    logEvent("content", "fix.pattern.ad_label.skip", {
      traceId,
      sourceSelector: truncateText(pattern.css_selector, 120),
      targetSelector: truncateText(buildStableSelector(target), 120),
      outcome: "label_missing_for_enhancement"
    }, "debug");
    return null;
  }

  const existingColor = window.getComputedStyle(existingLabel).color;
  if (computeBlackness(existingColor) >= MIN_AD_LABEL_BLACKNESS) {
    logEvent("content", "fix.pattern.ad_label.skip", {
      traceId,
      sourceSelector: truncateText(pattern.css_selector, 120),
      targetSelector: truncateText(buildStableSelector(existingLabel), 120),
      outcome: "label_already_dark_enough"
    }, "debug");
    return null;
  }

  logEvent("content", "fix.pattern.ad_label.enhance", {
    traceId,
    sourceSelector: truncateText(pattern.css_selector, 120),
    targetSelector: truncateText(buildStableSelector(existingLabel), 120),
    outcome: "fix_created"
  }, "info");
  return {
    css_selector: buildStableSelector(existingLabel),
    patch_type: "css",
    css_rules: {
      color: "#000000"
    },
    source_dark_pattern_type: pattern.dark_pattern_type,
    applied_issues: ["enhance_advertisement_title"]
  };
}

function createFixesForPattern(pattern: IdentifiedDarkPattern, traceId: string): PageFix[] {
  if (!FIXABLE_TYPES.has(pattern.dark_pattern_type)) {
    logEvent("content", "fix.pattern.skip", {
      traceId,
      darkPatternType: pattern.dark_pattern_type,
      sourceSelector: truncateText(pattern.css_selector, 120),
      issues: pattern.issues,
      outcome: "unfixable_type"
    }, "debug");
    return [];
  }

  let matchedElement = tryQuerySelector(pattern.css_selector);
  if (!matchedElement && pattern.html_evidence) {
    matchedElement = findByHtmlEvidence(pattern.html_evidence);
    if (matchedElement) {
      logEvent("content", "fix.pattern.evidence_fallback", {
        traceId,
        darkPatternType: pattern.dark_pattern_type,
        sourceSelector: truncateText(pattern.css_selector, 120),
        htmlEvidence: truncateText(pattern.html_evidence, 120)
      }, "info");
    }
  }
  if (!matchedElement) {
    logEvent("content", "fix.pattern.skip", {
      traceId,
      darkPatternType: pattern.dark_pattern_type,
      sourceSelector: truncateText(pattern.css_selector, 120),
      htmlEvidence: truncateText(pattern.html_evidence ?? "", 120),
      outcome: "selector_not_found"
    }, "warn");
    return [];
  }
  const elementVisible = isVisible(matchedElement);
  if (!elementVisible) {
    // Element is in the DOM but hidden. Still generate CSS fixes so they take
    // effect if/when the element becomes visible. Skip only DOM-mutation fixes.
    logEvent("content", "fix.pattern.hidden_element", {
      traceId,
      darkPatternType: pattern.dark_pattern_type,
      sourceSelector: truncateText(pattern.css_selector, 120)
    }, "debug");
  }

  const resolution = resolveFixTarget(matchedElement, pattern.issues);
  const targetElement = resolution.target;
  const targetSelector = buildStableSelector(targetElement);
  if (resolution.reason) {
    logEvent("content", "fix.pattern.resolve_target", {
      traceId,
      darkPatternType: pattern.dark_pattern_type,
      sourceSelector: truncateText(pattern.css_selector, 120),
      resolvedSelector: truncateText(buildStableSelector(targetElement), 120),
      reason: resolution.reason
    }, "debug");
  }
  const fixes: PageFix[] = [];
  const appliedIssueSummaries: Array<{ issue: IssueTag; value: string; usedFallback: boolean }> = [];

  const cssRules: CssFix["css_rules"] = {};
  const appliedIssues: IssueTag[] = [];

  if (pattern.issues.includes("color")) {
    const inferred = inferSafeColor(targetElement);
    cssRules.color = inferred.value;
    appliedIssues.push("color");
    appliedIssueSummaries.push({ issue: "color", value: inferred.value, usedFallback: inferred.usedFallback });
  }

  if (pattern.issues.includes("background_color")) {
    const inferred = inferSafeBackgroundColor(targetElement);
    cssRules["background-color"] = inferred.value;
    cssRules["background-image"] = "none";
    appliedIssues.push("background_color");
    appliedIssueSummaries.push({
      issue: "background_color",
      value: inferred.value,
      usedFallback: inferred.usedFallback
    });
  }

  if (pattern.issues.includes("font_size")) {
    const inferred = inferSafeFontSize(targetElement);
    cssRules["font-size"] = inferred.value;
    appliedIssues.push("font_size");
    appliedIssueSummaries.push({ issue: "font_size", value: inferred.value, usedFallback: inferred.usedFallback });
  }

  if (appliedIssues.length > 0) {
    fixes.push({
      css_selector: targetSelector,
      patch_type: "css",
      css_rules: cssRules,
      source_dark_pattern_type: pattern.dark_pattern_type,
      applied_issues: appliedIssues
    });
    logEvent("content", "fix.pattern.generate", {
      traceId,
      darkPatternType: pattern.dark_pattern_type,
      sourceSelector: truncateText(pattern.css_selector, 120),
      resolvedSelector: truncateText(buildStableSelector(targetElement), 120),
      appliedIssues,
      inferredStyles: appliedIssueSummaries,
      cssRules
    }, "info");
  }

  // DOM mutation fixes only make sense when the element is actually visible
  if (elementVisible) {
    if (pattern.dark_pattern_type === "Disguised ad" && pattern.issues.includes("add_advertisement_title")) {
      const labelFix = createAdvertisementLabelFix(targetElement, pattern, traceId, targetSelector);
      if (labelFix) {
        fixes.push(labelFix);
      }
    }

    if (pattern.dark_pattern_type === "Disguised ad" && pattern.issues.includes("enhance_advertisement_title")) {
      const titleEnhancementFix = createAdvertisementLabelEnhancementFix(targetElement, pattern, traceId);
      if (titleEnhancementFix) {
        fixes.push(titleEnhancementFix);
      }
    }
  }

  if (fixes.length === 0) {
    if (POPUP_TYPES.has(pattern.dark_pattern_type)) {
      fixes.push({
        css_selector: targetSelector,
        patch_type: "css",
        css_rules: { display: "none" },
        source_dark_pattern_type: pattern.dark_pattern_type,
        applied_issues: []
      });
      logEvent("content", "fix.pattern.generate", {
        traceId,
        darkPatternType: pattern.dark_pattern_type,
        sourceSelector: truncateText(pattern.css_selector, 120),
        resolvedSelector: truncateText(targetSelector, 120),
        appliedIssues: [],
        cssRules: { display: "none" },
        strategy: "universal_hide"
      }, "info");
    } else if (TEXT_DIM_TYPES.has(pattern.dark_pattern_type)) {
      fixes.push({
        css_selector: targetSelector,
        patch_type: "css",
        css_rules: { opacity: "0.5" },
        source_dark_pattern_type: pattern.dark_pattern_type,
        applied_issues: []
      });
      logEvent("content", "fix.pattern.generate", {
        traceId,
        darkPatternType: pattern.dark_pattern_type,
        sourceSelector: truncateText(pattern.css_selector, 120),
        resolvedSelector: truncateText(targetSelector, 120),
        appliedIssues: [],
        cssRules: { opacity: "0.5" },
        strategy: "universal_dim"
      }, "info");
    } else if (DIM_FALLBACK_TYPES.has(pattern.dark_pattern_type)) {
      fixes.push({
        css_selector: targetSelector,
        patch_type: "css",
        css_rules: { opacity: "0.7" },
        source_dark_pattern_type: pattern.dark_pattern_type,
        applied_issues: []
      });
      logEvent("content", "fix.pattern.generate", {
        traceId,
        darkPatternType: pattern.dark_pattern_type,
        sourceSelector: truncateText(pattern.css_selector, 120),
        resolvedSelector: truncateText(targetSelector, 120),
        appliedIssues: [],
        cssRules: { opacity: "0.7" },
        strategy: "dim_fallback"
      }, "info");
    } else {
      logEvent("content", "fix.pattern.skip", {
        traceId,
        darkPatternType: pattern.dark_pattern_type,
        sourceSelector: truncateText(pattern.css_selector, 120),
        outcome: "no_fixes_generated"
      }, "warn");
    }
  }

  return fixes;
}

function isPageFix(fix: PageFix | null): fix is PageFix {
  return Boolean(fix);
}

export function planAndApplyFixes(
  pageKey: string,
  patterns: IdentifiedDarkPattern[],
  traceId: string
): { archive: PageFixArchive; appliedCount: number } {
  const step = startStep("content", "fix.plan", {
    pageKey,
    patternCount: patterns.length,
    traceId
  });

  const fixes = patterns.flatMap((pattern) => createFixesForPattern(pattern, traceId)).filter(isPageFix);

  const archive: PageFixArchive = {
    page_key: pageKey,
    fixes
  };

  const appliedCount = applyFixesToPage(fixes, {
    pageKey,
    traceId
  });
  step.finish({
    pageKey,
    patternCount: patterns.length,
    fixCount: fixes.length,
    appliedCount
  });
  return { archive, appliedCount };
}
