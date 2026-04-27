import { getDoctypeString } from "./truncated_new";

export function extractRawHtml(): string {
  const doctype = getDoctypeString(document);
  return `${doctype}${document.documentElement.outerHTML}`;
}
