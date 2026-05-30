// HTML extraction for LLM analysis.
// extractRawHtml()     → verbatim document HTML (debug/download)
// extractCleanedHtml() → invisible elements removed, CSS pruned to active rules, whitespace collapsed

function getDoctypeString(doc: Document): string {
  if (!doc.doctype) return "<!DOCTYPE html>";
  return `<!DOCTYPE ${doc.doctype.name}${
    doc.doctype.publicId ? ` PUBLIC "${doc.doctype.publicId}"` : ""
  }${doc.doctype.systemId ? ` "${doc.doctype.systemId}"` : ""}>`;
}

// --- CSS pruning helpers ---

function optimizeCss(cssContent: string): string {
  return cssContent
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*{\s*/g, "{")
    .replace(/\s*}\s*/g, "}")
    .replace(/\s*;\s*/g, ";")
    .replace(/\s*:\s*/g, ":")
    .replace(/\s*,\s*/g, ",")
    .trim();
}

function normalizeSelectorForCurrentState(selector: string): string {
  return selector
    .replace(/::?(before|after|first-letter|first-line)\b/gi, "")
    .replace(/:(hover|active|focus|focus-visible|focus-within|visited|link|disabled|enabled)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function selectorMatchesCurrentBody(selector: string, body: HTMLElement): boolean {
  const trimmed = selector.trim();
  if (!trimmed) return false;
  if (trimmed === ":root" || trimmed.includes(":root")) return true;
  if (trimmed === "html" || trimmed.startsWith("html ")) return true;

  const normalized = normalizeSelectorForCurrentState(trimmed);
  if (!normalized) return false;

  try {
    if (body.matches(normalized)) return true;
  } catch { /* ignore */ }

  try {
    return body.querySelector(normalized) !== null;
  } catch {
    return true; // Keep selector if it fails to parse, to avoid breaking visuals
  }
}

// Temporarily injects a <style> element to access the browser's parsed CSSRuleList,
// then keeps only rules whose selectors match the current DOM state.
function pruneCssForCurrentState(cssText: string, body: HTMLElement): string {
  const styleEl = document.createElement("style");
  styleEl.textContent = cssText;
  document.head?.appendChild(styleEl);

  try {
    const sheet = styleEl.sheet as CSSStyleSheet | null;
    if (!sheet) return cssText;

    const usedAnimationNames = new Set<string>();
    try {
      body.querySelectorAll("*").forEach((el) => {
        window.getComputedStyle(el).animationName
          .split(",")
          .map((s) => s.trim())
          .filter((n) => n && n !== "none")
          .forEach((n) => usedAnimationNames.add(n));
      });
    } catch { /* skip keyframe pruning if DOM is unavailable */ }

    const processRuleList = (rules: CSSRuleList): string[] => {
      const out: string[] = [];
      for (const rule of Array.from(rules)) {
        if (rule.type === CSSRule.STYLE_RULE) {
          const styleRule = rule as CSSStyleRule;
          const anyMatch = styleRule.selectorText
            .split(",").map((s) => s.trim())
            .some((sel) => selectorMatchesCurrentBody(sel, body));
          if (anyMatch) out.push(styleRule.cssText);
        } else if (rule.type === CSSRule.MEDIA_RULE) {
          const mediaRule = rule as CSSMediaRule;
          let matches = true;
          try { matches = window.matchMedia(mediaRule.media.mediaText).matches; } catch { /* keep */ }
          if (!matches) continue;
          const inner = processRuleList(mediaRule.cssRules);
          if (inner.length > 0) out.push(`@media ${mediaRule.media.mediaText}{${inner.join("")}}`);
        } else if (rule.type === CSSRule.SUPPORTS_RULE) {
          const supportsRule = rule as CSSSupportsRule;
          const inner = processRuleList(supportsRule.cssRules);
          if (inner.length > 0) out.push(`@supports ${supportsRule.conditionText}{${inner.join("")}}`);
        } else if (rule.type === CSSRule.KEYFRAMES_RULE) {
          const keyframesRule = rule as CSSKeyframesRule;
          if (usedAnimationNames.size === 0 || usedAnimationNames.has(keyframesRule.name)) {
            out.push(keyframesRule.cssText);
          }
        } else {
          out.push(rule.cssText); // Keep @font-face and other at-rules by default
        }
      }
      return out;
    };

    return processRuleList(sheet.cssRules).join("\n");
  } finally {
    styleEl.remove();
  }
}

// --- Body cleaning helpers ---

function isInlineHidden(element: Element): boolean {
  return /display\s*:\s*none/i.test(element.getAttribute("style") ?? "");
}

function isRemovableElement(element: Element): boolean {
  return element.matches("script, noscript, [hidden], .hidden") || isInlineHidden(element);
}

function isPreformattedText(textNode: Text): boolean {
  const parent = textNode.parentElement;
  if (!parent) return false;
  if (parent.closest("pre, code")) return true;
  try {
    if (!parent.isConnected) return false;
    const ws = window.getComputedStyle(parent).whiteSpace;
    return ws === "pre" || ws === "pre-wrap";
  } catch {
    return false;
  }
}

// Returns a deep clone of <body> with scripts, hidden elements, comments, and
// navigation/event attributes stripped, and non-preformatted whitespace collapsed.
function cloneAndCleanBody(doc: Document): HTMLElement {
  const clone = (doc.body?.cloneNode(true) as HTMLElement | null) ?? document.createElement("body");

  clone.querySelectorAll(
    "script, noscript, input[type='hidden'], [style*='display:none'], [style*='display: none'], [hidden], .hidden"
  ).forEach((node) => node.remove());

  // Second pass: catch remaining invisible elements missed by the selector
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT);
  const toRemove: Element[] = [];
  for (let el = walker.nextNode() as Element | null; el; el = walker.nextNode() as Element | null) {
    if (isRemovableElement(el)) toRemove.push(el);
  }
  toRemove.forEach((el) => el.remove());

  // Collapse inline whitespace in non-preformatted text nodes
  const textWalker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  for (let n = textWalker.nextNode() as Text | null; n; n = textWalker.nextNode() as Text | null) {
    textNodes.push(n);
  }
  for (const node of textNodes) {
    if (!isPreformattedText(node)) {
      node.textContent = node.textContent?.replace(/\s+/g, " ") ?? "";
    }
  }

  // Remove HTML comments
  const commentWalker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
  const comments: Comment[] = [];
  for (let n = commentWalker.nextNode() as Comment | null; n; n = commentWalker.nextNode() as Comment | null) {
    comments.push(n);
  }
  comments.forEach((n) => n.remove());

  // Strip navigation hrefs and inline event handlers to prevent unintended interactions
  const attrWalker = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT);
  for (let el = attrWalker.nextNode() as Element | null; el; el = attrWalker.nextNode() as Element | null) {
    const tag = el.tagName.toLowerCase();
    if (tag === "a" || tag === "area") {
      el.removeAttribute("href"); el.removeAttribute("target");
      el.removeAttribute("rel"); el.removeAttribute("ping");
    } else if (tag === "form") {
      el.removeAttribute("action"); el.removeAttribute("target");
    } else if (tag === "button" || tag === "input") {
      el.removeAttribute("formaction"); el.removeAttribute("formtarget");
    } else if (tag === "img") {
      el.removeAttribute("src"); el.removeAttribute("srcset"); el.removeAttribute("sizes");
    }
    for (const name of el.getAttributeNames()) {
      // Drop event handlers, and benchmark answer-key anchors (data-gt-id / data-gt-*):
      // those attributes name the ground-truth dark pattern, so leaking them to the LLM
      // would invalidate any F1 measurement. They never appear on real sites, so stripping
      // them is a no-op in production. The live DOM keeps them for the F1 scorer.
      if (name.startsWith("on") || name === "data-gt-id" || name.startsWith("data-gt-")) {
        el.removeAttribute(name);
      }
    }
  }

  return clone;
}

// Builds <head> content: external stylesheet links + pruned/minified inline <style> blocks.
function buildOptimizedHead(doc: Document): string {
  const head = doc.head;
  if (!head) return "";

  const fragments: string[] = [];
  head.querySelectorAll("link[rel='stylesheet'][href]").forEach((link) => {
    fragments.push(link.outerHTML);
  });
  head.querySelectorAll("style").forEach((style) => {
    const raw = style.textContent ?? "";
    const pruned = pruneCssForCurrentState(raw, document.body ?? document.createElement("body"));
    fragments.push(`<style>${optimizeCss(pruned)}</style>`);
  });
  return fragments.join("");
}

// --- Public exports ---

export function extractRawHtml(): string {
  const doctype = getDoctypeString(document);
  return `${doctype}${document.documentElement.outerHTML}`;
}

export function extractCleanedHtml(): string {
  const doctype = getDoctypeString(document);
  const body = cloneAndCleanBody(document);
  const head = buildOptimizedHead(document);
  return `${doctype}\n<html>\n<head>${head}</head>\n<body>${body.innerHTML}</body>\n</html>`;
}
