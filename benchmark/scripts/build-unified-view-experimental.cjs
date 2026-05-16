#!/usr/bin/env node

// EXPERIMENTAL v4: single-tab design (frozen per-type coverage block + flat detail).
//
// One tab — "Unified Detail (experimental)" — contains:
//   Rows 1-12: per-type coverage matrix (fixed 9 rows × 4 cols, formula-driven
//     via COUNTIFS, recomputes automatically when detail rows below change).
//     Frozen + bold + tinted so they stay visible while scrolling detail.
//   Row 13: blank divider.
//   Row 14: detail header (13 cols).
//   Rows 15+: detail data, one row per gt_id (DP / CE).
//
// Why single-tab vs v2's 2-tab pivot design: per user feedback, two tabs is
// inconvenient for the "open the sheet, see everything" workflow. v1 (single
// tab w/ per-fixture summary at top) failed because the summary grew linearly
// with fixture count. v3 fixed that by putting only the PER-TYPE matrix at
// top (fixed 9 rows regardless of fixture count). v4 (current) drops the
// retired_DP rows + column per user — only current state is tracked.
// Per-fixture stats are available via Google Sheets Filter Views on the
// detail tab — one click, no scrolling, no schema growth.
//
// Pivot tables can't live in the same range as their source data (circular
// reference), so the COUNTIFS approach replaces them. Trade-off: less
// interactive than native pivots, but cheap to maintain and always visible.
//
// Idempotent: clears + rewrites the single tab on each run. Deletes any
// leftover tabs from v1 ("Unified View (experimental)") and v2
// ("Unified Pivot (experimental)").
//
// Usage (local):
//   GOOGLE_APPLICATION_CREDENTIALS=~/secrets/sa.json \
//   GOOGLE_SHEET_ID=13cTuwoeSVGYhcqd0RDKxKvyWBlyhd6X5zNx32Bx6q2A \
//   node benchmark/scripts/build-unified-view-experimental.cjs
//
// Usage (CI): .github/workflows/build-unified-view.yml.

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const DETAIL_TAB = "Unified Detail (experimental)";
const LEGACY_V1_TAB = "Unified View (experimental)";
const LEGACY_PIVOT_TAB = "Unified Pivot (experimental)";  // v2 leftover, auto-deleted

// 0-indexed column offsets within the detail data area (rows 15+).
const COL = {
  FIXTURE: 0,
  MIMICKED_SITE: 1,
  CATEGORY: 2,
  PAGE_TYPE: 3,
  KIND: 4,
  PATTERN_TYPE: 5,
  GT_ID: 6,
  ELEMENT: 7,
  WHY: 8,
  SELECTOR: 9,
  ACCEPTS_TYPES: 10,
  AUDIT_STATUS: 11,
  SOURCE: 12,
};

const HEADER = [
  "Fixture",
  "Mimicked Site",
  "Category",
  "Page Type",
  "Kind",
  "Pattern Type",
  "gt_id",
  "Element",
  "Why",
  "Selector",
  "Accepts Types",
  "Audit Status",
  "Source",
];

// 9 canonical DP types from src/shared/schema.ts:52-62 (must stay in sync).
const DP_TYPES = [
  "Disguised ad",
  "False hierarchy",
  "Preselection",
  "Pop-up ad",
  "Trick wording",
  "Confirm shaming",
  "Fake social proof",
  "Forced Action",
  "Hidden information",
];

// Summary block layout (1-indexed rows for spreadsheet notation):
//   Row 1: title (merged across cols A-E)
//   Row 2: summary header (Pattern Type | Active DPs | Retired DPs | CEs | Total)
//   Rows 3..3+DP_TYPES.length-1: one row per type (formula-driven)
//   Row 3+DP_TYPES.length: TOTAL footer (sum across types)
//   Row 3+DP_TYPES.length+1: blank divider
//   Row 3+DP_TYPES.length+2: detail header (full HEADER, 13 cols)
//   Rows 3+DP_TYPES.length+3..: detail data
const SUMMARY_TITLE_ROW = 1;
const SUMMARY_HEADER_ROW = 2;
const SUMMARY_FIRST_TYPE_ROW = 3;
const SUMMARY_LAST_TYPE_ROW = SUMMARY_FIRST_TYPE_ROW + DP_TYPES.length - 1;  // 11
const SUMMARY_TOTAL_ROW = SUMMARY_LAST_TYPE_ROW + 1;  // 12
const BLANK_DIVIDER_ROW = SUMMARY_TOTAL_ROW + 1;  // 13
const DETAIL_HEADER_ROW = BLANK_DIVIDER_ROW + 1;  // 14
const DETAIL_FIRST_DATA_ROW = DETAIL_HEADER_ROW + 1;  // 15

// COUNTIFS references the Kind column (E) and Pattern Type column (F) of the
// detail data, starting at row DETAIL_FIRST_DATA_ROW and running open-ended.
const KIND_RANGE = `$E$${DETAIL_FIRST_DATA_ROW}:$E`;
const TYPE_RANGE = `$F$${DETAIL_FIRST_DATA_ROW}:$F`;

// -----------------------------------------------------------------------------
// Auth
// -----------------------------------------------------------------------------

function loadCredentials() {
  if (process.env.GOOGLE_SHEET_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_SHEET_SERVICE_ACCOUNT_JSON);
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
  }
  throw new Error(
    "no credentials. Set GOOGLE_SHEET_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS."
  );
}

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: loadCredentials(),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth: await auth.getClient() });
}

// -----------------------------------------------------------------------------
// Fixture loading
// -----------------------------------------------------------------------------

function loadCurrentFixtures() {
  const fixturesDir = path.join(__dirname, "..", "fixtures");
  const slugs = fs
    .readdirSync(fixturesDir)
    .filter((n) => fs.statSync(path.join(fixturesDir, n)).isDirectory())
    .sort();
  return slugs.map((slug) => {
    const gt = JSON.parse(fs.readFileSync(path.join(fixturesDir, slug, "ground-truth.json"), "utf8"));
    return { slug, gt };
  });
}

function buildDetailRows(currentFixtures) {
  const rows = [];

  for (const { slug, gt } of currentFixtures) {
    const sourceRel = `benchmark/fixtures/${slug}/ground-truth.json`;
    const mimicked = gt.mimicked_site || "";
    const category = gt.category || "";
    const pageType = gt.page_type || gt.expected_page_evaluation?.page_type || "";

    const baseFixtureCols = [slug, mimicked, category, pageType];

    for (const dp of gt.dark_patterns || []) {
      rows.push([
        ...baseFixtureCols,
        "DP",
        dp.type || "",
        dp.gt_id,
        dp.element || "",
        dp.why || "",
        dp.selector || "",
        Array.isArray(dp.accepts_types) ? dp.accepts_types.join(", ") : (dp.accepts_types || ""),
        "active",
        sourceRel,
      ]);
    }

    for (const ce of gt.counterexamples || []) {
      rows.push([
        ...baseFixtureCols,
        "CE",
        ce.looks_like || "",
        ce.gt_id,
        ce.element || "",
        ce.why_not || "",
        ce.selector || "",
        "",
        "active",
        sourceRel,
      ]);
    }
  }

  // Stable sort: fixture, then DP < CE, then gt_id
  const kindOrder = { DP: 0, CE: 1 };
  rows.sort((a, b) => {
    if (a[COL.FIXTURE] !== b[COL.FIXTURE]) return a[COL.FIXTURE] < b[COL.FIXTURE] ? -1 : 1;
    if (a[COL.KIND] !== b[COL.KIND]) return kindOrder[a[COL.KIND]] - kindOrder[b[COL.KIND]];
    return a[COL.GT_ID] < b[COL.GT_ID] ? -1 : a[COL.GT_ID] > b[COL.GT_ID] ? 1 : 0;
  });

  return rows;
}

// -----------------------------------------------------------------------------
// Sheet I/O
// -----------------------------------------------------------------------------

async function getTabs(sheets, sheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  return meta.data.sheets.map((s) => ({
    title: s.properties.title,
    sheetId: s.properties.sheetId,
  }));
}

async function deleteTabIfExists(sheets, sheetId, title) {
  const tabs = await getTabs(sheets, sheetId);
  const t = tabs.find((x) => x.title === title);
  if (!t) return false;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests: [{ deleteSheet: { sheetId: t.sheetId } }] },
  });
  return true;
}

async function ensureTab(sheets, sheetId, title, rowCount = 200, columnCount = 14) {
  const tabs = await getTabs(sheets, sheetId);
  const existing = tabs.find((x) => x.title === title);
  if (existing) return existing.sheetId;
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        { addSheet: { properties: { title, gridProperties: { rowCount, columnCount } } } },
      ],
    },
  });
  return res.data.replies[0].addSheet.properties.sheetId;
}

async function clearAllCells(sheets, sheetId, tabSheetId) {
  // Clear EVERYTHING on the tab — including pivot tables, formatting, frozen
  // rows. Pivot tables aren't removed by `values.clear`; they live as cell
  // metadata that has to be wiped via updateCells with an empty value.
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        {
          updateCells: {
            range: { sheetId: tabSheetId },
            fields: "*",
          },
        },
      ],
    },
  });
}

// Summary block columns: A=Pattern Type | B=Active DPs | C=CEs | D=Total.
const SUMMARY_COL_COUNT = 4;

function buildSummaryBlock() {
  // Returns a 2D array of values/formulas covering rows 1..SUMMARY_TOTAL_ROW
  // (12) and cols A..D (4 cols). Detail header + data appended separately.
  const block = [];

  // Row 1: title spanning A-D (formatted as merged cell in batchUpdate).
  block.push([
    "Coverage by Pattern Type (auto-recomputes from detail rows below)",
    "", "", ""
  ]);

  // Row 2: summary header.
  block.push(["Pattern Type", "Active DPs", "CEs", "Total"]);

  // Rows 3..11: one per canonical DP type.
  for (let i = 0; i < DP_TYPES.length; i++) {
    const type = DP_TYPES[i];
    const t = type.replace(/"/g, '\\"');
    const r = SUMMARY_FIRST_TYPE_ROW + i;
    block.push([
      type,
      `=COUNTIFS(${KIND_RANGE},"DP",${TYPE_RANGE},"${t}")`,
      `=COUNTIFS(${KIND_RANGE},"CE",${TYPE_RANGE},"${t}")`,
      `=SUM(B${r}:C${r})`,
    ]);
  }

  // Row 12: TOTAL footer.
  block.push([
    "TOTAL",
    `=SUM(B${SUMMARY_FIRST_TYPE_ROW}:B${SUMMARY_LAST_TYPE_ROW})`,
    `=SUM(C${SUMMARY_FIRST_TYPE_ROW}:C${SUMMARY_LAST_TYPE_ROW})`,
    `=SUM(D${SUMMARY_FIRST_TYPE_ROW}:D${SUMMARY_LAST_TYPE_ROW})`,
  ]);

  return block;
}

async function writeDetailTab(sheets, sheetId, tabSheetId, rows) {
  const summary = buildSummaryBlock();
  // Pad summary rows to HEADER.length cols so single update covers full width.
  const padded = summary.map((r) => [...r, ...Array(HEADER.length - r.length).fill("")]);
  const blankDivider = Array(HEADER.length).fill("");

  const values = [
    ...padded,           // rows 1..12 (summary)
    blankDivider,        // row 13
    HEADER,              // row 14 (detail header)
    ...rows,             // rows 15+
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${DETAIL_TAB}!A1`,
    valueInputOption: "USER_ENTERED",  // formulas evaluate
    requestBody: { values },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        // Freeze all rows up to and including the detail header.
        {
          updateSheetProperties: {
            properties: { sheetId: tabSheetId, gridProperties: { frozenRowCount: DETAIL_HEADER_ROW } },
            fields: "gridProperties.frozenRowCount",
          },
        },
        // Unmerge title row across ALL columns first — clears any merge left
        // over from a prior run that used a different col span (e.g. v3 used
        // A-E, v4 uses A-D; overlapping but non-equal merges throw).
        {
          unmergeCells: {
            range: {
              sheetId: tabSheetId,
              startRowIndex: SUMMARY_TITLE_ROW - 1,
              endRowIndex: SUMMARY_TITLE_ROW,
              startColumnIndex: 0,
              endColumnIndex: HEADER.length,
            },
          },
        },
        // Merge title row across summary cols (A-D).
        {
          mergeCells: {
            range: {
              sheetId: tabSheetId,
              startRowIndex: SUMMARY_TITLE_ROW - 1,
              endRowIndex: SUMMARY_TITLE_ROW,
              startColumnIndex: 0,
              endColumnIndex: SUMMARY_COL_COUNT,
            },
            mergeType: "MERGE_ALL",
          },
        },
        // Title row: bold + larger + slate background.
        {
          repeatCell: {
            range: {
              sheetId: tabSheetId,
              startRowIndex: SUMMARY_TITLE_ROW - 1,
              endRowIndex: SUMMARY_TITLE_ROW,
            },
            cell: {
              userEnteredFormat: {
                textFormat: {
                  bold: true,
                  fontSize: 12,
                  foregroundColor: { red: 1, green: 1, blue: 1 },
                },
                backgroundColor: { red: 0.27, green: 0.31, blue: 0.38 },
                horizontalAlignment: "CENTER",
                verticalAlignment: "MIDDLE",
              },
            },
            fields: "userEnteredFormat(textFormat,backgroundColor,horizontalAlignment,verticalAlignment)",
          },
        },
        // Summary header row (row 2): bold + medium gray background.
        {
          repeatCell: {
            range: {
              sheetId: tabSheetId,
              startRowIndex: SUMMARY_HEADER_ROW - 1,
              endRowIndex: SUMMARY_HEADER_ROW,
              startColumnIndex: 0,
              endColumnIndex: SUMMARY_COL_COUNT,
            },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true },
                backgroundColor: { red: 0.85, green: 0.85, blue: 0.85 },
              },
            },
            fields: "userEnteredFormat(textFormat,backgroundColor)",
          },
        },
        // TOTAL row (row 12): bold + light gray background.
        {
          repeatCell: {
            range: {
              sheetId: tabSheetId,
              startRowIndex: SUMMARY_TOTAL_ROW - 1,
              endRowIndex: SUMMARY_TOTAL_ROW,
              startColumnIndex: 0,
              endColumnIndex: SUMMARY_COL_COUNT,
            },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true },
                backgroundColor: { red: 0.93, green: 0.93, blue: 0.93 },
              },
            },
            fields: "userEnteredFormat(textFormat,backgroundColor)",
          },
        },
        // Detail header (row 14): bold + light gray background.
        {
          repeatCell: {
            range: {
              sheetId: tabSheetId,
              startRowIndex: DETAIL_HEADER_ROW - 1,
              endRowIndex: DETAIL_HEADER_ROW,
            },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true },
                backgroundColor: { red: 0.93, green: 0.93, blue: 0.93 },
              },
            },
            fields: "userEnteredFormat(textFormat,backgroundColor)",
          },
        },
        // Wrap text + top-align for detail data rows (row 15 onward).
        {
          repeatCell: {
            range: { sheetId: tabSheetId, startRowIndex: DETAIL_FIRST_DATA_ROW - 1 },
            cell: { userEnteredFormat: { wrapStrategy: "WRAP", verticalAlignment: "TOP" } },
            fields: "userEnteredFormat(wrapStrategy,verticalAlignment)",
          },
        },
        // Column widths (apply to detail data; summary uses same A-E widths).
        ...colWidthRequest(tabSheetId, COL.FIXTURE, 200),
        ...colWidthRequest(tabSheetId, COL.MIMICKED_SITE, 130),
        ...colWidthRequest(tabSheetId, COL.CATEGORY, 150),
        ...colWidthRequest(tabSheetId, COL.PAGE_TYPE, 160),
        ...colWidthRequest(tabSheetId, COL.KIND, 95),
        ...colWidthRequest(tabSheetId, COL.PATTERN_TYPE, 150),
        ...colWidthRequest(tabSheetId, COL.GT_ID, 230),
        ...colWidthRequest(tabSheetId, COL.ELEMENT, 380),
        ...colWidthRequest(tabSheetId, COL.WHY, 520),
        ...colWidthRequest(tabSheetId, COL.SELECTOR, 240),
        ...colWidthRequest(tabSheetId, COL.ACCEPTS_TYPES, 180),
        ...colWidthRequest(tabSheetId, COL.AUDIT_STATUS, 230),
        ...colWidthRequest(tabSheetId, COL.SOURCE, 320),
      ],
    },
  });
}

function colWidthRequest(tabSheetId, colIdx, pixels) {
  return [
    {
      updateDimensionProperties: {
        range: { sheetId: tabSheetId, dimension: "COLUMNS", startIndex: colIdx, endIndex: colIdx + 1 },
        properties: { pixelSize: pixels },
        fields: "pixelSize",
      },
    },
  ];
}

// -----------------------------------------------------------------------------

(async () => {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("GOOGLE_SHEET_ID env var required");

  console.log(`single tab: ${DETAIL_TAB}`);

  const current = loadCurrentFixtures();
  console.log(`current fixtures loaded: ${current.length} (${current.map((f) => f.slug).join(", ")})`);

  const detailRows = buildDetailRows(current);
  const counts = detailRows.reduce((acc, r) => {
    acc[r[COL.KIND]] = (acc[r[COL.KIND]] || 0) + 1;
    return acc;
  }, {});
  console.log(`detail rows: ${detailRows.length} (${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")})`);

  const sheets = await getSheetsClient();

  // Cleanup: kill leftover tabs from v1 and v2.
  for (const stale of [LEGACY_V1_TAB, LEGACY_PIVOT_TAB]) {
    const removed = await deleteTabIfExists(sheets, sheetId, stale);
    if (removed) console.log(`removed legacy tab "${stale}"`);
  }

  // Single tab: summary (rows 1-12) + divider (row 13) + detail header (row 14) + data (15+).
  const totalRowsNeeded = DETAIL_FIRST_DATA_ROW + detailRows.length + 20;
  const detailSheetId = await ensureTab(sheets, sheetId, DETAIL_TAB, Math.max(200, totalRowsNeeded), HEADER.length + 1);
  await clearAllCells(sheets, sheetId, detailSheetId);
  await writeDetailTab(sheets, sheetId, detailSheetId, detailRows);
  console.log(`wrote summary (rows 1-${SUMMARY_TOTAL_ROW}) + ${detailRows.length} detail rows to "${DETAIL_TAB}"`);

  console.log("done.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
