import { getDoctypeString } from "./truncated";

export function extractRawHtml(): string {
  const doctype = getDoctypeString(document);
  return `${doctype}${document.documentElement.outerHTML}`;
}
