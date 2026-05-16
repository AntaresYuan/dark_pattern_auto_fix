# Google Sheet Sync — One-Time Setup

The benchmark pipeline pushes per-fixture rows into a Google Sheet on every PR merge. This is a one-time setup.

## Phase A — Sheet schema (your sheet)

Open the sheet (https://docs.google.com/spreadsheets/d/13cTuwoeSVGYhcqd0RDKxKvyWBlyhd6X5zNx32Bx6q2A/edit) and:

1. **Section 2 column rename**: change the header `Double negative` → `Trick wording`. (Matches the canonical taxonomy in `src/shared/schema.ts`.)

2. **Detail tab**: the script will auto-create a tab named `Synthetic DP Detail` on first run. You don't need to make it manually — but verify it exists after the first sync.

The expected Section 2 header (left to right):

```
dp_id | Website | Dark Pattern Count | Disguised ad | False hierarchy |
Preselection | Pop-up ad | Trick wording | Confirm shaming |
Fake social proof | Forced Action | Hidden information
```

The auto-created Synthetic DP Detail header:

```
Pattern String | Comment | Pattern Category | Pattern Type |
Where in website? | Deceptive? | Website Page | Kind | gt_id | source
```

## Phase B — Google Cloud service account

The Actions workflow needs a service account to write to the sheet. The simplest path:

1. Open https://console.cloud.google.com/
2. Create a new project (or pick an existing one).
3. Enable the **Google Sheets API**: APIs & Services → Library → "Google Sheets API" → Enable.
4. Create a service account:
   - IAM & Admin → Service Accounts → Create.
   - Name: `dark-pattern-benchmark-sync` (or whatever).
   - Skip the optional role assignment (we don't need GCP roles, only sheet sharing).
5. Create a key for it:
   - On the service account row → Actions → Manage keys → Add key → Create new key → JSON.
   - Save the downloaded `<project>-<id>.json` somewhere local (NOT in the repo).
   - Note the service account's email (looks like `dark-pattern-benchmark-sync@<project>.iam.gserviceaccount.com`).

## Phase C — Share the sheet with the service account

1. Open the sheet.
2. Click Share → enter the service-account email from Phase B → set permission to **Editor** → Send.
   - You'll get a "this email isn't on Google" warning — that's fine, click "Share anyway".
3. Now the service account can read + write the sheet.

## Phase D — GitHub repo secrets

In the repo (https://github.com/AntaresYuan/dark_pattern_auto_fix) → Settings → Secrets and variables → Actions → New repository secret. Add two:

| Secret name | Value |
|---|---|
| `GOOGLE_SHEET_SERVICE_ACCOUNT_JSON` | The **entire contents** of the JSON key file from Phase B (paste it raw — it's already a JSON string). |
| `GOOGLE_SHEET_ID` | `13cTuwoeSVGYhcqd0RDKxKvyWBlyhd6X5zNx32Bx6q2A` (the long ID in the sheet URL). |

## Phase E — First run

After Phases A–D are done, fire the workflow manually to backfill the existing fixtures:

1. Repo → Actions → "Sync benchmark fixtures to Google Sheet" → Run workflow → main → Run.
2. Wait ~30 seconds. Click the run, look at the logs. Should see something like:
   ```
   fixtures loaded: 2 (amazon-product-page, booking-hotel-checkout)
   tabs in sheet: <existing tab name(s)>
   Section 2 found in tab "<x>", header at row N
   Section 2: 0 updated, 2 appended at row N+1
   created tab "Synthetic DP Detail"
   Detail tab: 0 updated, 30 appended
   done.
   ```
   (Detail count = 8 amazon DPs + 8 amazon CEs + 8 booking DPs + 6 booking CEs = 30.)

After that, every merge to `main` that touches `benchmark/fixtures/**/ground-truth.json` will auto-sync.

## Local testing (optional)

If you want to test the script locally before flipping the workflow on, after Phase A–C:

```bash
# Install googleapis once.
npm install --no-save googleapis

# Run with the service-account JSON file path:
GOOGLE_APPLICATION_CREDENTIALS=~/path/to/sa.json \
GOOGLE_SHEET_ID=13cTuwoeSVGYhcqd0RDKxKvyWBlyhd6X5zNx32Bx6q2A \
node benchmark/scripts/sync-to-sheet.cjs
```

Same output as Phase E, but doesn't require GitHub Actions.

## Failure modes you might hit

| Error | Why | Fix |
|---|---|---|
| `403 The caller does not have permission` | Sheet not shared with service account | Re-do Phase C |
| `Could not find Section 2 header` | Section 2's column A doesn't contain `dp_id` (script searches col A only — case-insensitive, whitespace tolerant). If you moved `dp_id` to column B, the script can't find it. | Move `dp_id` back to column A |
| `Requested entity was not found` | Wrong sheet ID | Re-check `GOOGLE_SHEET_ID` |
| `Login Required` | Service account JSON missing/malformed | Re-paste secret; ensure it's the full JSON |

## What the script does NOT do

- It does not delete rows. If you remove a DP from a `ground-truth.json` (e.g., during an audit), the row stays in the sheet as an **orphan**. Manual cleanup needed until the script is refactored. Tracked as **issue #29**.
- It does not validate the sheet is well-formed before writing. If you broke the Section 2 header by accident, the script will append rows in unexpected places.
- It does not edit Section 1 (the real-world observation log). That stays untouched.

## Experimental: unified-view tab (single tab — v3)

A parallel script `build-unified-view-experimental.cjs` (triggered by the
manual workflow `.github/workflows/build-unified-view.yml`) writes a single
tab `Unified Detail (experimental)` currently in evaluation:

- Rows 1-12: per-type coverage matrix — 9 DP types × (Active DPs / Retired
  DPs / CEs / Total). Formula-driven (`COUNTIFS`), auto-recomputes when the
  detail rows below change. Frozen so it stays visible while scrolling.
- Row 14 + below: flat data table, one row per gt_id (DP / CE / `retired_DP`),
  13 columns, no truncation. Single source of truth.

Per-fixture stats are accessible via Google Sheets Filter Views on the
detail data (no second tab needed).

If the design is accepted, this replaces the legacy 2-tab split (Section 2 +
Synthetic DP Detail) and the orphan-row problem (issue #29) goes away — the
experimental script clears + rewrites the tab on each run. Legacy tabs from
earlier iterations (`Unified View (experimental)` from v1,
`Unified Pivot (experimental)` from v2) are auto-deleted on each run.
