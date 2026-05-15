# devloop — benchmark-pipeline run

Run ID: `2026-05-14-bench-pipeline`
Queue: milestone `benchmark-pipeline` (issues #8–#16). Stop after #16.

---

## #8 — build injection-mapping-index.json

- **Branch**: `feat/benchmark-injection-mapping-index` (deleted post-merge)
- **PR**: [#17](https://github.com/AntaresYuan/dark_pattern_auto_fix/pull/17) — squash-merged as `918473c`
- **What was done**: parser script at `benchmark/scripts/build-injection-index.cjs` (CommonJS, takes `--source <path>`); output at `benchmark/injection-mapping-index.json`. Two-pass key splitter handles the `<site>_<dp>_<discriminator>` case for Apple's 6 multi-variant entries.
- **What was tested**:
  - Idempotency: rebuilt twice, `diff -q` clean.
  - All 126 / 126 keys matched (0 warnings, 0 line-range overlaps).
  - `by_site["amz"]` = 7 (acceptance).
  - All 9 `dp_type_canonical` values match `src/shared/schema.ts:52-62` exactly.
  - `sed -n '935,1007p'` on source returns the `amz_disguised` block — head + tail match expected boundaries.
- **Reviewer verdict** (independent general-purpose sub-agent, Read/Grep/Glob only): **OK to merge**. Flagged 3 latent edge cases (pass-2 ordering sensitivity if future keys add nested DP-suffix substrings; `mapEnd` regex fragility; key-regex hardcoded leading spaces) — none triggered by current 126 entries. Noted, not fixed in this PR.
- **Friction**:
  - 1× retry: wrote `.js` first, repo `package.json` has `"type": "module"`, renamed to `.cjs`. Logged to `LOOP-FRICTION.jsonl`.
- **Follow-ups**: none.
- **Acceptance deviation**: issue body said "≥145 entries"; actual is 126. Estimate was wrong at draft time. Index is exhaustive — confirmed via `grep -c` on source.

---

## #9 — pull Tranco top 100 + write sites.json

- **Branch**: `feat/benchmark-sites-top-100` (deleted post-merge)
- **PR**: [#18](https://github.com/AntaresYuan/dark_pattern_auto_fix/pull/18) — squash-merged as `5bf8283`
- **What was done**: filter script at `benchmark/scripts/build-sites-json.cjs`; Tranco snapshot at `benchmark/data/tranco-6G8PX-2026-05-14-top-300.csv`; output at `benchmark/sites.json`. List ID `6G8PX` (daily list, fetched via Tranco's `api/lists/date/latest`).
- **What was tested**:
  - 100 / 100 entries (`jq '.sites | length'`)
  - All 5 required fields per entry (`rank`, `domain`, `category=null`, `category_rationale=null`, `fixture_status="not_started"`)
  - JSON valid (`jq empty`)
  - Idempotency: byte-identical re-runs
  - Random spot-check of 10 sites — all known UI surfaces
- **Reviewer verdict** (independent sub-agent): **OK to merge after fixing 2 items**. Fixed in `22b291f`:
  1. `dzen.ru` (rank 15) wrongly placed under DNS-infra deny — it's a Yandex consumer feed product. Removed the rule, now kept.
  2. `counts.input_rows: 300` misleading. Renamed to `csv_total_rows` + added `rows_considered: 266` so 100 + 166 = 266 reconciles.
  3. Cheap polish: simplified tangled cdn regex (had dead-code alternation) to `/(^|\.)cdn\..*$/`.
- **Friction**: none in this task. Reviewer-cycle was 1 (single revision before merge).
- **Follow-ups** (non-blocking, deferred):
  - `wikimedia.org` (rank 266) borderline — could drop since wikipedia.org (27) covers Wikimedia's consumer surface.
  - `opera.com` / `ui.com` / `comcast.net` borderline drops; left in infra. Defensible either way.
  - Headroom: only 34 unread rows in the 300-row snapshot. If Tranco rankings shift such that 5+ keeps re-classify as deny, re-fetch with `--count 500` or larger.
  - Script doesn't BOM-strip the CSV or dedupe rows. Current Tranco CSV is clean. Worth hardening if Tranco ever ships malformed data.
  - **Stale doc drift in PR #18 body**: my "bottom 10" table listed `hp.com` (rank 268), but the dzen.ru fix that landed in the same PR (commit `22b291f`) bumped loop termination from 268 to 266, so `hp.com` is NOT in the final sites.json. The merged code is correct; only the PR description drifted. Noted for honesty; not editing the merged PR.

---

## #10 — classify 100 sites into 10-category taxonomy

- **Branch**: `feat/benchmark-classify-sites` (deleted post-merge)
- **PR**: [#19](https://github.com/AntaresYuan/dark_pattern_auto_fix/pull/19) — squash-merged as `6747584`
- **What was done**: classifier script at `benchmark/scripts/classify-sites.cjs` with hand-coded `DOMAIN_TO_CATEGORY` map. Updated `benchmark/sites.json` (every site has `category` + `category_rationale`; top-level `taxonomy` block added). Wrote `benchmark/CATEGORIES.md` (taxonomy table + per-cat counts).
- **Histogram**: E-com 13, News 10, Social 14, Travel 1, Finance 3, SaaS 28, Streaming 8, Dating/Gaming 2, Education 3, Utility 18. All ≥1, max 28 (<50).
- **Reviewer verdict**: **OK to merge after 1 fix**. Caught the dead `hp.com` map entry (left over from sites.json v1, before the dzen.ru fix bumped it out). Fixed in `cb21173` + added a guard so dead map entries now error instead of silently skipping.
- **Friction**: cross-PR doc drift — sites.json's contents changed in PR #18's last commit (dzen.ru fix), and I didn't re-verify the classification map against the post-fix sites.json before opening this PR. Reviewer caught it. Logged.
- **Follow-ups**: none.

---

## #11 — pick 5 starter fixtures + write PLAN.md

- **Branch**: `feat/benchmark-pick-5-starter-fixtures` (deleted post-merge)
- **PR**: [#20](https://github.com/AntaresYuan/dark_pattern_auto_fix/pull/20) — squash-merged as `6fb09e9`
- **What was done**: `benchmark/fixtures/PLAN.md` with 5 rows (booking-hotel-checkout, nytimes-article-paywall, netflix-cancel-flow, facebook-deactivation, paypal-account-close). Marker script `benchmark/scripts/mark-planned-fixtures.cjs` flips fixture_status to "planned" for the 5 in sites.json.
- **Coverage**: 5 distinct categories (Travel/News/Streaming/Social/Finance) + 5 distinct page types — exceeds 4/4 minimum.
- **Reference signal**: only 5 sites overlap between top 100 and the injection-mapping (amazon, apple, ebay, nytimes, booking). 2 of my 5 picks have direct snippets (booking, nytimes); the other 3 (netflix, facebook, paypal) are adaptation-heavy. Documented per row in PLAN.md.
- **Reviewer verdict**: **OK to merge**. Cited reference keys all verified present in injection-mapping-index. One non-blocking flag: paypal row conflates "account-close" + "signup-marketing-preselect" — to be resolved when building fixture #16 (pick one, demote the other to counterexample).
- **Friction**: none.
- **Follow-ups for fixtures 6+**: injection-mapping underlaps Tranco top 100 outside e-commerce; future fixtures will either need to source sites outside top 100 or invest in extending the index with new entries for top-100 brands.

---

## #12 — build fixture booking-hotel-checkout

- **Branch**: `feat/benchmark-fixture-booking-checkout` (deleted post-merge)
- **PR**: [#21](https://github.com/AntaresYuan/dark_pattern_auto_fix/pull/21) — squash-merged as `8494d14`
- **What was done**: full replica of Booking.com hotel-property page (Royal Park Hotel Iconic Tokyo Shiodome). 522-line self-contained HTML + 147-line ground-truth.json. 8 dark patterns covering 8 of 9 schema types (only Forced Action absent — doesn't fit a hotel checkout where guest checkout is supported). 6 counterexamples for FP measurement.
- **What was tested**: served via `python3 -m http.server`, returns 200 (26KB). All 14 gt-ids cross-reference between HTML and JSON. Each gt-id matches exactly 1 element. JSON valid. No external resource URLs except deliberate affiliate stub for DP-8.
- **Reviewer verdict**: **OK to merge after 1 fix**. Caught dead-code in `ce-real-reserve` selector (`#ce-real-reserve` referenced an id that didn't exist in HTML). Fixed in `1851883`: added `id="reserve-button"` to the real reserve `<a>`, matching Amazon fixture's `#add-to-cart-button` / `#buy-now-button` convention. Now selector resolves.
- **Convention propagated to fixtures #13-#16**: real-CTA CEs get a meaningful element id (e.g. `#cancel-button`, `#signin-button`) AND the data-gt-id attribute. Ground-truth selector lists both as alternatives.
- **Friction**: 1 reviewer cycle (selector dead-code). Schema deviation from issue body documented in PR — kept Amazon's flat `selector` + combined `why` instead of nested `html_evidence_locator` + split `realism_rationale`/`harm_rationale`.
- **Follow-ups**: none on this fixture. **PIPELINE CHANGE pending**: user is adding a Google Sheet sync step (per-fixture ground-truth.json → sheet rows). Devloop paused at #13 awaiting sheet link + schema agreement, then implementing as GitHub Actions workflow.

---

## ⏸ Devloop paused (mid-queue, after #12)

Reason: user requested adding Google Sheet sync as a new pipeline step before continuing fixture builds (#13-#16). Booking fixture (#12) merged; remaining queue is #13 nytimes-article-paywall → #14 netflix-cancel-flow → #15 facebook-deactivation → #16 paypal-account-close.

Plan:
1. User shares Google Sheet draft link
2. Agree on row schema (probably one row per DP/CE with fixture_slug + gt_id + kind + type + selector + why columns)
3. Build `benchmark/scripts/sync-to-sheet.cjs` + GitHub Actions workflow that runs on PR merge to main (gated on changes under `benchmark/fixtures/*/ground-truth.json`)
4. Backfill: sync booking + amazon fixtures retroactively
5. Update fixture-build issue acceptance criteria (#13-#16) to include "verify sheet sync ran"
6. Resume queue with #13

---
