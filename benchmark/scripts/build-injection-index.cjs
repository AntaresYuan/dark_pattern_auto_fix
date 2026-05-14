#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DP_TYPE_SUFFIX_MAP = {
  "_disguised": "Disguised ad",
  "_false_hierarchy": "False hierarchy",
  "_preselect": "Preselection",
  "_pop_up": "Pop-up ad",
  "_double_neg_notif": "Trick wording",
  "_double_negative": "Trick wording",
  "_doube_negative": "Trick wording",
  "_confirm_notif": "Confirm shaming",
  "_confirm_shaming": "Confirm shaming",
  "_comfirm_shaming": "Confirm shaming",
  "_social": "Fake social proof",
  "_fake_social_proof": "Fake social proof",
  "_fake_social": "Fake social proof",
  "_forced_action": "Forced Action",
  "_hidden_information": "Hidden information",
};

const SITE_CODE_MAP = {
  "amz": "Amazon",
  "tgt": "Target",
  "cos": "Costco",
  "etp": "Expedia",
  "att": "AT&T",
  "ube": "Uber Eats",
  "eco": "Economist",
  "wgs": "Walgreens",
  "ude": "Udemy",
  "wfr": "Wayfair",
  "bki": "Booking.com",
  "ghd": "Greyhound",
  "dmn": "Domino's",
  "stm": "Steam",
  "eby": "eBay",
  "swt": "Southwest",
  "met": "The MET Store",
  "tkm": "Ticketmaster",
  "sbk": "Starbucks",
  "ult": "Ulta",
  "ups": "UPS",
  "nik": "Nike",
  "pst": "PlayStation",
  "nyt": "NYT",
  "any": "Generic/any-site",
  "macys": "Macy's",
  "ikea": "IKEA",
  "apple": "Apple",
  "stp": "Staples",
  "mds": "MoMA Design Store",
  "sth": "StubHub",
  "xbx": "Xbox",
  "brg": "Banana Republic",
  "ong": "Old Navy",
  "jpp": "JCPenney",
  "hrz": "Hertz",
  "uss": "USPS",
  "ddt": "Dunkin'",
  "hlt": "Hollister",
  "cpl": "Chipotle",
  "fde": "FedEx",
  "lum": "Lululemon",
  "del": "Dell",
  "nds": "Nordstrom",
  "bmd": "Bloomingdale's",
  "kfc": "KFC",
  "pzh": "Pizza Hut",
  "ylp": "Yelp",
  "acd": "Air Canada",
  "mct": "MicroCenter",
  "fdg": "Fandango",
  "ptb": "Pottery Barn",
  "srs": "Sears",
  "uniqle": "Uniqlo",
  "chickfila": "Chick-fil-A",
  "lego": "LEGO",
};

const KNOWN_CANONICAL_TYPES = new Set([
  "Disguised ad",
  "False hierarchy",
  "Preselection",
  "Pop-up ad",
  "Trick wording",
  "Confirm shaming",
  "Fake social proof",
  "Forced Action",
  "Hidden information",
]);

function parseArgs(argv) {
  const args = { source: null, output: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--source" && argv[i + 1]) {
      args.source = argv[++i];
    } else if (argv[i] === "--output" && argv[i + 1]) {
      args.output = argv[++i];
    }
  }
  if (!args.source) {
    console.error("usage: build-injection-index.js --source <path-to-injection-mapping.js> [--output <path>]");
    process.exit(2);
  }
  return args;
}

function splitKey(key) {
  // Longest-suffix match so "_double_neg_notif" wins over "_double_negative" etc.
  const suffixes = Object.keys(DP_TYPE_SUFFIX_MAP).sort((a, b) => b.length - a.length);

  // Pass 1: key ENDS with a DP suffix -> site_code is the prefix.
  for (const suffix of suffixes) {
    if (key.endsWith(suffix)) {
      const siteCode = key.slice(0, -suffix.length);
      const dpTypeRaw = suffix.slice(1);
      return {
        siteCode,
        dpTypeRaw,
        dpTypeCanonical: DP_TYPE_SUFFIX_MAP[suffix],
        discriminator: null,
      };
    }
  }

  // Pass 2: DP suffix appears in the MIDDLE, followed by an underscore + discriminator.
  // Example: "apple_preselect_final_cut_pro" -> site=apple, dp=_preselect, disc=final_cut_pro.
  for (const suffix of suffixes) {
    const needle = suffix + "_";
    const idx = key.indexOf(needle);
    if (idx > 0) {
      const siteCode = key.slice(0, idx);
      const discriminator = key.slice(idx + needle.length);
      const dpTypeRaw = suffix.slice(1);
      return {
        siteCode,
        dpTypeRaw,
        dpTypeCanonical: DP_TYPE_SUFFIX_MAP[suffix],
        discriminator,
      };
    }
  }

  return null;
}

function build(sourcePath) {
  const text = fs.readFileSync(sourcePath, "utf8");
  const lines = text.split("\n");
  const totalLines = lines.length;

  // 1. Find every line matching `^  "<key>":\s*{` (top-level keys of injectionMapping).
  const keyRe = /^  "([a-zA-Z_0-9]+)":\s*\{/;
  const keyHits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(keyRe);
    if (m) keyHits.push({ key: m[1], lineStart: i + 1 });
  }

  // 2. Find the closing `};` of injectionMapping so the last entry has a defined line_end.
  // injectionMapping starts at the line containing `const injectionMapping = {`.
  let mapStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^const injectionMapping\s*=\s*\{/.test(lines[i])) {
      mapStart = i + 1;
      break;
    }
  }
  if (mapStart === -1) {
    throw new Error("Could not find `const injectionMapping = {` in source.");
  }
  let mapEnd = -1;
  for (let i = lines.length - 1; i >= mapStart; i--) {
    if (/^\};?\s*$/.test(lines[i])) {
      mapEnd = i + 1;
      break;
    }
  }
  if (mapEnd === -1) {
    throw new Error("Could not find closing `};` of injectionMapping.");
  }

  // 3. Assemble entries with line ranges.
  const entries = [];
  const warnings = [];
  for (let i = 0; i < keyHits.length; i++) {
    const { key, lineStart } = keyHits[i];
    const lineEnd = i + 1 < keyHits.length ? keyHits[i + 1].lineStart - 1 : mapEnd - 1;
    const split = splitKey(key);
    if (!split) {
      warnings.push({ key, reason: "no DP-type suffix matched" });
      continue;
    }
    const { siteCode, dpTypeRaw, dpTypeCanonical, discriminator } = split;
    const siteName = SITE_CODE_MAP[siteCode] || null;
    if (!siteName) warnings.push({ key, reason: `unknown site code '${siteCode}'` });
    if (!KNOWN_CANONICAL_TYPES.has(dpTypeCanonical)) {
      warnings.push({ key, reason: `non-canonical dp type '${dpTypeCanonical}'` });
    }
    entries.push({
      key,
      site_code: siteCode,
      site_name: siteName || siteCode,
      dp_type_raw: dpTypeRaw,
      dp_type_canonical: dpTypeCanonical,
      discriminator: discriminator || null,
      line_start: lineStart,
      line_end: lineEnd,
    });
  }

  // 4. Validate non-overlap.
  const sorted = [...entries].sort((a, b) => a.line_start - b.line_start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].line_start <= sorted[i - 1].line_end) {
      throw new Error(
        `Overlap: ${sorted[i - 1].key} (${sorted[i - 1].line_start}-${sorted[i - 1].line_end}) and ${sorted[i].key} (${sorted[i].line_start}-${sorted[i].line_end})`
      );
    }
  }

  // 5. Build reverse indexes.
  const bySite = {};
  const byDpType = {};
  for (const e of entries) {
    if (!bySite[e.site_code]) bySite[e.site_code] = [];
    bySite[e.site_code].push(e.key);
    if (!byDpType[e.dp_type_canonical]) byDpType[e.dp_type_canonical] = [];
    byDpType[e.dp_type_canonical].push(e.key);
  }

  return {
    source_file: sourcePath,
    total_lines: totalLines,
    entries_count: entries.length,
    dp_type_suffix_map: DP_TYPE_SUFFIX_MAP,
    site_code_map: SITE_CODE_MAP,
    entries,
    by_site: bySite,
    by_dp_type: byDpType,
    warnings,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const outPath =
    args.output ||
    path.join(__dirname, "..", "injection-mapping-index.json");

  const index = build(args.source);

  fs.writeFileSync(outPath, JSON.stringify(index, null, 2) + "\n");

  // Summary to stdout.
  console.log(`source:       ${index.source_file}`);
  console.log(`total_lines:  ${index.total_lines}`);
  console.log(`entries:      ${index.entries_count}`);
  console.log(`sites:        ${Object.keys(index.by_site).length}`);
  console.log(`dp_types:     ${Object.keys(index.by_dp_type).length}`);
  if (index.warnings.length) {
    console.log(`warnings:     ${index.warnings.length}`);
    for (const w of index.warnings) console.log(`  - ${w.key}: ${w.reason}`);
  } else {
    console.log("warnings:     0");
  }
  console.log(`wrote:        ${outPath}`);
}

main();
