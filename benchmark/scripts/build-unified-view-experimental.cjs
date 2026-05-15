#!/usr/bin/env node

// EXPERIMENTAL: writes a single "Unified View (experimental)" tab to the sheet
// for evaluation. If accepted, this design replaces the current 2-tab split
// (Section 2 fixture-summary + Synthetic DP Detail) with one tab where:
//
//   - Top section is a formula-driven summary (per-fixture × per-type matrix)
//     that recomputes from the detail rows below — single source of truth.
//   - Bottom section is one row per gt_id, with a `Kind` column that takes
//     three values: DP (active), CE (counterexample), retired_DP (was a DP
//     before the audit; now reclassified as not-canonical, kept for transparency
//     and as a baseline signal for the model).
//
// Retired DPs are loaded from a previous git commit specified by env var
// PREV_COMMIT (defaults to the commit just before the realism audit).
//
// This script does NOT modify the existing tabs. It only adds/overwrites the
// "Unified View (experimental)" tab. Safe to run repeatedly.
//
// Usage (local):
//   GOOGLE_APPLICATION_CREDENTIALS=~/secrets/sa.json \
//   GOOGLE_SHEET_ID=13cTuwoeSVGYhcqd0RDKxKvyWBlyhd6X5zNx32Bx6q2A \
//   node benchmark/scripts/build-unified-view-experimental.cjs
//
// Usage (CI): triggered manually via .github/workflows/build-unified-view.yml.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { google } = require("googleapis");

const TAB_NAME = "Unified View (experimental)";
const PREV_COMMIT = process.env.PREV_COMMIT || "8b9ecb9";

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

const HEADER = [
  "Fixture",
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

function shorten(s, max) {
  if (!s) return "";
  const cleaned = String(s).replace(/\s+/g, " ").trim();
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max - 1) + "…";
}

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
  const slugs = fs.readdirSync(fixturesDir).filter((n) => fs.statSync(path.join(fixturesDir, n)).isDirectory()).sort();
  const out = [];
  for (const slug of slugs) {
    const relPath = `benchmark/fixtures/${slug}/ground-truth.json`;
    try {
      const raw = execSync(`git show ${commit}:${relPath}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      out.push({ slug, gt: JSON.parse(raw) });
    } catch (err) {
      console.warn(`warn: could not read ${slug} at ${commit} — skipping retired-DP detection for it: ${err.message}`);
    }
  }
  return out;
}

function buildDetailRows(currentFixtures, preAuditFixtures) {
  const rows = [];
  const preBySlug = new Map(preAuditFixtures.map((f) => [f.slug, f]));

  for (const { slug, gt } of currentFixtures) {
    const sourceRel = `benchmark/fixtures/${slug}/ground-truth.json`;

    // Active DPs
    for (const dp of gt.dark_patterns || []) {
      rows.push([
        slug,
        "DP",
        dp.type || "",
        dp.gt_id,
        shorten(dp.element, 800),
        shorten(dp.why, 2000),
        shorten(dp.selector, 400),
        Array.isArray(dp.accepts_types) ? dp.accepts_types.join(", ") : (dp.accepts_types || ""),
        "active",
        sourceRel,
      ]);
    }

    // Counterexamples
    for (const ce of gt.counterexamples || []) {
      rows.push([
        slug,
        "CE",
        ce.looks_like || "",
        ce.gt_id,
        shorten(ce.element, 800),
        shorten(ce.why_not, 2000),
        shorten(ce.selector, 400),
        "",
        "active",
        sourceRel,
      ]);
    }

    // Retired DPs: present in pre-audit but not in current
    const pre = preBySlug.get(slug);
    if (pre) {
      const currentDpIds = new Set((gt.dark_patterns || []).map((d) => d.gt_id));
      for (const oldDp of pre.gt.dark_patterns || []) {
        if (currentDpIds.has(oldDp.gt_id)) continue;
        rows.push([
          slug,
          "retired_DP",
          oldDp.type || "",
          oldDp.gt_id,
          shorten(oldDp.element, 800),
          shorten(oldDp.why, 2000),
          shorten(oldDp.selector, 400),
          Array.isArray(oldDp.accepts_types) ? oldDp.accepts_types.join(", ") : (oldDp.accepts_types || ""),
          `retired_2026-05-15 (PR #28, see #27)`,
          sourceRel,
        ]);
      }
    }
  }

  // Stable sort: by fixture, then by Kind order (DP < CE < retired_DP), then gt_id
  const kindOrder = { DP: 0, CE: 1, retired_DP: 2 };
  rows.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return kindOrder[a[1]] - kindOrder[b[1]];
    return a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0;
  });

  return rows;
}

// Build the top summary block — formula-driven so it stays in sync as detail
// rows are edited. detailStartRow is the 1-indexed row where the data table
// (header) begins.
function buildSummaryBlock(currentFixtures, detailHeaderRow1) {
  const dataFirstRow = detailHeaderRow1 + 1;
  const dataLastRow = 5000; // arbitrary large bound — sheet API is fine with this
  const fixtureCol = "A"; // column A in the detail block
  const kindCol = "B";
  const typeCol = "C";

  const rows = [];

  // Title row
  rows.push(["Realism audit — unified view (experimental)", "", "", "", "", "", "", "", "", ""]);
  rows.push([`Source of truth: rows ${dataFirstRow}+ below. Summary recomputes from those rows. Edit detail, not summary.`, "", "", "", "", "", "", "", "", ""]);
  rows.push([]);

  // Per-fixture summary header
  rows.push(["Per-fixture summary", "", "", "", "", "", "", "", "", ""]);
  rows.push(["Fixture", "Active DPs", "Retired DPs", "CEs", "Total entries", "", "", "", "", ""]);
  for (const { slug } of currentFixtures) {
    rows.push([
      slug,
      `=COUNTIFS(${fixtureCol}${dataFirstRow}:${fixtureCol}${dataLastRow},"${slug}",${kindCol}${dataFirstRow}:${kindCol}${dataLastRow},"DP")`,
      `=COUNTIFS(${fixtureCol}${dataFirstRow}:${fixtureCol}${dataLastRow},"${slug}",${kindCol}${dataFirstRow}:${kindCol}${dataLastRow},"retired_DP")`,
      `=COUNTIFS(${fixtureCol}${dataFirstRow}:${fixtureCol}${dataLastRow},"${slug}",${kindCol}${dataFirstRow}:${kindCol}${dataLastRow},"CE")`,
      `=COUNTIF(${fixtureCol}${dataFirstRow}:${fixtureCol}${dataLastRow},"${slug}")`,
      "", "", "", "", "",
    ]);
  }
  // Totals row
  rows.push([
    "TOTAL",
    `=COUNTIF(${kindCol}${dataFirstRow}:${kindCol}${dataLastRow},"DP")`,
    `=COUNTIF(${kindCol}${dataFirstRow}:${kindCol}${dataLastRow},"retired_DP")`,
    `=COUNTIF(${kindCol}${dataFirstRow}:${kindCol}${dataLastRow},"CE")`,
    `=COUNTA(${fixtureCol}${dataFirstRow}:${fixtureCol}${dataLastRow})`,
    "", "", "", "", "",
  ]);
  rows.push([]);

  // Per-type coverage matrix
  rows.push(["Per-type coverage (active DPs only)", "", "", "", "", "", "", "", "", ""]);
  rows.push(["Pattern Type", "Active count", "Retired count", "Net change", "", "", "", "", "", ""]);
  for (const t of DP_TYPES) {
    rows.push([
      t,
      `=COUNTIFS(${kindCol}${dataFirstRow}:${kindCol}${dataLastRow},"DP",${typeCol}${dataFirstRow}:${typeCol}${dataLastRow},"${t}")`,
      `=COUNTIFS(${kindCol}${dataFirstRow}:${kindCol}${dataLastRow},"retired_DP",${typeCol}${dataFirstRow}:${typeCol}${dataLastRow},"${t}")`,
      `=B${rows.length + 1}-C${rows.length + 1}`,
      "", "", "", "", "", "",
    ]);
  }
  rows.push([]);

  return rows;
}

// -------- Sheet I/O ---------------------------------------------------------

async function ensureTab(sheets, sheetId, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const existing = meta.data.sheets.find((s) => s.properties.title === title);
  if (existing) {
    return existing.properties.sheetId;
  }
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title, gridProperties: { rowCount: 200, columnCount: 12 } } } }],
    },
  });
  return res.data.replies[0].addSheet.properties.sheetId;
}

async function clearTab(sheets, sheetId, title) {
  await sheets.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: `${title}!A1:Z5000`,
  });
}

async function writeAll(sheets, sheetId, title, rows) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${title}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });
}

async function applyFormatting(sheets, sheetId, tabSheetId, summaryRowCount, detailHeaderRow1) {
  // Freeze the rows above + including the detail header so they always show.
  // Bold the title + section headers + detail header.
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: { sheetId: tabSheetId, gridProperties: { frozenRowCount: detailHeaderRow1 } },
            fields: "gridProperties.frozenRowCount",
          },
        },
        {
          repeatCell: {
            range: { sheetId: tabSheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 13 } } },
            fields: "userEnteredFormat.textFormat",
          },
        },
        {
          repeatCell: {
            range: { sheetId: tabSheetId, startRowIndex: detailHeaderRow1 - 1, endRowIndex: detailHeaderRow1 },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true },
                backgroundColor: { red: 0.93, green: 0.93, blue: 0.93 },
              },
            },
            fields: "userEnteredFormat(textFormat,backgroundColor)",
          },
        },
        // Set reasonable column widths
        {
          updateDimensionProperties: {
            range: { sheetId: tabSheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
            properties: { pixelSize: 200 },
            fields: "pixelSize",
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId: tabSheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 2 },
            properties: { pixelSize: 90 },
            fields: "pixelSize",
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId: tabSheetId, dimension: "COLUMNS", startIndex: 2, endIndex: 3 },
            properties: { pixelSize: 140 },
            fields: "pixelSize",
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId: tabSheetId, dimension: "COLUMNS", startIndex: 3, endIndex: 4 },
            properties: { pixelSize: 200 },
            fields: "pixelSize",
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId: tabSheetId, dimension: "COLUMNS", startIndex: 4, endIndex: 5 },
            properties: { pixelSize: 350 },
            fields: "pixelSize",
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId: tabSheetId, dimension: "COLUMNS", startIndex: 5, endIndex: 6 },
            properties: { pixelSize: 500 },
            fields: "pixelSize",
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId: tabSheetId, dimension: "COLUMNS", startIndex: 6, endIndex: 7 },
            properties: { pixelSize: 220 },
            fields: "pixelSize",
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId: tabSheetId, dimension: "COLUMNS", startIndex: 7, endIndex: 8 },
            properties: { pixelSize: 160 },
            fields: "pixelSize",
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId: tabSheetId, dimension: "COLUMNS", startIndex: 8, endIndex: 9 },
            properties: { pixelSize: 230 },
            fields: "pixelSize",
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId: tabSheetId, dimension: "COLUMNS", startIndex: 9, endIndex: 10 },
            properties: { pixelSize: 320 },
            fields: "pixelSize",
          },
        },
        // Wrap text on the long columns (Element, Why)
        {
          repeatCell: {
            range: { sheetId: tabSheetId, startRowIndex: detailHeaderRow1, startColumnIndex: 4, endColumnIndex: 6 },
            cell: { userEnteredFormat: { wrapStrategy: "WRAP", verticalAlignment: "TOP" } },
            fields: "userEnteredFormat(wrapStrategy,verticalAlignment)",
          },
        },
      ],
    },
  });
}

// -----------------------------------------------------------------------------

(async () => {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("GOOGLE_SHEET_ID env var required");

  console.log(`tab: ${TAB_NAME}`);
  console.log(`prev commit for retired-DP detection: ${PREV_COMMIT}`);

  const current = loadCurrentFixtures();
  console.log(`current fixtures loaded: ${current.length} (${current.map((f) => f.slug).join(", ")})`);

  const preAudit = loadPreAuditFixtures(PREV_COMMIT);
  console.log(`pre-audit fixtures loaded from ${PREV_COMMIT}: ${preAudit.length}`);

  const detailRows = buildDetailRows(current, preAudit);
  const counts = detailRows.reduce(
    (acc, r) => {
      acc[r[1]] = (acc[r[1]] || 0) + 1;
      return acc;
    },
    {}
  );
  console.log(`detail rows: ${detailRows.length} (${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")})`);

  // Build summary block first to know detail header row position.
  const summaryRows = buildSummaryBlock(current, /* detailHeaderRow1 */ -1);
  const detailHeaderRow1 = summaryRows.length + 1; // 1-indexed
  const summaryWithRefs = buildSummaryBlock(current, detailHeaderRow1);

  const allRows = [
    ...summaryWithRefs,
    HEADER,
    ...detailRows,
  ];

  console.log(`total rows to write: ${allRows.length} (summary=${summaryWithRefs.length}, header=1, detail=${detailRows.length})`);

  const sheets = await getSheetsClient();
  const tabSheetId = await ensureTab(sheets, sheetId, TAB_NAME);
  await clearTab(sheets, sheetId, TAB_NAME);
  await writeAll(sheets, sheetId, TAB_NAME, allRows);
  await applyFormatting(sheets, sheetId, tabSheetId, summaryWithRefs.length, detailHeaderRow1);

  console.log(`done. open the sheet — new tab is "${TAB_NAME}".`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
