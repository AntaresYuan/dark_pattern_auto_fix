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
