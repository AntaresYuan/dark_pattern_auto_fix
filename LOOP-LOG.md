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
