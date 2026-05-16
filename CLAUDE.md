# CLAUDE.md — Dark Pattern Fixer

Project shape: Chrome MV3 extension (`src/`) that detects dark patterns via
an LLM + a benchmark fixture suite (`benchmark/fixtures/<slug>/`) + a Google
Sheet mirror of every fixture's ground truth.

## Hard rules

- **Fixture realism > coverage.** Only ship a DP on a fixture if a real user
  would actually encounter it on that surface. Padding to hit a fixed DP
  count is rejected. Document any drop in the fixture's `fixture_notes[]`.
  Established 2026-05-15 by the audit in PR #28 / issue #27.
- **Pop-up overlays need functional close X.** Visual degradation (low
  opacity, hidden corner) IS the dark pattern; non-functional is unrealistic.
  Use `onclick="document.querySelector('.<overlay>').remove()"` on the close
  button.
- **`gt_id` is the canonical identifier.** HTML `[DP-N]` / `[CE-N]` comments
  may be non-sequential after audits — don't renumber them just for tidiness;
  the cost is diff noise.
- **Don't pad fixtures with cross-fixture analogues.** If a DP type isn't
  canonical for the surface, leave the gap — `Disguised ad` and
  `Trick wording` have zero active coverage post-audit by design.

## Workflow gotchas

- **Sheet sync trigger**: `sync-benchmark-to-sheet.yml` runs only when
  `ground-truth.json` changes are pushed to `main`. README/HTML-only edits
  do NOT trigger sync.
- **Sheet sync leaves orphans** (issue #29): the legacy script is upsert-only.
  Removed gt_ids stay as stale rows until manual cleanup, or until the
  planned `spreadsheets.values.batchUpdate` refactor lands.
- **Sheets API quota** (60 writes/min/user) — big runs can deplete. Manual
  retry: `gh workflow run sync-benchmark-to-sheet.yml --ref main` after
  ~1min cooldown.

## Current experiment (in evaluation, do not modify without context)

`benchmark/scripts/build-unified-view-experimental.cjs` + manual workflow
`.github/workflows/build-unified-view.yml` write a **single tab** —
`Unified Detail (experimental)` — with two zones:

- Rows 1-12: per-type coverage matrix (9 types × Active/Retired/CE/Total),
  formula-driven via `COUNTIFS`, frozen so it stays visible while scrolling.
- Row 14 + below: flat detail data, one row per gt_id (DP / CE / retired_DP),
  13 columns, no truncation.

v3 design (current). Earlier iterations: v1 = single tab with per-fixture
summary (rejected — summary grew with fixture count); v2 = two tabs detail +
pivot (rejected by user — two tabs inconvenient for "open and see
everything"). v3's compromise: per-type matrix is fixed-size 9 rows so doesn't
grow with fixtures; per-fixture stats are accessible via Google Sheets Filter
Views on the detail data. Legacy v1 + v2 tabs are auto-deleted on each run.

## Deep docs

| Topic | Path |
|---|---|
| Extension end-user / config | [README.md](./README.md) |
| Benchmark methodology + fixture roster + scoring | [benchmark/README.md](./benchmark/README.md) |
| Sheet sync one-time setup + experimental tab notes | [benchmark/scripts/SHEET-SETUP.md](./benchmark/scripts/SHEET-SETUP.md) |
| 10-bucket site taxonomy | [benchmark/CATEGORIES.md](./benchmark/CATEGORIES.md) |
| Historical: starter-batch fixture plan | [benchmark/fixtures/PLAN.md](./benchmark/fixtures/PLAN.md) |
| Historical: devloop build log + post-devloop manual work | [LOOP-LOG.md](./LOOP-LOG.md) |
