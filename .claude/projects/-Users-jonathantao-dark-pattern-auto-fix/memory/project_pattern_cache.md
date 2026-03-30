---
name: two-layer pattern cache
description: Pattern-level cache layer added on top of exact page-key cache in dark_pattern_auto_fix
type: project
---

Two-layer caching was implemented on the `sixing_dev` branch.

**Layer 1 (existing, unchanged):** Exact `hostname+pathname` → `page_fix::${pageKey}` in chrome.storage.local.

**Layer 2 (new):** URL-shape + HTML-signature similarity → `pattern_fix::${id}` archives.

Key files added:
- `src/shared/patternMatcher.ts` — `deriveUrlShape`, `extractHtmlSignature`, `scoreSignatureSimilarity`, threshold = 0.6
- `src/shared/patternStorage.ts` — `findBestPatternMatch`, `upsertPatternArchive`

Key files modified:
- `src/shared/types.ts` — added `HtmlSignature`, `PatternArchive`, `PatternMatchResult`
- `src/popup/main.ts` — two-layer lookup in `bootstrap()`, context caching in `cachedPageContext`, pattern upsert (fire-and-forget) after detection

**Why:** Similarity threshold 0.6 = 40% × tagJaccard + 60% × classJaccard. Class tokens are the primary signal because they encode CSS component identity (template-invariant), while tag frequencies capture DOM shape.

**Prompt.ts is frozen** — do not edit for this phase.
