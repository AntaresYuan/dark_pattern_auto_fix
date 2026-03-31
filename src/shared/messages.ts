import type { FixApplicationResult, IdentifiedDarkPattern, PageContext, PageFixArchive } from "./types";

export interface MessageMeta {
  pageKey?: string;
  traceId: string;
}

export type ExtensionMessage =
  | { type: "PING"; meta?: MessageMeta }
  | { type: "COLLECT_PAGE_CONTEXT"; meta?: MessageMeta }
  | { type: "PLAN_AND_APPLY_FIXES"; patterns: IdentifiedDarkPattern[]; meta?: MessageMeta }
  | { type: "APPLY_SAVED_FIXES"; archive: PageFixArchive; meta?: MessageMeta };

export type ExtensionMessageResponse = PageContext | FixApplicationResult | { ok: true };
