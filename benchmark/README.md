# Dark Pattern Detection Benchmark

A controlled fixture suite for measuring how well the extension's identification
prompt finds dark patterns — and, just as importantly, how often it
**false-positives** on normal UX.

## Layout

```
benchmark/
  README.md                            ← this file (overview + scoring methodology)
  CATEGORIES.md                        ← 10-bucket site taxonomy used by sites.json
  fixtures/
    PLAN.md                            ← historical planning doc (starter batch shipped)
    amazon-product-page/
      amazon-product-page.html         ← the fixture page (served over HTTP)
      ground-truth.json                ← per-element answer key (the source of truth)
    booking-hotel-checkout/
    facebook-deactivation/
    netflix-cancel-flow/
    nytimes-article-paywall/
    paypal-account-close/
  data/tranco-*.csv                    ← top-N domain list seed
  sites.json                           ← 100 classified candidate domains
  injection-mapping-index.json         ← reference snippets from prior DP literature
  scripts/                             ← sheet sync + site-list builders
```

## Fixtures (6 starter)

After the 2026-05-15 realism audit (PR #28, issue #27) every fixture only
includes dark patterns that are canonically present on that real-world surface.
Padding to hit a fixed DP count is explicitly rejected — see "Realism-first
principle" below.

| Slug | Mimicked site | Category | Page type | DPs | CEs |
|---|---|---|---|---|---|
| amazon-product-page | amazon.com | E-commerce | product_detail | 3 | 8 |
| booking-hotel-checkout | booking.com | Travel & hospitality | hotel-checkout | 4 | 6 |
| facebook-deactivation | facebook.com | Social media | account-deactivation | 3 | 5 |
| netflix-cancel-flow | netflix.com | Streaming & entertainment | cancel-flow | 3 | 5 |
| nytimes-article-paywall | nytimes.com | News & media | article-paywall | 5 | 6 |
| paypal-account-close | paypal.com | Finance & fintech | account-close | 3 | 4 |
| **TOTAL** | 6 sites | 6 categories | 6 page-types | **21** | **34** |

For the canonical list of DP/CE entries on each fixture (gt_id, type, element,
why, selector, accepts_types) read each fixture's `ground-truth.json` directly
— that file is the source of truth. The Google Sheet (see below) mirrors it.

## Realism-first principle

Adopted during fixture #15 build, formalized in the 2026-05-15 audit:

- Only ship a DP on a fixture if a real user would actually encounter it on
  that surface. PayPal-close doesn't pop up ads. Facebook doesn't double-negate
  buttons. Amazon doesn't inject fake CTAs on its own pages.
- 8-DP coverage was a soft default for the starter batch, never a hard rule.
- Drops go into the fixture's `fixture_notes[]` with a one-line reason.
- Aggregate coverage across all 6 fixtures should still hit the canonical
  taxonomy; individual fixtures need not. Coverage gaps are intentional and
  documented per fixture.

Post-audit, two DP types have zero active coverage by design — **Disguised ad**
and **Trick wording (double negatives)**. Neither is canonical for any of the
6 starter surfaces; both live on shadier surfaces (cracked-software pages,
adversarial cookie banners). A future "shady site" fixture would cover them.

## Pop-up overlay rule

Pop-up DPs (e.g. `dp-popup-ad` on amazon, booking) must have a **functional**
close-X button. Visual degradation (low opacity, parked in a corner) IS the
dark pattern; non-functional is unrealistic. The pattern:

```html
<button class="popup-close-x" aria-label="Close"
        onclick="document.querySelector('.popup-overlay').remove()">×</button>
```

## How to run a benchmark pass

1. **Build the extension** with the prompt version you want to test (from repo root):
   ```bash
   npm run build
   ```
   Then load `dist/` as an unpacked extension at `chrome://extensions` (Developer
   mode → Load unpacked).

2. **Serve fixtures over HTTP.** The extension rejects `file://` URLs
   (`isSupportedPageUrl` only allows `http`/`https`), so from this directory:
   ```bash
   python3 -m http.server 8000
   ```
   Fixture URLs (also listed in the repo-root [README.md](../README.md)):
   - http://localhost:8000/fixtures/amazon-product-page/amazon-product-page.html
   - http://localhost:8000/fixtures/booking-hotel-checkout/booking-hotel-checkout.html
   - http://localhost:8000/fixtures/facebook-deactivation/facebook-deactivation.html
   - http://localhost:8000/fixtures/netflix-cancel-flow/netflix-cancel-flow.html
   - http://localhost:8000/fixtures/nytimes-article-paywall/nytimes-article-paywall.html
   - http://localhost:8000/fixtures/paypal-account-close/paypal-account-close.html

3. **Run the extension on each page.** Click the popup → Start. For repeatable
   results clear the storage cache first (the popup's "Clear All Saved
   Websites" button) so Layer-1/Layer-2 caching doesn't short-circuit the LLM.

4. **Capture the raw result.** DevTools Console → look for the
   `detection:request` / detection-result logs, or use the popup's "Download
   LLM input image" / debug buttons. You want the `DetectionResult` JSON:
   `page_evaluation` + `identified_dark_patterns[]`.

5. **Score against `ground-truth.json`:**
   - **True positive** — model flagged an element matching a `dark_patterns`
     `gt_id` (selector/HTML evidence overlap) with a `dark_pattern_type` in
     that entry's `accepts_types`.
   - **False negative** — a `dark_patterns` `gt_id` with no matching model entry.
   - **False positive** — model flagged an element matching a `counterexamples`
     `gt_id`, or one matching no `gt_id` at all. *This is the metric the
     recent prompt rewrite targets.*
   - **Wrong type** — right element, wrong label. Track separately.
   - **Page eval** — separately check `page_type` and that `user_primary_intent`
     is a reasonable paraphrase of the fixture's intent (per its
     `scoring_note`).

## Important caveats

- **Schema `maxItems: 3`.** The model reports at most 3 DPs per run. NYT
  (5 DPs) and booking (4 DPs) are bounded above by 3/5 and 3/4 single-pass
  recall — either run those fixtures several times and union, or just track
  *which 3 it picks and whether all 3 are real*. The other 4 fixtures have ≤3
  DPs each so single-pass recall isn't capped by the schema.
- **`<details>` and the HTML extractor.** Hidden-information patterns
  (collapsed `<details>`) are not `display:none`, so the extractor keeps them
  in the truncated HTML the LLM sees. The LLM needs to see the hidden content
  to evaluate the DP, and the innocuous specs to correctly NOT flag the
  comparable CE.
- **Pop-up modal in the screenshot.** Fixtures with a popup overlay ship with
  it open by default (semi-transparent overlay over the page). That's realistic;
  the LLM should flag the popup AND still see the rest of the page's content
  in the HTML.
- **Forced Action stress tests.** NYT (#13) ships a paywall as Forced Action;
  this is a known-contested classification per the prompt's "unrelated demand"
  carve-out (`src/shared/prompt.ts` ~391-432). Treat the model's response as a
  data point on the carve-out, not pass/fail.

## Google Sheet sync

Per-fixture summary rows and per-DP/CE detail rows live in a Google Sheet
mirroring every fixture's `ground-truth.json`. Setup details:
[scripts/SHEET-SETUP.md](./scripts/SHEET-SETUP.md).

Two relevant GitHub Actions workflows live in `.github/workflows/`:

- `sync-benchmark-to-sheet.yml` — triggers automatically on any
  `ground-truth.json` change pushed to `main`. Upserts the 2 legacy tabs.
- `build-unified-view.yml` — **manual trigger only**. Experimental: writes a
  scalable 2-tab design (flat detail + native Sheets pivot) currently in
  evaluation. If accepted, will replace the legacy sync.

**Known gotcha** (issue #29): the legacy sync is upsert-only. When DPs are
removed (e.g., during an audit), rows for the removed gt_ids persist in the
sheet as orphans until manually cleaned or the script is refactored to
delete-via-`batchUpdate`.

**Quota gotcha**: Sheets API allows 60 writes/min/user. Large sync runs can
deplete; manual retry via `gh workflow run sync-benchmark-to-sheet.yml --ref main`
after ~1min cooldown.
