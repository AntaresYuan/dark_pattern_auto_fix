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

function isInlineHidden(element: Element): boolean {
  const inlineStyle = element.getAttribute("style") ?? "";
  return /display\s*:\s*none/i.test(inlineStyle);
}

function isRemovableInvisibleElement(element: Element): boolean {
  if (element.matches("script, noscript, [hidden], .hidden, [aria-hidden='true']")) {
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
  const bodyClone = (doc.body?.cloneNode(true) as HTMLElement | null) ?? document.createElement("body");
  const removableSelectors = [
    "script",
    "noscript",
    "[style*='display:none']",
    "[style*='display: none']",
    "[hidden]",
    ".hidden",
    "[aria-hidden='true']"
  ];

  bodyClone.querySelectorAll(removableSelectors.join(",")).forEach((node) => node.remove());

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

  return bodyClone;
}

function buildOptimizedHead(doc: Document): string {
  const head = doc.head;
  if (!head) {
    return "";
  }

  const fragments: string[] = [];
  head.querySelectorAll("meta").forEach((tag) => fragments.push(tag.outerHTML));

  const title = head.querySelector("title");
  if (title) {
    fragments.push(title.outerHTML);
  }

  head.querySelectorAll("style").forEach((styleTag) => {
    fragments.push(`<style>${optimizeCss(styleTag.textContent ?? "")}</style>`);
  });

  head.querySelectorAll("link[rel='stylesheet']").forEach((tag) => fragments.push(tag.outerHTML));
  return fragments.join("");
}

export function extractTruncatedHtml(maxLength = DEFAULT_MAX_HTML_LENGTH): string {
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
