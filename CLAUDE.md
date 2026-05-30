# CLAUDE.md — Dark Pattern Fixer

Project shape: Chrome MV3 extension (`src/`) that detects dark patterns on the active page via an LLM and applies CSS-based fixes. The benchmark / eval-harness that scores this extension's prompt **lives in a separate repo** as of 2026-05-16 — see [`AntaresYuan/dark-pattern-benchmark`](https://github.com/AntaresYuan/dark-pattern-benchmark). This repo is extension-only now.

## Hard rules

- **The canonical DP taxonomy is here** at `src/shared/schema.ts:52-62` (9-type enum). The benchmark repo mirrors it as `schema/dp-types.json`. If you rename a type here, **update the mirror the same day** — there's no automatic drift check, and fixture ground-truths exact-match these strings.
- **Don't modify `src/shared/prompt.ts` mid-eval** unless you understand which benchmark scoring run is in flight; the prompt's harm-test definitions are part of what gets evaluated.
- **The stashed prompt.ts change** (`wip: prompt.ts grammar + screenshot-primary + query_selector rename`) is unresolved — if you `git stash pop` it, also propagate the `css_selector → query_selector` rename to `src/shared/schema.ts` AND to every fixture's `ground-truth.json` in the benchmark repo.
- **No `Co-Authored-By: Claude` trailer on commits.** User preference; commit under the user's git identity only.

## Commit conventions

- Conventional commits with scopes: `prompt:`, `extension:`, `chore:`.
- Never amend a pushed commit.

## Deep docs

| Topic | Path |
|---|---|
| Extension end-user / config | [README.md](./README.md) |
| Benchmark methodology + fixtures + scoring | [`AntaresYuan/dark-pattern-benchmark`](https://github.com/AntaresYuan/dark-pattern-benchmark) (separate repo) |
| Historical: devloop build log of starter-batch fixtures | [LOOP-LOG.md](./LOOP-LOG.md) |
| Historical: friction events from the starter-batch build | [LOOP-FRICTION.jsonl](./LOOP-FRICTION.jsonl) |
