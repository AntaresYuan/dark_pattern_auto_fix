import { startStep } from "../shared/logger";

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

function cloneAndCleanVisibleBody(doc: Document): {
  body: HTMLElement;
  removedNodeCount: number;
  normalizedTextNodeCount: number;
} {
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

  let removedNodeCount = 0;
  bodyClone.querySelectorAll(removableSelectors.join(",")).forEach((node) => {
    node.remove();
    removedNodeCount += 1;
  });

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
  removedNodeCount += extraRemovals.length;

  const textWalker = document.createTreeWalker(bodyClone, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];

  let textNode = textWalker.nextNode() as Text | null;
  while (textNode) {
    textNodes.push(textNode);
    textNode = textWalker.nextNode() as Text | null;
  }

  let normalizedTextNodeCount = 0;
  textNodes.forEach((node) => {
    if (!isPreformattedTextNode(node)) {
      const before = node.textContent ?? "";
      const after = before.replace(/\s+/g, " ");
      if (after !== before) {
        normalizedTextNodeCount += 1;
      }
      node.textContent = after;
    }
  });

  return {
    body: bodyClone,
    removedNodeCount,
    normalizedTextNodeCount
  };
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

export function extractTruncatedHtml(input: {
  maxLength?: number;
  pageKey?: string;
  traceId?: string;
} = {}): string {
  const maxLength = input.maxLength ?? DEFAULT_MAX_HTML_LENGTH;
  const step = startStep("content", "html.extract", {
    maxLength,
    hasDocumentElement: Boolean(document.documentElement),
    hasBody: Boolean(document.body),
    hasHead: Boolean(document.head),
    pageKey: input.pageKey,
    traceId: input.traceId
  });

  const doctype = getDoctypeString(document);
  const fullHtml = `${doctype}${document.documentElement.outerHTML}`;
  const cleanup = cloneAndCleanVisibleBody(document);
  const headContent = buildOptimizedHead(document);

  const finalHtml = `${doctype}
<html>
<head>${headContent}</head>
<body>${cleanup.body.innerHTML}</body>
</html>`;
  const compressedHtml = finalHtml.replace(/\s+/g, " ").trim();

  if (finalHtml.length <= maxLength) {
    step.finish({
      mode: "final_html",
      fullHtmlLength: fullHtml.length,
      finalHtmlLength: finalHtml.length,
      compressedHtmlLength: compressedHtml.length,
      pageKey: input.pageKey,
      removedNodeCount: cleanup.removedNodeCount,
      traceId: input.traceId,
      normalizedTextNodeCount: cleanup.normalizedTextNodeCount
    });
    return finalHtml;
  }

  if (compressedHtml.length <= maxLength) {
    step.finish({
      mode: "compressed_html",
      fullHtmlLength: fullHtml.length,
      finalHtmlLength: finalHtml.length,
      compressedHtmlLength: compressedHtml.length,
      pageKey: input.pageKey,
      removedNodeCount: cleanup.removedNodeCount,
      traceId: input.traceId,
      normalizedTextNodeCount: cleanup.normalizedTextNodeCount
    });
    return compressedHtml;
  }

  const truncatedHtml = compressedHtml.slice(0, maxLength);
  step.finish({
    mode: "full_html_fallback",
    fullHtmlLength: fullHtml.length,
    finalHtmlLength: finalHtml.length,
    compressedHtmlLength: compressedHtml.length,
    truncatedLength: truncatedHtml.length,
    pageKey: input.pageKey,
    removedNodeCount: cleanup.removedNodeCount,
    traceId: input.traceId,
    normalizedTextNodeCount: cleanup.normalizedTextNodeCount
  }, "warn");
  return truncatedHtml;
}
