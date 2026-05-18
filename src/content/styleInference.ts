import type { IssueTag } from "../shared/types";

const FALLBACK_COLOR = "#222222";
const FALLBACK_FONT_SIZE = "16px";
const FALLBACK_BACKGROUND_COLOR = "#e7e0d2";

type FixTargetResolutionReason = "clickable_ancestor" | "styled_surface_ancestor";

export function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
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
  if (!hexMatch) return null;

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

// Returns a value in [0, 1] representing how dark/black the color appears on a white background.
export function computeBlackness(color: string): number {
  const parsed = parseCssColor(color);
  if (!parsed) return 0;
  const alpha = Math.min(Math.max(parsed.a, 0), 1);
  const blendedR = 255 - (255 - parsed.r) * alpha;
  const blendedG = 255 - (255 - parsed.g) * alpha;
  const blendedB = 255 - (255 - parsed.b) * alpha;
  return 1 - (blendedR + blendedG + blendedB) / (255 * 3);
}

function getNearbyElements(element: Element): Element[] {
  const candidates = new Set<Element>();
  const parent = element.parentElement;

  if (parent) {
    candidates.add(parent);
    Array.from(parent.children).forEach((child) => {
      if (child !== element) candidates.add(child);
    });
  }
  if (element.previousElementSibling) candidates.add(element.previousElementSibling);
  if (element.nextElementSibling) candidates.add(element.nextElementSibling);
  if (parent?.parentElement) candidates.add(parent.parentElement);

  return Array.from(candidates).filter((c) => isVisible(c));
}

function isUsableBackground(style: CSSStyleDeclaration): boolean {
  return Boolean(style.backgroundColor)
    && style.backgroundColor !== "rgba(0, 0, 0, 0)"
    && style.backgroundColor !== "transparent";
}

function hasStyledBackground(style: CSSStyleDeclaration): boolean {
  return isUsableBackground(style) || style.backgroundImage !== "none";
}

function looksLikeCompactSurface(candidate: Element, reference: Element): boolean {
  const cRect = candidate.getBoundingClientRect();
  const rRect = reference.getBoundingClientRect();
  if (cRect.width === 0 || cRect.height === 0) return false;
  if (cRect.height > Math.max(rRect.height * 3.5, 140)) return false;
  if (cRect.width > Math.max(rRect.width * 1.9, rRect.width + 220)) return false;
  return true;
}

function looksButtonLike(element: Element): boolean {
  if (element.matches("button, a, [role='button'], input[type='button'], input[type='submit'], input[type='reset']")) {
    return true;
  }
  const style = window.getComputedStyle(element);
  const hasRoundedCorners =
    parsePixelValue(style.borderTopLeftRadius) > 0 ||
    parsePixelValue(style.borderTopRightRadius) > 0 ||
    parsePixelValue(style.borderBottomLeftRadius) > 0 ||
    parsePixelValue(style.borderBottomRightRadius) > 0;
  const hasPadding =
    parsePixelValue(style.paddingTop) + parsePixelValue(style.paddingBottom) > 0 ||
    parsePixelValue(style.paddingLeft) + parsePixelValue(style.paddingRight) > 0;
  return style.cursor === "pointer" || hasRoundedCorners || hasPadding;
}

function getBackgroundCandidates(element: Element): Element[] {
  const parent = element.parentElement;
  const siblings = parent
    ? Array.from(parent.children).filter((c) => c !== element && isVisible(c))
    : [];
  const sameTagSiblings = siblings.filter((c) => c.tagName === element.tagName);
  const peerSurfaces = siblings.filter((c) => looksLikeCompactSurface(c, element));
  const sameTagPeers = peerSurfaces.filter((c) => c.tagName === element.tagName);
  const otherPeers = peerSurfaces.filter((c) => !sameTagPeers.includes(c));
  const nearbyPeers = getNearbyElements(element).filter(
    (c) => !sameTagSiblings.includes(c) && !sameTagPeers.includes(c) &&
           !otherPeers.includes(c) && looksLikeCompactSurface(c, element)
  );
  const containerFallbacks = getNearbyElements(element).filter(
    (c) => !sameTagSiblings.includes(c) && !sameTagPeers.includes(c) &&
           !otherPeers.includes(c) && !nearbyPeers.includes(c)
  );
  return [...sameTagPeers, ...otherPeers, ...sameTagSiblings, ...nearbyPeers, ...containerFallbacks];
}

export function inferSafeColor(element: Element): { value: string; usedFallback: boolean } {
  for (const candidate of getNearbyElements(element)) {
    const color = window.getComputedStyle(candidate).color;
    if (color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent") {
      return { value: color, usedFallback: false };
    }
  }
  return { value: FALLBACK_COLOR, usedFallback: true };
}

export function inferSafeBackgroundColor(element: Element): { value: string; usedFallback: boolean } {
  // Prefer a button-like sibling with a real background first
  for (const candidate of getBackgroundCandidates(element)) {
    const style = window.getComputedStyle(candidate);
    if (hasStyledBackground(style) && looksButtonLike(candidate)) {
      return { value: style.backgroundColor, usedFallback: false };
    }
  }
  // Fall back to any sibling with a solid background
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

export function inferSafeFontSize(element: Element): { value: string; usedFallback: boolean } {
  for (const candidate of getNearbyElements(element)) {
    const fontSize = window.getComputedStyle(candidate).fontSize;
    if (fontSize) return { value: fontSize, usedFallback: false };
  }
  return { value: FALLBACK_FONT_SIZE, usedFallback: true };
}

// Resolves which DOM element should actually receive the fix.
// For background-color/ad-label fixes, prefers a clickable ancestor or a styled surface ancestor
// over the raw evidence element, so the fix targets the visible interactive surface.
export function resolveFixTarget(
  element: Element,
  issues: IssueTag[]
): { target: Element; reason?: FixTargetResolutionReason } {
  if (
    !issues.includes("background_color") &&
    !issues.includes("add_advertisement_title") &&
    !issues.includes("enhance_advertisement_title")
  ) {
    return { target: element };
  }

  const clickable = element.closest(
    "button, a, [role='button'], input[type='button'], input[type='submit'], input[type='reset']"
  );
  if (clickable && isVisible(clickable)) {
    return { target: clickable, reason: "clickable_ancestor" };
  }

  let current: Element | null = element;
  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    if (
      hasStyledBackground(style) &&
      isVisible(current) &&
      looksLikeCompactSurface(current, element) &&
      looksButtonLike(current)
    ) {
      return { target: current, reason: "styled_surface_ancestor" };
    }
    current = current.parentElement;
  }

  return { target: element };
}
