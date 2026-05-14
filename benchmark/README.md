# Dark Pattern Detection Benchmark

A controlled test fixture for measuring how well the extension's identification
prompt finds dark patterns — and, just as importantly, how often it **false-positives**
on normal UX.

## Layout

```
benchmark/
  README.md                            ← this file (overview + scoring methodology)
  fixtures/
    amazon-product-page/
      amazon-product-page.html         ← the fixture page
      ground-truth.json                ← per-element answer key
    <future-fixture>/
      ...
```

Each fixture lives in its own directory under `fixtures/`. Today there's one (`amazon-product-page`); more will be added.

## What's here

| Path | What it is |
|---|---|
| `fixtures/amazon-product-page/amazon-product-page.html` | A self-contained replica of an Amazon product detail page (Logitech MX Master 3S mouse). Renders offline; no external resources. |
| `fixtures/amazon-product-page/ground-truth.json` | The answer key: every benchmarked element, whether it's a dark pattern (and which type) or a counterexample, and why. |

The HTML has **8 injected dark patterns** (one per type, except Forced Action which doesn't fit a product page naturally) and **8 counterexamples** — elements that visually resemble dark patterns but are legitimate UX. Every benchmarked element carries a `data-gt-id` attribute and an HTML comment (`[DP-x]` = dark pattern, `[CE-x]` = counterexample).

### The 8 dark patterns

| `gt_id` | Type | What it is |
|---|---|---|
| `dp-popup-ad` | Pop-up ad | Air-fryer promo modal with a near-invisible close `×` |
| `dp-hidden-fees` | Hidden information | Mandatory $21.49 in fees collapsed inside a `<details>` near the price |
| `dp-fake-social-proof` | Fake social proof | "17 viewing now / Only 2 left / Bought 340+ times" badges, no source |
| `dp-preselect-marketing` | Preselection | Pre-checked "email me about deals" checkbox in the buy box |
| `dp-disguised-ad-cta` | Disguised ad | Fake "ADD TO CART" button styled like Amazon's, links to an affiliate |
| `dp-false-hierarchy-protection` | False hierarchy | Big "Add 3-Year Protection $19.99" pill vs tiny gray "no thanks" |
| `dp-trick-wording-notif` | Trick wording | Double-negative notification buttons ("I do not want no notifications") |
| `dp-confirm-shaming-prime` | Confirm shaming | "No thanks, I'd rather pay full price and wait longer" decline link |

### The 8 counterexamples (model should NOT flag these)

`ce-signin-link`, `ce-rating-aggregate`, `ce-shipping-default`, `ce-product-details-accordion`, `ce-real-add-to-cart`, `ce-real-buy-now`, `ce-save-for-later`, `ce-sponsored-carousel` — see `ground-truth.json` for what each one is and why it's legitimate.

## How to run

1. **Build the extension with the prompt version you want to test** (from repo root):
   ```bash
   npm run build
   ```
   Then load `dist/` as an unpacked extension at `chrome://extensions` (Developer mode → Load unpacked).

2. **Serve fixtures over HTTP.** The extension rejects `file://` URLs (`isSupportedPageUrl` only allows `http`/`https`), so open a terminal in this `benchmark/` directory and run:
   ```bash
   python3 -m http.server 8000
   ```
   Then visit `http://localhost:8000/fixtures/amazon-product-page/amazon-product-page.html` in Chrome. (One server serves all fixtures — swap the path to test others.)

3. **Run the extension on the page** (open the side panel, click Start). Use a fresh cache — click "Clear All Saved Websites" first if there are stale entries, so Layer-1/Layer-2 caching doesn't short-circuit the LLM call.

4. **Capture the result.** Open the page's DevTools Console and look for the `detection:request` / detection-result logs, or use the popup's "Download LLM input image" / debug buttons. You want the raw `DetectionResult` JSON: `page_evaluation` + `identified_dark_patterns[]`.

5. **Score against `ground-truth.json`:**
   - **True positive** — model flagged an element matching a `dark_patterns` `gt_id` (by css_selector / html_evidence overlap) with a `dark_pattern_type` in that entry's `accepts_types`.
   - **False negative** — a `dark_patterns` `gt_id` with no matching model entry.
   - **False positive** — model flagged an element matching a `counterexamples` `gt_id`, or an element matching no `gt_id` at all. **This is the metric the recent prompt rewrite targets.**
   - **Wrong type** — right element, wrong label. Track separately.
   - **Page eval** — separately check `page_type == "product_detail"` and that `user_primary_intent` is a reasonable paraphrase of "buy this mouse".

## Important caveats

- **Schema `maxItems: 3`.** The model can report at most 3 dark patterns per run, but there are 8 here. Single-pass recall is bounded at 3/8. Either run the page several times and union the results, or just track *which 3 it picks and whether all 3 are real* — a clean 3/3-correct top-3 with zero counterexamples flagged is the realistic "good" outcome.
- **`<details>` and the HTML extractor.** The hidden-fees and product-details content lives inside `<details>` elements, which are *not* `display:none` — so the extractor keeps them in the truncated HTML the LLM sees. That's intentional: the LLM needs to see the hidden fees to evaluate `dp-hidden-fees`, and needs to see the (innocuous) specs to correctly *not* flag `ce-product-details-accordion`.
- **Pop-up modal in the screenshot.** The page ships with the pop-up open (semi-transparent overlay), so the screenshot will show it on top of the page. That's realistic; the LLM should flag the pop-up *and* still see the rest of the page's content in the HTML.
- **One page, one data point.** This is a starting fixture. Add more pages (different sites, different DP combos, different "clean" pages with zero DPs) for a fuller benchmark.
