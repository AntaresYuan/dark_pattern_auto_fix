#!/usr/bin/env node

// Reads every benchmark/fixtures/<slug>/ground-truth.json and pushes:
//
//   1. ONE summary row per fixture into the existing "Section 2" table
//      (header: dp_id | Website | Dark Pattern Count | <one column per DP type>).
//      The script REPLACES rows by dp_id (idempotent — re-running on a fixture
//      updates its row in place rather than appending duplicates).
//
//   2. ONE detail row per DP and per CE into the "Synthetic DP Detail" tab
//      (header: Pattern String | Comment | Pattern Category | Pattern Type |
//      Where in website? | Deceptive? | Website Page | Kind | gt_id | source).
//      Replaces rows by gt_id (composite: <fixture_slug>::<gt_id>).
//
// Auth: Google service account JSON. Two ways to provide:
//
//   1. Env var GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json (the standard).
//   2. Env var GOOGLE_SHEET_SERVICE_ACCOUNT_JSON containing the JSON string
//      verbatim. This is what the GitHub Actions workflow uses (the secret
//      is injected into the env, never written to disk).
//
// Sheet to target: env GOOGLE_SHEET_ID (the long ID in the docs URL).
//
// Setup checklist for the human (one-time): see benchmark/scripts/SHEET-SETUP.md
//
// Local usage:
//   GOOGLE_APPLICATION_CREDENTIALS=~/secrets/sa.json \
//   GOOGLE_SHEET_ID=13cTuwoeSVGYhcqd0RDKxKvyWBlyhd6X5zNx32Bx6q2A \
//   node benchmark/scripts/sync-to-sheet.cjs

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

// ------- Mapping our 9-type schema -> sheet's Section 2 column names ----------
// Section 2 header (after the "Double negative" -> "Trick wording" rename you made):
//   dp_id | Website | Dark Pattern Count | Disguised ad | False hierarchy |
//   Preselection | Pop-up ad | Trick wording | Confirm shaming |
//   Fake social proof | Forced Action | Hidden information
const SUMMARY_TYPE_COLUMNS = [
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

// ------- Mapping our 9-type schema -> Mathur 2019 categories ------------------
// Used for the "Pattern Category" column in the detail tab so synthetic rows
// classify alongside Section 1's real-observation rows.
const TYPE_TO_MATHUR_CATEGORY = {
  "Disguised ad": "Misdirection",
  "False hierarchy": "Misdirection",
  "Preselection": "Sneaking",
  "Pop-up ad": "Misdirection",
  "Trick wording": "Misdirection",
  "Confirm shaming": "Misdirection",
  "Fake social proof": "Social Proof",
  "Forced Action": "Forced Action",
  "Hidden information": "Sneaking",
};

const SECTION_2_HEADER = [
  "dp_id",
  "Website",
  "Dark Pattern Count",
  ...SUMMARY_TYPE_COLUMNS,
];

const DETAIL_HEADER = [
  "Pattern String",
  "Comment",
  "Pattern Category",
  "Pattern Type",
  "Where in website?",
  "Deceptive?",
  "Website Page",
  "Kind",
  "gt_id",
  "source",
];

// Default sheet/tab names. The script auto-detects which tab Section 2 lives in
// by searching for "dp_id" in column A; the detail tab is matched by name below.
const DETAIL_TAB_NAME = "Synthetic DP Detail";

// -----------------------------------------------------------------------------

function loadCredentials() {
  if (process.env.GOOGLE_SHEET_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_SHEET_SERVICE_ACCOUNT_JSON);
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
  }
  throw new Error(
    "no credentials. Set GOOGLE_SHEET_SERVICE_ACCOUNT_JSON (env, JSON contents) " +
      "or GOOGLE_APPLICATION_CREDENTIALS (env, path to JSON file)."
  );
}

async function getSheetsClient() {
  const credentials = loadCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth: await auth.getClient() });
}

// -------- Fixture loading -----------------------------------------------------

function loadFixtures() {
  const fixturesDir = path.join(__dirname, "..", "fixtures");
  // Sort slugs for deterministic append order across runs.
  const slugs = fs
    .readdirSync(fixturesDir)
    .filter((name) => fs.statSync(path.join(fixturesDir, name)).isDirectory())
    .sort();

  const fixtures = [];
  for (const slug of slugs) {
    const gtPath = path.join(fixturesDir, slug, "ground-truth.json");
    if (!fs.existsSync(gtPath)) continue;
    const gt = JSON.parse(fs.readFileSync(gtPath, "utf8"));
    fixtures.push({ slug, ground_truth: gt, gt_path_rel: path.posix.join("benchmark/fixtures", slug, "ground-truth.json") });
  }
  return fixtures;
}

// Convert 1-based column index to A1 letters (1->A, 26->Z, 27->AA, 28->AB, ...).
// `String.fromCharCode(64 + n)` only works up to Z; this is the safe version.
function colToA1(n) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function assertNoDoubleColon(s, kind) {
  if (typeof s === "string" && s.includes("::")) {
    throw new Error(`${kind} contains '::' which collides with the composite gt_id separator: ${s}`);
  }
}

// -------- Row construction ---------------------------------------------------

function buildSummaryRow(fixture) {
  const gt = fixture.ground_truth;
  const dps = gt.dark_patterns || [];

  // Initialize per-type counts.
  const counts = Object.fromEntries(SUMMARY_TYPE_COLUMNS.map((t) => [t, 0]));
  for (const dp of dps) {
    if (dp.type in counts) counts[dp.type]++;
  }

  return [
    fixture.slug, // dp_id
    gt.mimicked_site || gt.fixture || fixture.slug, // Website
    dps.length, // Dark Pattern Count
    ...SUMMARY_TYPE_COLUMNS.map((t) => counts[t] || 0),
  ];
}

// Sheets cells handle 50k chars; reviewer noted 200/300 truncation lost the second
// half of most `why` explanations. Bumped to 2000 for `element` and 5000 for `why`.
function shortenForCell(s, max) {
  if (!s) return "";
  const cleaned = s.replace(/\s+/g, " ").trim();
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max - 1) + "…";
}

function buildDetailRows(fixture) {
  const gt = fixture.ground_truth;
  const fixtureUrlRel = `benchmark/fixtures/${fixture.slug}/${fixture.slug}.html`;
  const where = gt.page_type || gt.expected_page_evaluation?.page_type || fixture.slug;

  assertNoDoubleColon(fixture.slug, "fixture slug");

  const rows = [];
  for (const dp of gt.dark_patterns || []) {
    assertNoDoubleColon(dp.gt_id, `dp.gt_id (in fixture ${fixture.slug})`);
    rows.push([
      shortenForCell(dp.element, 2000),                     // Pattern String
      shortenForCell(dp.why, 5000),                         // Comment
      TYPE_TO_MATHUR_CATEGORY[dp.type] || "",               // Pattern Category
      dp.type,                                              // Pattern Type
      where,                                                // Where in website?
      "Yes",                                                // Deceptive?
      fixtureUrlRel,                                        // Website Page
      "DP",                                                 // Kind
      `${fixture.slug}::${dp.gt_id}`,                       // gt_id (composite)
      fixture.gt_path_rel,                                  // source
    ]);
  }
  for (const ce of gt.counterexamples || []) {
    assertNoDoubleColon(ce.gt_id, `ce.gt_id (in fixture ${fixture.slug})`);
    rows.push([
      shortenForCell(ce.element, 2000),
      shortenForCell(ce.why_not, 5000),
      TYPE_TO_MATHUR_CATEGORY[ce.looks_like] || "",
      ce.looks_like || "",
      where,
      "No",
      fixtureUrlRel,
      "CE",
      `${fixture.slug}::${ce.gt_id}`,
      fixture.gt_path_rel,
    ]);
  }
  return rows;
}

// -------- Sheet I/O ---------------------------------------------------------

async function listTabs(sheets, sheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  return meta.data.sheets.map((s) => ({
    title: s.properties.title,
    sheetId: s.properties.sheetId,
    rowCount: s.properties.gridProperties.rowCount,
    colCount: s.properties.gridProperties.columnCount,
  }));
}

// Find which tab contains Section 2 by searching col A for "dp_id" header.
// Tolerant of leading/trailing whitespace and case.
async function findSection2Location(sheets, sheetId, tabs) {
  for (const tab of tabs) {
    const range = `${tab.title}!A1:A${tab.rowCount}`;
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
    const colA = (res.data.values || []).flat();
    const headerRow = colA.findIndex(
      (v) => typeof v === "string" && v.trim().toLowerCase() === "dp_id"
    );
    if (headerRow !== -1) {
      return { tab: tab.title, headerRow1: headerRow + 1 }; // 1-indexed
    }
  }
  throw new Error(
    "Could not find Section 2 header (a row with 'dp_id' in column A) in any tab. " +
      "Make sure the new fixture-summary section exists with that exact header in column A " +
      "(case-insensitive; whitespace OK)."
  );
}

// Read col A under Section 2's header. Returns:
//   - existing: Map<dp_id, rowIndex1based>
//   - nextEmptyRow1: the first row after the last filled dp_id row (where to append).
// We compute nextEmptyRow explicitly instead of relying on Sheets API `append` —
// `append` finds the end of the *enclosing table*, which can be wrong when
// Section 1 sits above Section 2 in the same tab.
async function readSection2State(sheets, sheetId, location) {
  const range = `${location.tab}!A${location.headerRow1 + 1}:A`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  const rows = res.data.values || [];

  const existing = new Map();
  let lastFilledOffset = -1; // offset within rows[] of the last non-empty dp_id
  rows.forEach((r, i) => {
    const v = r[0];
    if (v === undefined || v === null || v === "") return;
    if (existing.has(v)) {
      console.warn(
        `WARN: duplicate dp_id "${v}" in Section 2 — script will only update the FIRST occurrence.`
      );
      return;
    }
    existing.set(v, location.headerRow1 + 1 + i);
    lastFilledOffset = i;
  });

  const nextEmptyRow1 = location.headerRow1 + 1 + lastFilledOffset + 1;
  return { existing, nextEmptyRow1 };
}

async function writeRow(sheets, sheetId, tab, row1based, row, columnCount) {
  const lastCol = colToA1(columnCount);
  const range = `${tab}!A${row1based}:${lastCol}${row1based}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

// Explicit-row append: writes `rows` starting at `startRow1`. Required when
// Section 2 lives below Section 1 in the same tab — Sheets API `append`
// would mis-target the end of Section 1's table.
async function writeRowsAt(sheets, sheetId, tab, startRow1, rows, columnCount) {
  if (rows.length === 0) return;
  const endRow1 = startRow1 + rows.length - 1;
  const lastCol = colToA1(columnCount);
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${tab}!A${startRow1}:${lastCol}${endRow1}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });
}

// For tabs we own end-to-end (the auto-created detail tab), `append` is safe.
async function appendRows(sheets, sheetId, tab, rows, columnCount) {
  if (rows.length === 0) return;
  const lastCol = colToA1(columnCount);
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${tab}!A1:${lastCol}1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });
}

async function ensureDetailTab(sheets, sheetId, tabs) {
  const existing = tabs.find((t) => t.title === DETAIL_TAB_NAME);
  if (existing) return existing;

  // Create the tab + write the header.
  const addRes = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: DETAIL_TAB_NAME } } }],
    },
  });
  const newTab = addRes.data.replies[0].addSheet.properties;
  console.log(`created tab "${DETAIL_TAB_NAME}"`);

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${DETAIL_TAB_NAME}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [DETAIL_HEADER] },
  });
  return { title: newTab.title, sheetId: newTab.sheetId, rowCount: 1, colCount: DETAIL_HEADER.length };
}

async function readExistingDetailGtIds(sheets, sheetId) {
  // gt_id (composite) is column I (index 9). Read from row 2.
  const range = `${DETAIL_TAB_NAME}!I2:I`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  const values = (res.data.values || []).map((r) => r[0]).filter(Boolean);
  const map = new Map();
  values.forEach((v, i) => map.set(v, 2 + i));
  return map;
}

// -------- Main flow ---------------------------------------------------------

async function main() {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("set GOOGLE_SHEET_ID env (the long ID from the sheet URL).");

  const sheets = await getSheetsClient();
  const fixtures = loadFixtures();
  console.log(`fixtures loaded: ${fixtures.length} (${fixtures.map((f) => f.slug).join(", ")})`);

  const tabs = await listTabs(sheets, sheetId);
  console.log(`tabs in sheet: ${tabs.map((t) => t.title).join(", ")}`);

  // ---- Section 2 (per-fixture summary) --------------------------------------
  const section2 = await findSection2Location(sheets, sheetId, tabs);
  console.log(`Section 2 found in tab "${section2.tab}", header at row ${section2.headerRow1}`);

  const { existing: existingSummary, nextEmptyRow1 } = await readSection2State(sheets, sheetId, section2);
  const newSummaryRows = [];
  let summaryUpdated = 0;
  for (const fixture of fixtures) {
    const row = buildSummaryRow(fixture);
    if (existingSummary.has(fixture.slug)) {
      await writeRow(sheets, sheetId, section2.tab, existingSummary.get(fixture.slug), row, SECTION_2_HEADER.length);
      summaryUpdated++;
    } else {
      newSummaryRows.push(row);
    }
  }
  if (newSummaryRows.length > 0) {
    // Use explicit-row write (not append) — Section 2 may live below Section 1
    // in the same tab; Sheets API append would mis-target the wrong table.
    await writeRowsAt(sheets, sheetId, section2.tab, nextEmptyRow1, newSummaryRows, SECTION_2_HEADER.length);
  }
  console.log(`Section 2: ${summaryUpdated} updated, ${newSummaryRows.length} appended at row ${nextEmptyRow1}`);

  // ---- Detail tab (per-DP + per-CE) -----------------------------------------
  await ensureDetailTab(sheets, sheetId, tabs);
  const existingDetail = await readExistingDetailGtIds(sheets, sheetId);

  let detailUpdated = 0;
  const newDetailRows = [];
  for (const fixture of fixtures) {
    for (const row of buildDetailRows(fixture)) {
      const compositeId = row[8]; // gt_id column
      if (existingDetail.has(compositeId)) {
        await writeRow(sheets, sheetId, DETAIL_TAB_NAME, existingDetail.get(compositeId), row, DETAIL_HEADER.length);
        detailUpdated++;
      } else {
        newDetailRows.push(row);
      }
    }
  }
  if (newDetailRows.length > 0) {
    await appendRows(sheets, sheetId, DETAIL_TAB_NAME, newDetailRows, DETAIL_HEADER.length);
  }
  console.log(`Detail tab: ${detailUpdated} updated, ${newDetailRows.length} appended`);

  console.log("done.");
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
