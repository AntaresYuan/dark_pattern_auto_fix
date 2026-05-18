import { logEvent, truncateText } from "../shared/logger";

// Returns true for dynamically-generated class names that aren't stable across page loads.
function looksLikeDynamicClass(name: string): boolean {
  if (name.length < 2 || name.length > 60) return true;
  if (/^[_a-z]{0,2}[0-9a-f]{4,}$/i.test(name)) return true; // CSS-in-JS hashes: _3Bx2a, s1k9p4m
  if (/^(css|sc|jss|emotion|hash|tw)-/i.test(name)) return true; // CSS-in-JS runtime prefixes
  if (/^[0-9]+$/.test(name)) return true;
  return false;
}

function escapeAttrValue(val: string): string {
  return val.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Derives a querySelector selector from a verbatim HTML opening tag.
 * Priority: #id → stable class names + other attrs → tag+attrs.
 * Returns null when no stable anchor is found, causing the pattern to be skipped.
 */
export function deriveSelector(evidence: string): string | null {
  if (!evidence) return null;

  const tagMatch = evidence.match(/^<([a-z][a-z0-9-]*)/i);
  const tag = tagMatch ? tagMatch[1].toLowerCase() : "";

  // id is always globally unique
  const idMatch = evidence.match(/\bid="([^"]+)"/);
  if (idMatch) return `#${CSS.escape(idMatch[1])}`;

  const classMatch = evidence.match(/\bclass="([^"]+)"/);
  const classStr = classMatch
    ? classMatch[1].trim().split(/\s+/)
        .filter((c) => !looksLikeDynamicClass(c))
        .map((c) => `.${CSS.escape(c)}`)
        .join("")
    : "";

  // Every other attribute except id/class/style and Vue scoped data-v-* attrs
  const attrStr = Array.from(evidence.matchAll(/\b([\w-]+)="([^"]*)"/g))
    .filter(([, name]) =>
      name !== "id" && name !== "class" && name !== "style" &&
      !/^data-v-[a-f0-9]+$/i.test(name)
    )
    .map(([, attr, val]) => `[${attr}="${escapeAttrValue(val)}"]`)
    .join("");

  if (!classStr && !attrStr) return null;
  return `${tag}${classStr}${attrStr}`;
}

function parseEvidenceAttributes(evidence: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const [, name, val] of evidence.matchAll(/\b([\w-]+)="([^"]*)"/g)) {
    attrs.set(name, val);
  }
  return attrs;
}

function scoreElementAgainstEvidence(element: Element, evidenceAttrs: Map<string, string>): number {
  let score = 0;
  for (const [name, val] of evidenceAttrs) {
    const actual = element.getAttribute(name);
    if (actual === null) continue;
    if (actual === val) {
      score += 1;
    } else if (name === "class") {
      const evidenceTokens = new Set(val.split(/\s+/).filter(Boolean));
      const overlap = actual.split(/\s+/).filter((t) => evidenceTokens.has(t)).length;
      score += overlap * 0.5;
    }
  }
  return score;
}

// When a selector matches multiple elements, return the one that best matches the evidence attributes.
export function pickBestMatch(
  candidates: NodeListOf<Element>,
  evidence: string,
  traceId: string,
  derivedSelector: string
): Element {
  if (candidates.length === 1) return candidates[0];

  const evidenceAttrs = parseEvidenceAttributes(evidence);
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

// Builds a stable CSS selector using id, up to 2 stable class tokens, or nth-of-type fallback.
export function buildStableSelector(element: Element): string {
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

    const siblings = Array.from(parent.children).filter((child) => child.tagName === current!.tagName);
    const index = siblings.indexOf(current) + 1;
    segments.unshift(`${tag}${classToken}:nth-of-type(${Math.max(index, 1)})`);
    current = parent;
  }

  return segments.join(" > ");
}
