const DEFAULT_MAX_HTML_LENGTH = 100000;

function getDoctypeString(doc: Document): string {
  if (!doc.doctype) {
    return "<!DOCTYPE html>";
  }

  return `<!DOCTYPE ${doc.doctype.name}${
    doc.doctype.publicId ? ` PUBLIC "${doc.doctype.publicId}"` : ""
  }${doc.doctype.systemId ? ` "${doc.doctype.systemId}"` : ""}>`;
}

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

function normalizeSelectorForCurrentStateMatching(selector: string): string {
  // DevTools Coverage is ideal, but we approximate by checking selector matches
  // in the current DOM/state. For dynamic pseudos, match base element.
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

  const normalized = normalizeSelectorForCurrentStateMatching(trimmed);
  if (!normalized) return false;

  try {
    if (body.matches(normalized)) return true;
  } catch {
    // Ignore selector parsing errors for matches(); fall back to querySelector.
  }

  try {
    return body.querySelector(normalized) !== null;
  } catch {
    // If selector parsing fails, keep it to avoid breaking visuals.
    return true;
  }
}

function pruneCssForCurrentState(cssText: string, body: HTMLElement): string {
  const styleEl = document.createElement("style");
  styleEl.textContent = cssText;
  document.head?.appendChild(styleEl);

  try {
    const sheet = styleEl.sheet as CSSStyleSheet | null;
    if (!sheet) return cssText;

    const usedAnimationNames = new Set<string>();
    try {
      const allElements = body.querySelectorAll("*");
      allElements.forEach((el) => {
        const cs = window.getComputedStyle(el);
        const names = cs.animationName.split(",").map((s) => s.trim());
        names.forEach((n) => {
          if (n && n !== "none") usedAnimationNames.add(n);
        });
      });
    } catch {
      // If computedStyle fails (detached DOM or cross-origin), skip keyframes pruning.
    }

    const keptRules: string[] = [];

    const keepRule = (rule: CSSRule): void => {
      keptRules.push(rule.cssText);
    };

    const processRuleList = (rules: CSSRuleList): string[] => {
      const out: string[] = [];
      for (const rule of Array.from(rules)) {
        // STYLE_RULE (1)
        if (rule.type === CSSRule.STYLE_RULE) {
          const styleRule = rule as CSSStyleRule;
          const selectors = styleRule.selectorText
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          const anyMatch = selectors.some((sel) =>
            selectorMatchesCurrentBody(sel, body),
          );
          if (anyMatch) out.push(styleRule.cssText);
          continue;
        }

        // MEDIA_RULE (4)
        if (rule.type === CSSRule.MEDIA_RULE) {
          const mediaRule = rule as CSSMediaRule;
          const mediaText = mediaRule.media.mediaText;
          let mediaMatches = true;
          try {
            mediaMatches = window.matchMedia(mediaText).matches;
          } catch {
            mediaMatches = true;
          }

          if (!mediaMatches) continue;
          const inner = processRuleList(mediaRule.cssRules);
          if (inner.length > 0) {
            out.push(`@media ${mediaText}{${inner.join("")}}`);
          }
          continue;
        }

        // SUPPORTS_RULE (12)
        if (rule.type === CSSRule.SUPPORTS_RULE) {
          const supportsRule = rule as CSSSupportsRule;
          const inner = processRuleList(supportsRule.cssRules);
          if (inner.length > 0) {
            out.push(`@supports ${supportsRule.conditionText}{${inner.join("")}}`);
          }
          continue;
        }

        // KEYFRAMES_RULE (7)
        if (rule.type === CSSRule.KEYFRAMES_RULE) {
          const keyframesRule = rule as CSSKeyframesRule;
          if (usedAnimationNames.size === 0 || usedAnimationNames.has(keyframesRule.name)) {
            out.push(keyframesRule.cssText);
          }
          continue;
        }

        // Keep everything else by default (e.g., @font-face) to avoid surprises.
        out.push(rule.cssText);
      }
      return out;
    };

    keptRules.push(...processRuleList(sheet.cssRules));
    return keptRules.join("\n");
  } finally {
    styleEl.remove();
  }
}

function isInlineHidden(element: Element): boolean {
  const inlineStyle = element.getAttribute("style") ?? "";
  return /display\s*:\s*none/i.test(inlineStyle);
}

function isRemovableInvisibleElement(element: Element): boolean {
  if (element.matches("script, noscript, [hidden], .hidden")) {
    return true;
  }

  return isInlineHidden(element);
}

function isPreformattedTextNode(textNode: Text): boolean {
  const parent = textNode.parentElement;
  if (!parent) {
    return false;
  }

  if (parent.closest("pre, code")) {
    return true;
  }

  try {
    if (!parent.isConnected) {
      return false;
    }

    const whiteSpace = window.getComputedStyle(parent).whiteSpace;
    return whiteSpace === "pre" || whiteSpace === "pre-wrap";
  } catch {
    return false;
  }
}

function cloneAndCleanVisibleBody(doc: Document): HTMLElement {
  const bodyClone =
    (doc.body?.cloneNode(true) as HTMLElement | null) ??
    document.createElement("body");
  const removableSelectors = [
    "script",
    "noscript",
    "input[type='hidden']",
    "[style*='display:none']",
    "[style*='display: none']",
    "[hidden]",
    ".hidden",
  ];

  bodyClone
    .querySelectorAll(removableSelectors.join(","))
    .forEach((node) => node.remove());

  const walker = document.createTreeWalker(bodyClone, NodeFilter.SHOW_ELEMENT);
  const extraRemovals: Element[] = [];

  let currentElement = walker.nextNode() as Element | null;
  while (currentElement) {
    if (isRemovableInvisibleElement(currentElement)) {
      extraRemovals.push(currentElement);
    }
    currentElement = walker.nextNode() as Element | null;
  }

  extraRemovals.forEach((node) => node.remove());

  const textWalker = document.createTreeWalker(bodyClone, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];

  let textNode = textWalker.nextNode() as Text | null;
  while (textNode) {
    textNodes.push(textNode);
    textNode = textWalker.nextNode() as Text | null;
  }

  textNodes.forEach((node) => {
    if (!isPreformattedTextNode(node)) {
      node.textContent = node.textContent?.replace(/\s+/g, " ") ?? "";
    }
  });

  const commentWalker = document.createTreeWalker(bodyClone, NodeFilter.SHOW_COMMENT);
  const commentNodes: Comment[] = [];
  let commentNode = commentWalker.nextNode() as Comment | null;
  while (commentNode) {
    commentNodes.push(commentNode);
    commentNode = commentWalker.nextNode() as Comment | null;
  }
  commentNodes.forEach((node) => node.remove());

  const attrWalker = document.createTreeWalker(bodyClone, NodeFilter.SHOW_ELEMENT);
  let attrElement = attrWalker.nextNode() as Element | null;
  while (attrElement) {
    const tagName = attrElement.tagName.toLowerCase();
    if (tagName === "a" || tagName === "area") {
      // Prevent navigation in exported static HTML.
      attrElement.removeAttribute("href");
      attrElement.removeAttribute("target");
      attrElement.removeAttribute("rel");
      attrElement.removeAttribute("ping");
    } else if (tagName === "form") {
      attrElement.removeAttribute("action");
      attrElement.removeAttribute("target");
    } else if (tagName === "button" || tagName === "input") {
      attrElement.removeAttribute("formaction");
      attrElement.removeAttribute("formtarget");
    } else if (tagName === "img") {
      attrElement.removeAttribute("src");
      attrElement.removeAttribute("srcset");
      attrElement.removeAttribute("sizes");
    }

    const attributeNames = attrElement.getAttributeNames();
    for (const name of attributeNames) {
      if (name.startsWith("data-")) {
        attrElement.removeAttribute(name);
        continue;
      }

      if (name.startsWith("on")) {
        attrElement.removeAttribute(name);
      }
    }
    attrElement = attrWalker.nextNode() as Element | null;
  }

  return bodyClone;
}

function buildOptimizedHead(doc: Document): string {
  const head = doc.head;
  if (!head) {
    return "";
  }

  const fragments: string[] = [];
  head.querySelectorAll("link[rel='stylesheet'][href]").forEach((linkTag) => {
    fragments.push(linkTag.outerHTML);
  });
  head.querySelectorAll("style").forEach((styleTag) => {
    const raw = styleTag.textContent ?? "";
    const pruned = pruneCssForCurrentState(raw, document.body ?? document.createElement("body"));
    fragments.push(`<style>${optimizeCss(pruned)}</style>`);
  });
  return fragments.join("");
}

export function extractTruncatedHtml(
  maxLength = DEFAULT_MAX_HTML_LENGTH,
): string {
  const doctype = getDoctypeString(document);
  const fullHtml = `${doctype}${document.documentElement.outerHTML}`;
  const body = cloneAndCleanVisibleBody(document);
  const headContent = buildOptimizedHead(document);

  const finalHtml = `${doctype}
<html>
<head>${headContent}</head>
<body>${body.innerHTML}</body>
</html>`;

  if (finalHtml.length <= maxLength) {
    return finalHtml;
  }

  const compressedHtml = finalHtml.replace(/\s+/g, " ").trim();
  if (compressedHtml.length <= maxLength) {
    return compressedHtml;
  }

  return fullHtml.length < finalHtml.length ? fullHtml : finalHtml;
}

export { getDoctypeString };
