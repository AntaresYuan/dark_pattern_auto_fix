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

function escapeAttrValue(val: string): string {
  return val.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Returns just the first element's opening tag from an html_evidence string.
 * The model often copies a parent tag followed by descendants
 * (e.g. `<label ...> <input type="radio" name="x" checked>`); selector derivation
 * and candidate scoring must use ONLY the first tag's attributes — scraping a child's
 * attributes onto the parent produces a selector that matches nothing.
 */
function firstOpeningTag(evidence: string): string {
  const match = evidence.match(/<[a-z][a-z0-9-]*\b[^>]*>/i);
  return match ? match[0] : evidence;
}

/**
 * Derives a querySelector-compatible selector from a verbatim HTML opening tag.
 * Priority: #id → [data-*] → stable class names → tag+type/name/role.
 * Returns null if no stable anchor is found, which causes the pattern to be skipped.
 */
function deriveSelector(evidence: string): string | null {
  if (!evidence) return null;

  // Only consider the first element's opening tag — never descendants.
  const head = firstOpeningTag(evidence);
  const tagMatch = head.match(/^<([a-z][a-z0-9-]*)/i);
  const tag = tagMatch ? tagMatch[1].toLowerCase() : "";

  // id is always globally unique — skip everything else.
  // Anchor to a preceding space so `data-product-id="…"` isn't misread as `id` —
  // (it instead flows to the attribute branch below as a stable [data-*] anchor).
  const idMatch = head.match(/(?:^|\s)id="([^"]+)"/);
  if (idMatch) return `#${CSS.escape(idMatch[1])}`;

  // Stable class tokens → .class1.class2
  const classMatch = head.match(/(?:^|\s)class="([^"]+)"/);
  const classStr = classMatch
    ? classMatch[1].trim().split(/\s+/)
        .filter((c) => !looksLikeDynamicClass(c))
        .map((c) => `.${CSS.escape(c)}`)
        .join("")
    : "";

  // Every other attribute → [attr="val"], skipping id, class, style, and Vue scoped data-v-*
  const attrStr = Array.from(head.matchAll(/\b([\w-]+)="([^"]*)"/g))
    .filter(([, name]) =>
      name !== "id" &&
      name !== "class" &&
      name !== "style" &&
      !/^data-v-[a-f0-9]+$/i.test(name)
    )
    .map(([, attr, val]) => `[${attr}="${escapeAttrValue(val)}"]`)
    .join("");

  if (!classStr && !attrStr) return null;
  return `${tag}${classStr}${attrStr}`;
}

/**
 * Parses all name="value" pairs from an HTML opening tag string into a Map.
 * Used to score DOM candidates against html_evidence when a selector is ambiguous.
 */
function parseEvidenceAttributes(evidence: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const [, name, val] of evidence.matchAll(/\b([\w-]+)="([^"]*)"/g)) {
    attrs.set(name, val);
  }
  return attrs;
}

/**
 * Scores a DOM element against the parsed html_evidence attributes.
 * Each exact-match attribute contributes 1 point; class token sub-matches contribute 0.5.
 */
function scoreElementAgainstEvidence(element: Element, evidenceAttrs: Map<string, string>): number {
  let score = 0;
  for (const [name, val] of evidenceAttrs) {
    const actual = element.getAttribute(name);
    if (actual === null) continue;
    if (actual === val) {
      score += 1;
    } else if (name === "class") {
      // Partial class-token overlap still counts for something
      const evidenceTokens = new Set(val.split(/\s+/).filter(Boolean));
      const actualTokens = actual.split(/\s+/).filter(Boolean);
      const overlap = actualTokens.filter((t) => evidenceTokens.has(t)).length;
      score += overlap * 0.5;
    }
  }
  return score;
}

/**
 * When a selector matches multiple elements, score each against html_evidence attributes
 * and return the best match. Falls back to the first element when all scores are equal.
 */
function pickBestMatch(
  candidates: NodeListOf<Element>,
  evidence: string,
  traceId: string,
  derivedSelector: string
): Element {
  if (candidates.length === 1) return candidates[0];

  const evidenceAttrs = parseEvidenceAttributes(firstOpeningTag(evidence));
  let bestScore = -1;
  let bestElement = candidates[0];

  for (const el of Array.from(candidates)) {
    const score = scoreElementAgainstEvidence(el, evidenceAttrs);
    if (score > bestScore) {
      bestScore = score;
      bestElement = el;
    }
  }

  logEvent("content", "fix.pattern.multi_match", {
    traceId,
    derivedSelector: truncateText(derivedSelector, 120),
    candidateCount: candidates.length,
    bestScore
  }, "warn");

  return bestElement;
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
      htmlEvidence: truncateText(pattern.html_evidence, 120),
      targetSelector: truncateText(buildStableSelector(target), 120),
      outcome: "existing_label_present"
    }, "debug");
    return null;
  }

  logEvent("content", "fix.pattern.ad_label.create", {
    traceId,
    htmlEvidence: truncateText(pattern.html_evidence, 120),
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
      htmlEvidence: truncateText(pattern.html_evidence, 120),
      targetSelector: truncateText(buildStableSelector(target), 120),
      outcome: "label_missing_for_enhancement"
    }, "debug");
    return null;
  }

  const existingColor = window.getComputedStyle(existingLabel).color;
  if (computeBlackness(existingColor) >= MIN_AD_LABEL_BLACKNESS) {
    logEvent("content", "fix.pattern.ad_label.skip", {
      traceId,
      htmlEvidence: truncateText(pattern.html_evidence, 120),
      targetSelector: truncateText(buildStableSelector(existingLabel), 120),
      outcome: "label_already_dark_enough"
    }, "debug");
    return null;
  }

  logEvent("content", "fix.pattern.ad_label.enhance", {
    traceId,
    htmlEvidence: truncateText(pattern.html_evidence, 120),
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
  const evidence = truncateText(pattern.html_evidence, 120);

  if (!FIXABLE_TYPES.has(pattern.dark_pattern_type)) {
    logEvent("content", "fix.pattern.skip", {
      traceId,
      darkPatternType: pattern.dark_pattern_type,
      htmlEvidence: evidence,
      issues: pattern.issues,
      outcome: "unfixable_type"
    }, "debug");
    return [];
  }

  const derivedSelector = deriveSelector(pattern.html_evidence);
  if (!derivedSelector) {
    logEvent("content", "fix.pattern.skip", {
      traceId,
      darkPatternType: pattern.dark_pattern_type,
      htmlEvidence: evidence,
      outcome: "no_stable_anchor"
    }, "warn");
    return [];
  }

  let matchedElement: Element | null = null;
  try {
    const candidates = document.querySelectorAll(derivedSelector);
    if (candidates.length > 0) {
      matchedElement = pickBestMatch(candidates, pattern.html_evidence, traceId, derivedSelector);
    }
  } catch {
    // derivedSelector should always be valid, but guard just in case
  }

  if (!matchedElement) {
    logEvent("content", "fix.pattern.skip", {
      traceId,
      darkPatternType: pattern.dark_pattern_type,
      derivedSelector: truncateText(derivedSelector, 120),
      htmlEvidence: evidence,
      outcome: "element_not_found"
    }, "warn");
    return [];
  }

  const elementVisible = isVisible(matchedElement);
  if (!elementVisible) {
    logEvent("content", "fix.pattern.hidden_element", {
      traceId,
      darkPatternType: pattern.dark_pattern_type,
      derivedSelector: truncateText(derivedSelector, 120)
    }, "debug");
  }

  const resolution = resolveFixTarget(matchedElement, pattern.issues);
  const targetElement = resolution.target;
  const targetSelector = buildStableSelector(targetElement);
  if (resolution.reason) {
    logEvent("content", "fix.pattern.resolve_target", {
      traceId,
      darkPatternType: pattern.dark_pattern_type,
      derivedSelector: truncateText(derivedSelector, 120),
      resolvedSelector: truncateText(targetSelector, 120),
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
      derivedSelector: truncateText(derivedSelector, 120),
      resolvedSelector: truncateText(targetSelector, 120),
      appliedIssues,
      inferredStyles: appliedIssueSummaries,
      cssRules
    }, "info");
  }

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
        derivedSelector: truncateText(derivedSelector, 120),
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
        derivedSelector: truncateText(derivedSelector, 120),
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
        derivedSelector: truncateText(derivedSelector, 120),
        resolvedSelector: truncateText(targetSelector, 120),
        appliedIssues: [],
        cssRules: { opacity: "0.7" },
        strategy: "dim_fallback"
      }, "info");
    } else {
      logEvent("content", "fix.pattern.skip", {
        traceId,
        darkPatternType: pattern.dark_pattern_type,
        derivedSelector: truncateText(derivedSelector, 120),
        outcome: "no_fixes_generated"
      }, "warn");
    }
  }

  return fixes;
}

function isPageFix(fix: PageFix | null): fix is PageFix {
  return Boolean(fix);
}

/**
 * Locates the live-DOM element a model's html_evidence refers to, using the exact
 * same selector derivation + best-match scoring the fix path uses. Returns null when
 * no stable selector can be derived or nothing matches. Used by the F1 scorer so that
 * "which element did the model flag" is resolved identically to "which element gets fixed".
 */
export function locateElementForEvidence(
  htmlEvidence: string,
  modelSelector?: string,
  traceId = "f1",
): Element | null {
  // 1. Selector derived from the verbatim opening tag (most precise).
  const derived = deriveSelector(htmlEvidence);
  if (derived) {
    try {
      const candidates = document.querySelectorAll(derived);
      if (candidates.length > 0) {
        return pickBestMatch(candidates, htmlEvidence, traceId, derived);
      }
    } catch {
      // fall through
    }
  }
  // 2. The model's own css_selector — survives when html_evidence truncates on a quote.
  if (modelSelector && modelSelector.trim()) {
    try {
      const candidates = document.querySelectorAll(modelSelector);
      if (candidates.length > 0) {
        return pickBestMatch(candidates, htmlEvidence, traceId, modelSelector);
      }
    } catch {
      // invalid selector — fall through
    }
  }
  // 3. Text-content match for attribute-less evidence like `<a>No thanks…</a>`.
  return locateByText(htmlEvidence);
}

/**
 * Last-resort locator for the F1 scorer: finds the smallest element of the evidence's
 * tag whose normalized text equals (or tightly contains) the evidence's text. Used only
 * for "did the model point at this element" scoring — never for applying a fix.
 */
function locateByText(evidence: string): Element | null {
  const head = firstOpeningTag(evidence);
  const tagMatch = head.match(/^<([a-z][a-z0-9-]*)/i);
  const tag = tagMatch ? tagMatch[1].toLowerCase() : "";
  const text = evidence.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (text.length < 4) return null; // too short to disambiguate reliably

  const scope = tag ? document.querySelectorAll(tag) : document.querySelectorAll("*");
  let best: Element | null = null;
  let bestLen = Infinity;
  for (const element of Array.from(scope)) {
    const elementText = (element.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!elementText) continue;
    const isMatch = elementText === text || elementText.includes(text);
    // Prefer the most specific (shortest-text) element that still contains the evidence text.
    if (isMatch && elementText.length < bestLen) {
      best = element;
      bestLen = elementText.length;
    }
  }
  return best;
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

  const appliedCount = applyFixesToPage(fixes, { pageKey, traceId });
  step.finish({
    pageKey,
    patternCount: patterns.length,
    fixCount: fixes.length,
    appliedCount
  });
  return { archive, appliedCount };
}
