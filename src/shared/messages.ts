import type { FixApplicationResult, IdentifiedDarkPattern, PageContext, PageFixArchive } from "./types";

export type ExtensionMessage =
  | { type: "PING" }
  | { type: "COLLECT_PAGE_CONTEXT" }
  | { type: "COLLECT_HTML_DEBUG" }
  | { type: "PLAN_AND_APPLY_FIXES"; patterns: IdentifiedDarkPattern[] }
  | { type: "APPLY_SAVED_FIXES"; archive: PageFixArchive };

export interface HtmlDebugPayload {
  rawHtml: string;
  truncatedHtml: string;
  truncatedHtmlOld: string;
}

export type ExtensionMessageResponse = PageContext | FixApplicationResult | HtmlDebugPayload | { ok: true };
