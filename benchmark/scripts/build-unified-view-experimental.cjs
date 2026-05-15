#!/usr/bin/env node

// EXPERIMENTAL v2: scalable two-tab design.
//
//   1. "Unified Detail (experimental)" — flat data table, one row per gt_id,
//      all fields, no truncation. This is the single source of truth.
//
//   2. "Unified Pivot (experimental)" — three native Sheets pivot tables that
//      consume the detail tab. Pivot 1 = Fixture × Pattern Type (filtered to
//      active DPs — this replicates the legacy Section 2 view). Pivot 2 =
//      Fixture × Kind (active DPs / retired DPs / CEs per fixture). Pivot 3 =
//      Pattern Type × Kind (coverage map across the whole benchmark, makes
//      the Disguised-ad / Trick-wording coverage gap visible at a glance).
//
// Why this design scales: the detail tab is just rows; adding fixtures /
// types / kinds doesn't change the schema. Pivots auto-recompute. The
// original v1 layout (in-tab summary block at the top) was rejected because
// the per-fixture summary grew linearly with fixture count, pushing detail
// rows further down on every addition.
//
// Retired_DP rows: pulled live from a previous git commit (default 8b9ecb9,
// the pre-realism-audit baseline) so the 23 dropped entries stay visible in
// the detail tab as a transparent audit trail and as a baseline signal for
// future model evals (the model used to flag these — does it still?).
//
// Idempotent: clears + rewrites both experimental tabs on each run. Also
// deletes any leftover "Unified View (experimental)" tab from v1.
//
// Usage (local):
//   GOOGLE_APPLICATION_CREDENTIALS=~/secrets/sa.json \
//   GOOGLE_SHEET_ID=13cTuwoeSVGYhcqd0RDKxKvyWBlyhd6X5zNx32Bx6q2A \
//   node benchmark/scripts/build-unified-view-experimental.cjs
//
// Usage (CI): .github/workflows/build-unified-view.yml.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { google } = require("googleapis");

const DETAIL_TAB = "Unified Detail (experimental)";
const PIVOT_TAB = "Unified Pivot (experimental)";
const LEGACY_V1_TAB = "Unified View (experimental)";
const PREV_COMMIT = process.env.PREV_COMMIT || "8b9ecb9";

// 0-indexed column offsets within the detail tab. Pivot tables reference
// these to identify the rows / columns / values / filters fields.
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

function loadPreAuditFixtures(commit) {
  const fixturesDir = path.join(__dirname, "..", "fixtures");
  const slugs = fs
    .readdirSync(fixturesDir)
    .filter((n) => fs.statSync(path.join(fixturesDir, n)).isDirectory())
    .sort();
  const out = [];
  for (const slug of slugs) {
    const relPath = `benchmark/fixtures/${slug}/ground-truth.json`;
    try {
      const raw = execSync(`git show ${commit}:${relPath}`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      out.push({ slug, gt: JSON.parse(raw) });
    } catch (err) {
      console.warn(`warn: could not read ${slug} at ${commit} — skipping retired-DP detection: ${err.message}`);
    }
  }
  return out;
}

function buildDetailRows(currentFixtures, preAuditFixtures) {
  const rows = [];
  const preBySlug = new Map(preAuditFixtures.map((f) => [f.slug, f]));

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

    const pre = preBySlug.get(slug);
    if (pre) {
      const currentDpIds = new Set((gt.dark_patterns || []).map((d) => d.gt_id));
      const preCategory = pre.gt.category || category;
      const prePageType = pre.gt.page_type || pre.gt.expected_page_evaluation?.page_type || pageType;
      const preMimicked = pre.gt.mimicked_site || mimicked;
      for (const oldDp of pre.gt.dark_patterns || []) {
        if (currentDpIds.has(oldDp.gt_id)) continue;
        rows.push([
          slug,
          preMimicked,
          preCategory,
          prePageType,
          "retired_DP",
          oldDp.type || "",
          oldDp.gt_id,
          oldDp.element || "",
          oldDp.why || "",
          oldDp.selector || "",
          Array.isArray(oldDp.accepts_types) ? oldDp.accepts_types.join(", ") : (oldDp.accepts_types || ""),
          "retired_2026-05-15 (PR #28, see #27)",
          sourceRel,
        ]);
      }
    }
  }

  // Stable sort: fixture, then DP < CE < retired_DP, then gt_id
  const kindOrder = { DP: 0, CE: 1, retired_DP: 2 };
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

async function writeDetailTab(sheets, sheetId, tabSheetId, rows) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${DETAIL_TAB}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADER, ...rows] },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        // Freeze the header row.
        {
          updateSheetProperties: {
            properties: { sheetId: tabSheetId, gridProperties: { frozenRowCount: 1 } },
            fields: "gridProperties.frozenRowCount",
          },
        },
        // Bold header.
        {
          repeatCell: {
            range: { sheetId: tabSheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true },
                backgroundColor: { red: 0.93, green: 0.93, blue: 0.93 },
              },
            },
            fields: "userEnteredFormat(textFormat,backgroundColor)",
          },
        },
        // Wrap text + top-align everywhere below the header.
        {
          repeatCell: {
            range: { sheetId: tabSheetId, startRowIndex: 1 },
            cell: { userEnteredFormat: { wrapStrategy: "WRAP", verticalAlignment: "TOP" } },
            fields: "userEnteredFormat(wrapStrategy,verticalAlignment)",
          },
        },
        // Column widths.
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
// Pivot tables
// -----------------------------------------------------------------------------

function pivotRequest(pivotTabSheetId, anchor, label, pivot, detailSheetId) {
  // Write a label cell at one row above the pivot, then drop the pivot at
  // {row, col}. Returns an array of batchUpdate request objects.
  return [
    {
      updateCells: {
        rows: [
          {
            values: [
              {
                userEnteredValue: { stringValue: label },
                userEnteredFormat: { textFormat: { bold: true, fontSize: 12 } },
              },
            ],
          },
        ],
        fields: "userEnteredValue,userEnteredFormat.textFormat",
        start: { sheetId: pivotTabSheetId, rowIndex: anchor.row - 1, columnIndex: anchor.col },
      },
    },
    {
      updateCells: {
        rows: [
          {
            values: [
              {
                pivotTable: {
                  source: {
                    sheetId: detailSheetId,
                    startRowIndex: 0,
                    startColumnIndex: 0,
                    endColumnIndex: HEADER.length,
                    // endRowIndex omitted: pivot grows with the source.
                  },
                  ...pivot,
                },
              },
            ],
          },
        ],
        fields: "pivotTable",
        start: { sheetId: pivotTabSheetId, rowIndex: anchor.row, columnIndex: anchor.col },
      },
    },
  ];
}

async function buildPivotTab(sheets, sheetId, pivotTabSheetId, detailSheetId) {
  // Pivot 1: Fixture × Pattern Type, count of gt_id, filtered to Kind=DP.
  // This replicates the legacy Section 2 view.
  const pivot1 = {
    rows: [{ sourceColumnOffset: COL.FIXTURE, showTotals: true, sortOrder: "ASCENDING" }],
    columns: [{ sourceColumnOffset: COL.PATTERN_TYPE, showTotals: true, sortOrder: "ASCENDING" }],
    values: [
      {
        summarizeFunction: "COUNTA",
        sourceColumnOffset: COL.GT_ID,
        name: "DPs",
      },
    ],
    criteria: {
      [COL.KIND]: { visibleValues: ["DP"] },
    },
    valueLayout: "HORIZONTAL",
  };

  // Pivot 2: Fixture × Kind, count of gt_id (no filter — shows DP, CE, retired_DP).
  const pivot2 = {
    rows: [{ sourceColumnOffset: COL.FIXTURE, showTotals: true, sortOrder: "ASCENDING" }],
    columns: [{ sourceColumnOffset: COL.KIND, showTotals: true, sortOrder: "ASCENDING" }],
    values: [
      {
        summarizeFunction: "COUNTA",
        sourceColumnOffset: COL.GT_ID,
        name: "Count",
      },
    ],
    valueLayout: "HORIZONTAL",
  };

  // Pivot 3: Pattern Type × Kind, count. Coverage map for the whole benchmark.
  // Makes it obvious where Disguised ad / Trick wording have active=0 with
  // retired>0 (the deliberate post-audit coverage gap).
  const pivot3 = {
    rows: [{ sourceColumnOffset: COL.PATTERN_TYPE, showTotals: true, sortOrder: "ASCENDING" }],
    columns: [{ sourceColumnOffset: COL.KIND, showTotals: true, sortOrder: "ASCENDING" }],
    values: [
      {
        summarizeFunction: "COUNTA",
        sourceColumnOffset: COL.GT_ID,
        name: "Count",
      },
    ],
    valueLayout: "HORIZONTAL",
  };

  // Anchor positions: leave generous gaps (each pivot can grow). All three
  // anchored in column A, stacked vertically. Rough sizing per pivot:
  //   Pivot 1: ~7 cols × ~10 rows. Anchor row 2.
  //   Pivot 2: ~5 cols × ~10 rows. Anchor row 25.
  //   Pivot 3: ~5 cols × ~12 rows. Anchor row 45.
  // Anchors are 0-indexed in the API; labels go one row above the anchor.

  const requests = [
    ...pivotRequest(
      pivotTabSheetId,
      { row: 1, col: 0 }, // pivot at A2, label at A1
      "Pivot 1 — Active DPs by Fixture × Pattern Type (replaces legacy Section 2)",
      pivot1,
      detailSheetId
    ),
    ...pivotRequest(
      pivotTabSheetId,
      { row: 24, col: 0 }, // pivot at A25, label at A24
      "Pivot 2 — All entries by Fixture × Kind (DP / CE / retired_DP)",
      pivot2,
      detailSheetId
    ),
    ...pivotRequest(
      pivotTabSheetId,
      { row: 44, col: 0 }, // pivot at A45, label at A44
      "Pivot 3 — Coverage map: Pattern Type × Kind (active=0 + retired>0 = post-audit gap)",
      pivot3,
      detailSheetId
    ),
  ];

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests },
  });
}

// -----------------------------------------------------------------------------

(async () => {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("GOOGLE_SHEET_ID env var required");

  console.log(`detail tab: ${DETAIL_TAB}`);
  console.log(`pivot tab: ${PIVOT_TAB}`);
  console.log(`prev commit for retired-DP detection: ${PREV_COMMIT}`);

  const current = loadCurrentFixtures();
  console.log(`current fixtures loaded: ${current.length} (${current.map((f) => f.slug).join(", ")})`);

  const preAudit = loadPreAuditFixtures(PREV_COMMIT);
  console.log(`pre-audit fixtures loaded from ${PREV_COMMIT}: ${preAudit.length}`);

  const detailRows = buildDetailRows(current, preAudit);
  const counts = detailRows.reduce((acc, r) => {
    acc[r[COL.KIND]] = (acc[r[COL.KIND]] || 0) + 1;
    return acc;
  }, {});
  console.log(`detail rows: ${detailRows.length} (${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")})`);

  const sheets = await getSheetsClient();

  // Cleanup: kill the v1 tab if it's still around.
  const removed = await deleteTabIfExists(sheets, sheetId, LEGACY_V1_TAB);
  if (removed) console.log(`removed legacy v1 tab "${LEGACY_V1_TAB}"`);

  // Detail tab.
  const detailSheetId = await ensureTab(sheets, sheetId, DETAIL_TAB, Math.max(200, detailRows.length + 20), HEADER.length + 1);
  await clearAllCells(sheets, sheetId, detailSheetId);
  await writeDetailTab(sheets, sheetId, detailSheetId, detailRows);
  console.log(`wrote ${detailRows.length} detail rows to "${DETAIL_TAB}"`);

  // Pivot tab.
  const pivotSheetId = await ensureTab(sheets, sheetId, PIVOT_TAB, 80, 18);
  await clearAllCells(sheets, sheetId, pivotSheetId);
  await buildPivotTab(sheets, sheetId, pivotSheetId, detailSheetId);
  console.log(`wrote 3 pivot tables to "${PIVOT_TAB}"`);

  console.log("done.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
