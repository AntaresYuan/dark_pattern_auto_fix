import type {
  AdvertisementLabelFix,
  CssFix,
  IdentifiedDarkPattern,
  IssueTag,
  PageFix,
  PageFixArchive
} from "../shared/types";
import { applyFixesToPage } from "./patchInjector";

const FIXABLE_TYPES = new Set(["Disguised ad", "False hierarchy"]);
const FALLBACK_COLOR = "#222222";
const FALLBACK_FONT_SIZE = "16px";
const FALLBACK_BACKGROUND_COLOR = "#e7e0d2";
const ADVERTISEMENT_LABEL_TEXT = "ADVERTISEMENT";
const MIN_AD_LABEL_BLACKNESS = 0.5;

function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function tryQuerySelector(selector: string): Element | null {
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

function isAdvertisementLabelText(text: string | null | undefined): boolean {
  return /^(ad|advertisement)$/i.test(text?.trim() ?? "");
}

function getClickableAncestor(element: Element): Element | null {
  return element.closest(
    "button, a, [role='button'], input[type='button'], input[type='submit'], input[type='reset']"
  );
}

function buildStableSelector(element: Element): string {
  if (element instanceof HTMLElement && element.id) {
    return `#${CSS.escape(element.id)}`;
  }

  const segments: string[] = [];
  let current: Element | null = element;

  while (current && current !== document.body && segments.length < 5) {
    const tag = current.tagName.toLowerCase();
    const classToken = Array.from(current.classList).slice(0, 2).map((name) => `.${CSS.escape(name)}`).join("");
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

function inferSafeColor(element: Element): string {
  for (const candidate of getNearbyElements(element)) {
    const color = window.getComputedStyle(candidate).color;
    if (color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent") {
      return color;
    }
  }

  return FALLBACK_COLOR;
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

function inferSafeBackgroundColor(element: Element): string {
  for (const candidate of getBackgroundCandidates(element)) {
    const style = window.getComputedStyle(candidate);
    if (hasStyledBackground(style) && looksButtonLike(candidate)) {
      return style.backgroundColor;
    }
  }

  for (const candidate of getBackgroundCandidates(element)) {
    const style = window.getComputedStyle(candidate);
    if (isUsableBackground(style)) {
      return style.backgroundColor;
    }
  }

  const parent = element.parentElement;
  if (parent) {
    const parentStyle = window.getComputedStyle(parent);
    if (isUsableBackground(parentStyle)) {
      return parentStyle.backgroundColor;
    }
  }

  return FALLBACK_BACKGROUND_COLOR;
}

function inferSafeFontSize(element: Element): string {
  for (const candidate of getNearbyElements(element)) {
    const fontSize = window.getComputedStyle(candidate).fontSize;
    if (fontSize) {
      return fontSize;
    }
  }

  return FALLBACK_FONT_SIZE;
}

function resolveFixTarget(element: Element, issues: IssueTag[]): Element {
  if (
    !issues.includes("background_color")
    && !issues.includes("add_advertisement_title")
    && !issues.includes("enhance_advertisement_title")
  ) {
    return element;
  }

  const clickableAncestor = getClickableAncestor(element);
  if (clickableAncestor && isVisible(clickableAncestor)) {
    return clickableAncestor;
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
      return current;
    }
    current = current.parentElement;
  }

  return element;
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
  stableSelector?: string
): AdvertisementLabelFix | null {
  const existingLabel = findAdvertisementLabel(target);
  if (existingLabel) {
    return null;
  }

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
  pattern: IdentifiedDarkPattern
): CssFix | null {
  const existingLabel = findAdvertisementLabel(target);
  if (!existingLabel) {
    return null;
  }

  const existingColor = window.getComputedStyle(existingLabel).color;
  if (computeBlackness(existingColor) >= MIN_AD_LABEL_BLACKNESS) {
    return null;
  }

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

function createFixesForPattern(pattern: IdentifiedDarkPattern): PageFix[] {
  if (!FIXABLE_TYPES.has(pattern.dark_pattern_type) || pattern.issues.length === 0) {
    return [];
  }

  const matchedElement = tryQuerySelector(pattern.css_selector);
  if (!matchedElement || !isVisible(matchedElement)) {
    return [];
  }

  const targetElement = resolveFixTarget(matchedElement, pattern.issues);

  // Use the LLM's stable selector when resolveFixTarget didn't navigate to an ancestor.
  // If it did navigate up, the LLM selector points to the wrong element, so fall back to
  // buildStableSelector which generates a selector from the resolved ancestor.
  const targetSelector =
    pattern.selector_stability === "stable" && targetElement === matchedElement
      ? pattern.css_selector
      : buildStableSelector(targetElement);

  const fixes: PageFix[] = [];

  const cssRules: CssFix["css_rules"] = {};
  const appliedIssues: IssueTag[] = [];

  if (pattern.issues.includes("color")) {
    cssRules.color = inferSafeColor(targetElement);
    appliedIssues.push("color");
  }

  if (pattern.issues.includes("background_color")) {
    cssRules["background-color"] = inferSafeBackgroundColor(targetElement);
    cssRules["background-image"] = "none";
    appliedIssues.push("background_color");
  }

  if (pattern.issues.includes("font_size")) {
    cssRules["font-size"] = inferSafeFontSize(targetElement);
    appliedIssues.push("font_size");
  }

  if (appliedIssues.length > 0) {
    fixes.push({
      css_selector: targetSelector,
      patch_type: "css",
      css_rules: cssRules,
      source_dark_pattern_type: pattern.dark_pattern_type,
      applied_issues: appliedIssues
    });
  }

  if (pattern.dark_pattern_type === "Disguised ad" && pattern.issues.includes("add_advertisement_title")) {
    const labelFix = createAdvertisementLabelFix(targetElement, pattern, targetSelector);
    if (labelFix) {
      fixes.push(labelFix);
    }
  }

  if (pattern.dark_pattern_type === "Disguised ad" && pattern.issues.includes("enhance_advertisement_title")) {
    const titleEnhancementFix = createAdvertisementLabelEnhancementFix(targetElement, pattern);
    if (titleEnhancementFix) {
      fixes.push(titleEnhancementFix);
    }
  }

  return fixes;
}

function isPageFix(fix: PageFix | null): fix is PageFix {
  return Boolean(fix);
}

function flattenFixes(patterns: IdentifiedDarkPattern[]): PageFix[] {
  return patterns.flatMap((pattern) => createFixesForPattern(pattern)).filter(isPageFix);
}

export function planAndApplyFixes(
  pageKey: string,
  patterns: IdentifiedDarkPattern[]
): { archive: PageFixArchive; appliedCount: number } {
  const fixes = flattenFixes(patterns);

  const archive: PageFixArchive = {
    page_key: pageKey,
    fixes
  };

  const appliedCount = applyFixesToPage(fixes);
  return { archive, appliedCount };
}
