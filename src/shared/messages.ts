import type { F1Result } from "./f1";
import type { FixApplicationResult, IdentifiedDarkPattern, PageContext, PageFixArchive } from "./types";

export interface MessageMeta {
  pageKey?: string;
  traceId: string;
}

export type ExtensionMessage = { meta?: MessageMeta } & (
  | { type: "PING" }
  | { type: "COLLECT_PAGE_CONTEXT" }
  | { type: "COLLECT_HTML_DEBUG" }
  | { type: "PLAN_AND_APPLY_FIXES"; patterns: IdentifiedDarkPattern[] }
  | { type: "APPLY_SAVED_FIXES"; archive: PageFixArchive }
  | { type: "SCORE_F1"; patterns: IdentifiedDarkPattern[] }
);

export interface HtmlDebugPayload {
  rawHtml: string;
  truncatedHtml: string;
  truncatedHtmlOld: string;
}

export type ExtensionMessageResponse =
  | PageContext
  | FixApplicationResult
  | HtmlDebugPayload
  | F1Result
  | { ok: true };
