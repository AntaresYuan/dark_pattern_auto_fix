#!/usr/bin/env node

// Reads PLANNED domains and updates `fixture_status` to "planned" in sites.json.
// Idempotent: re-runs are a no-op if status is already "planned" or "built".
// Errors out if any planned domain isn't in sites.json or has an unexpected status.
//
// Source of truth for which domains are planned: hardcoded list below, kept in
// lockstep with benchmark/fixtures/PLAN.md.
//
// usage: node benchmark/scripts/mark-planned-fixtures.cjs

const fs = require("fs");
const path = require("path");

// Domains picked in PLAN.md (rows 1-5).
const PLANNED = [
  "booking.com",       // row 1 — booking-hotel-checkout
  "nytimes.com",       // row 2 — nytimes-article-paywall
  "netflix.com",       // row 3 — netflix-cancel-flow
  "facebook.com",      // row 4 — facebook-deactivation
  "paypal.com",        // row 5 — paypal-account-close
];

const ALLOWED_INCOMING = new Set(["not_started", "planned", "built"]);

function main() {
  const sitesPath = path.join(__dirname, "..", "sites.json");
  const sites = JSON.parse(fs.readFileSync(sitesPath, "utf8"));

  const byDomain = new Map(sites.sites.map((s) => [s.domain, s]));

  // Validate all planned domains are in sites.json.
  const missing = PLANNED.filter((d) => !byDomain.has(d));
  if (missing.length > 0) {
    console.error("ERROR: planned domains not in sites.json:");
    for (const d of missing) console.error(`  - ${d}`);
    process.exit(1);
  }

  let changed = 0;
  let alreadyPlanned = 0;
  let alreadyBuilt = 0;
  for (const d of PLANNED) {
    const s = byDomain.get(d);
    if (!ALLOWED_INCOMING.has(s.fixture_status)) {
      console.error(`ERROR: ${d} has unexpected fixture_status="${s.fixture_status}"`);
      process.exit(1);
    }
    if (s.fixture_status === "built") {
      alreadyBuilt++;
      continue; // don't downgrade built to planned
    }
    if (s.fixture_status === "planned") {
      alreadyPlanned++;
      continue;
    }
    s.fixture_status = "planned";
    changed++;
  }

  fs.writeFileSync(sitesPath, JSON.stringify(sites, null, 2) + "\n");

  console.log(`planned domains: ${PLANNED.length}`);
  console.log(`  changed (not_started → planned): ${changed}`);
  console.log(`  already planned:                 ${alreadyPlanned}`);
  console.log(`  already built:                   ${alreadyBuilt}`);
  console.log("");
  console.log("=== current fixture_status of planned domains ===");
  for (const d of PLANNED) {
    const s = byDomain.get(d);
    console.log(`  ${d.padEnd(20)} ${s.fixture_status}`);
  }
}

main();
