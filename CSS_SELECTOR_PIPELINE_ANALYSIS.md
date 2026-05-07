# CSS Selector & Dark Pattern Detection Pipeline Analysis

## Pipeline Overview

```
Page visit
  → content/index.ts: collectPageContext()
      → truncated_new.ts: extractTruncatedHtml()   ← HTML sent to LLM

  → popup/main.ts: runDetection()
      → shared/prompt.ts: buildDarkPatternPrompt()
      → providers/gemini.ts or openai.ts: LLM call

  → LLM returns: IdentifiedDarkPattern[]
      fields: css_selector, html_evidence, selector_stability, issues

  → content/index.ts: PLAN_AND_APPLY_FIXES message
      → fixPlanner.ts: createFixesForPattern()
          1. tryQuerySelector(pattern.css_selector)    ← First attempt
          2. findByHtmlEvidence(pattern.html_evidence) ← Fallback
          3. buildStableSelector(matchedElement)        ← Replaces LLM selector
      → PageFix[] with NEW selector stored in cache

  → patchInjector.ts: applyFixesToPage()
      → CSS fix:   injects <style> with "selector { rule !important; }"
      → Label fix: document.querySelector(fix.css_selector) → insertBefore()
```

---

## The Two-Selector Problem

There are **two distinct selectors** in the pipeline serving different purposes. They are not the same object, and the distinction is critical.

### 1. LLM-generated `css_selector` — for locating

- Source: `IdentifiedDarkPattern.css_selector` (providers/openai.ts:67, providers/gemini.ts:73)
- The LLM derives this from `html_evidence` — it finds a verbatim HTML tag in the truncated HTML and constructs a selector from its `id`, `data-*`, or class attributes
- Used **once**, transiently, in `fixPlanner.ts:611` → `tryQuerySelector()` to find the live DOM element
- Prompt rules 8–12 constrain it to `#id`, `[data-*]`, or class-based selectors only

**Problem:** The truncated HTML the LLM receives may not perfectly mirror the live DOM. Scripts can add/remove classes after page load, or the truncation algorithm may clip attributes mid-tag. The LLM selector can be correct per the HTML it saw, but match nothing in the live DOM.

### 2. `buildStableSelector()` output — for storage and injection

- Source: `fixPlanner.ts:212–244`
- Generated from the **actual live DOM element** once it's found
- Stored in `PageFix.css_selector` and written to both Tier-1 and Tier-2 caches
- Used later for CSS injection (`serializeFix`) and label injection (`document.querySelector`)
- Logic: uses `#id` if available; otherwise builds `tag.class:nth-of-type(n) > ...` up to 5 ancestor levels

**Problem:** `nth-of-type(n)` indices are position-dependent. They are valid for the exact page at detection time but break silently when:
- The cached fix is replayed on a similar-template page (Tier-2 reuse)
- The DOM mutates after detection (SPA re-renders, lazy loading)
- A different user session has different dynamic content ordering

---

## Stage-by-Stage Failure Modes

| Stage | File | Lines | What can fail | Why |
|---|---|---|---|---|
| HTML extraction | content/truncated_new.ts | 1–80 | Truncation omits key attributes | Budget cuts or CSS pruning drops the element's tag |
| LLM selector generation | shared/prompt.ts | 131–145 | Selector references non-existent class | LLM hallucinates or paraphrases instead of verbatim-copying |
| `tryQuerySelector` | content/fixPlanner.ts | 40–95 | Selector finds nothing | Dynamic classes, scoped attributes, or jQuery-style pseudo-selectors |
| `findByHtmlEvidence` fallback | content/fixPlanner.ts | 101–189 | Finds wrong element | Text content match picks the shortest-textContent ancestor, which may be too broad |
| `buildStableSelector` | content/fixPlanner.ts | 212–244 | Generates fragile nth-of-type path | No `id`, no stable class → position-based, breaks on re-renders |
| CSS injection | content/patchInjector.ts | 20–31 | Rule silently doesn't apply | Page styles may win specificity even against `!important` |
| Label injection re-lookup | content/patchInjector.ts | 63 | `querySelector` returns null | DOM changed between plan and inject; cached selector no longer valid |
| Tier-2 cache reuse | shared/patternStorage.ts | 205–224 | Stored selector mismatches new page | nth-of-type built for original page structure, different on similar-template pages |

---

## Key Code Locations

| Component | File | Lines | Key Function |
|---|---|---|---|
| LLM detection orchestration | popup/main.ts | 399–437 | `runDetection()` |
| Page context collection | content/index.ts | 12–25 | `collectPageContext()` |
| HTML truncation | content/truncated_new.ts | — | `extractTruncatedHtml()` |
| Message dispatch | content/index.ts | 44–111 | `onMessage` handler |
| Fix planning entry point | content/fixPlanner.ts | 795–821 | `planAndApplyFixes()` |
| Per-pattern fix creation | content/fixPlanner.ts | 599–789 | `createFixesForPattern()` |
| LLM selector resolution | content/fixPlanner.ts | 40–95 | `tryQuerySelector()` |
| HTML evidence fallback | content/fixPlanner.ts | 101–189 | `findByHtmlEvidence()` |
| Stable selector generation | content/fixPlanner.ts | 212–244 | `buildStableSelector()` |
| CSS injection | content/patchInjector.ts | 20–31 | `serializeFix()` |
| Label injection | content/patchInjector.ts | 59–103 | `applyAdvertisementLabelFix()` |
| Fix application | content/patchInjector.ts | 105–172 | `applyFixesToPage()` |
| Pattern storage | shared/patternStorage.ts | 205–224 | `upsertPatternArchive()` |
| Prompt construction | shared/prompt.ts | 3–200 | `buildDarkPatternPrompt()` |
| Type definitions | shared/types.ts | — | `IdentifiedDarkPattern`, `PageFix`, `PatternArchive` |

---

## Data Structures

```
IdentifiedDarkPattern  (LLM output)
├── dark_pattern_type: DarkPatternType
├── html_evidence: string          ← verbatim opening tag copied from truncated HTML
├── css_selector: string           ← derived from html_evidence
├── issues: IssueTag[]
└── selector_stability: "stable" | "dynamic"   ← tracked but NEVER checked downstream

        ↓ resolved via fixPlanner.createFixesForPattern()

PageFix  (stored in both caches)
├── css_selector: string           ← REPLACED by buildStableSelector() output
├── patch_type: "css" | "advertisement_label"
├── css_rules / label_text
└── source_dark_pattern_type

        ↓ Tier-1 cache: chrome.storage key "page_fix::${pageKey}"

PageFixArchive
├── page_key: string               ← hostname + pathname
└── fixes: PageFix[]

        ↓ Tier-2 cache: chrome.storage key "pattern_fix::${urlShape}::${timestamp}"

PatternArchive
├── id: string
├── urlShape: string               ← e.g. "amazon.com/dp/{id}"
├── htmlSignature: HtmlSignature   ← structural fingerprint for matching
├── llmMatchFeatures?: TemplateMatchFeatures
└── fixes: PageFix[]               ← contains runtime nth-of-type selectors
```

---

## Known Bugs

### Bug 1: OpenAI provider sends no screenshot (providers/openai.ts:41–60)

The prompt explicitly tells the LLM "You are given a JPEG screenshot and truncated HTML", but the OpenAI provider sends only text. Gemini includes the screenshot correctly via `inlineData`. OpenAI detections rely solely on HTML, reducing detection accuracy.

### Bug 2: `selector_stability` is collected but never used

`IdentifiedDarkPattern.selector_stability` is populated by the LLM ("stable" or "dynamic") and stored in `shared/types.ts:27`, but no code in `fixPlanner.ts`, `patternStorage.ts`, or `patchInjector.ts` reads it. Dynamic selectors are cached and replayed identically to stable ones.

### Bug 3: `nth-of-type` selectors break on Tier-2 reuse

`buildStableSelector()` falls back to position-based paths when no `id` or stable class exists. These paths are valid only for the exact page instance at detection time. When the Tier-2 cache applies them to a structurally similar but not identical page, `querySelector` silently returns null and no fix is applied.

### Bug 4: Label injection re-lookup can fail after DOM mutation

`applyAdvertisementLabelFix()` at `patchInjector.ts:63` calls `document.querySelector(fix.css_selector)` at injection time. If the DOM has mutated since `planAndApplyFixes()` ran (e.g., SPA navigation, lazy-loaded widgets), the selector matches nothing and the label is silently dropped.

### Bug 5: `llmMatchFeatures` describe the wrong structure

`patternStorage.ts:205–224` extracts `llmMatchFeatures` from the LLM response (describing the original page's HTML structure), but the `fixes[]` stored alongside them contain selectors generated by `buildStableSelector()` (describing the live DOM at detection time). These two structural descriptions are not aligned, so the Tier-2 feature-based matching scores optimize for the wrong reference.

---

## Most Likely Root Cause of Current Failure

**Detection stage** (nothing found): LLM selector doesn't match live DOM → `tryQuerySelector` returns null → `findByHtmlEvidence` either finds nothing or picks the wrong ancestor → `fix.pattern.skip` logged with `outcome: "selector_not_found"`.

**Injection stage** (fix planned but not visible): CSS `<style>` block injected correctly but selector specificity is insufficient, or for label fixes the re-`querySelector` at inject time returns null → `patch.apply.label` logged with `outcome: "target_missing"`.

Check the extension's background/content logs for these two event names to pinpoint which stage is failing on a given page.

---

## Potential Fixes

1. **Pin elements with a `data-dpf-id` attribute at detection time** — when `findByHtmlEvidence` or `tryQuerySelector` succeeds, immediately stamp the live element with `element.setAttribute('data-dpf-id', uid)`. Store `[data-dpf-id="uid"]` as the selector. This survives class changes and position shifts; the only failure mode is element removal from the DOM.

2. **Honor `selector_stability`** — skip Tier-2 caching for patterns the LLM marked as "dynamic". Avoids replaying selectors the LLM already knows won't survive across page instances.

3. **Fix OpenAI provider to include the screenshot** — mirror the Gemini provider's `inlineData` approach so both providers have the same visual input.

4. **Replace nth-of-type fallback in `buildStableSelector`** — prefer `data-*` attributes, `aria-label`, `name`, or `role` before falling back to positional paths.

5. **Defer label injection to a MutationObserver** — instead of a one-shot `querySelector` at inject time, watch for the target element to appear and inject the label when it does. Handles lazy-loaded and SPA-updated content.
