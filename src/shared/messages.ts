import type { FixApplicationResult, IdentifiedDarkPattern, PageContext, PageFixArchive } from "./types";

export type ExtensionMessage =
  | { type: "PING" }
  | { type: "COLLECT_PAGE_CONTEXT" }
  | { type: "PLAN_AND_APPLY_FIXES"; patterns: IdentifiedDarkPattern[] }
  | { type: "APPLY_SAVED_FIXES"; archive: PageFixArchive };

export type ExtensionMessageResponse = PageContext | FixApplicationResult | { ok: true };
