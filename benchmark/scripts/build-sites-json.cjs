#!/usr/bin/env node

// Reads a Tranco CSV snapshot and writes benchmark/sites.json — the top 100
// consumer-facing web domains, after filtering out CDNs / API hosts / ad
// networks / DNS / payment rails / link shorteners / pure-backend infra.
//
// usage:
//   node benchmark/scripts/build-sites-json.cjs \
//     --source benchmark/data/tranco-6G8PX-2026-05-14-top-300.csv \
//     [--output benchmark/sites.json] \
//     [--count 100]

const fs = require("fs");
const path = require("path");

// --- Drop rules (everything that's NOT a consumer-facing UI) -----------------

// Drop a domain if any of these regexes match its full hostname.
const DENY_PATTERNS = [
  // CDNs / edge / acceleration
  /(^|\.)cloudfront\.net$/,
  /(^|\.)akamai/,
  /(^|\.)akadns\.net$/,
  /(^|\.)fastly\.net$/,
  /(^|\.)fastly-edge\.com$/,
  /(^|\.)akamaized\.net$/,
  /(^|\.)akamaitech\.net$/,
  /(^|\.)akamaiedge\.net$/,
  /(^|\.)akam\.net$/,
  /(^|\.)googleusercontent\.com$/,
  /(^|\.)googlevideo\.com$/,
  /(^|\.)ggpht\.com$/,
  /(^|\.)gstatic\.com$/,
  /(^|\.)edgekey\.net$/,
  /(^|\.)edgesuite\.net$/,
  /(^|\.)cdn(77|gslb|instagram|-apple|-?77\.org)?\..*$/,
  /(^|\.)b-cdn\.net$/,
  /(^|\.)cdninstagram\.com$/,
  /(^|\.)cdngslb\.com$/,
  /(^|\.)cdn77\.org$/,
  /(^|\.)cdn-apple\.com$/,
  /(^|\.)tiktokcdn(-us)?\.com$/,
  /(^|\.)bytefcdn-oversea\.com$/,
  /(^|\.)ksyuncdn\.com$/,
  /(^|\.)trbcdn\.net$/,
  /(^|\.)vedcdnlb\.com$/,
  /(^|\.)vecdnlb\.com$/,
  /(^|\.)pv-cdn\.net$/,
  /(^|\.)okcdn\.ru$/,
  /(^|\.)yccdn\.ru$/,
  /(^|\.)azureedge\.net$/,
  /(^|\.)azurefd\.net$/,
  /(^|\.)azurewebsites\.net$/,
  /(^|\.)msedge\.net$/,
  /(^|\.)spo-msedge\.net$/,
  /(^|\.)spov-msedge\.net$/,
  /(^|\.)wac-msedge\.net$/,
  /(^|\.)ax-msedge\.net$/,
  /(^|\.)tm-azurefd\.net$/,
  /(^|\.)cloudflare\.net$/,
  /(^|\.)cloudflare-dns\.com$/,
  /(^|\.)trafficmanager\.net$/,
  /(^|\.)fbcdn\.net$/,
  /(^|\.)mzstatic\.com$/,
  /(^|\.)aaplimg\.com$/,
  /(^|\.)gvt[12]\.com$/,
  /(^|\.)nflxso\.net$/,
  /(^|\.)ttvnw\.net$/,
  /(^|\.)ytimg\.com$/,
  /(^|\.)tiktokv\.com$/,
  /(^|\.)hicloudcam\.com$/,
  /(^|\.)ezviz7\.com$/,
  /(^|\.)ttdns2\.com$/,
  /(^|\.)shifen\.com$/,
  /(^|\.)jsdelivr\.net$/,
  /(^|\.)heytapmobile\.com$/,
  /(^|\.)samsungcloud\.com$/,
  /(^|\.)libp2p\.direct$/,
  /(^|\.)pages\.dev$/,
  /(^|\.)workers\.dev$/,
  /(^|\.)prodregistryv2\.org$/,

  // Cloud / hosting back-ends (no consumer UI even though brand has consumer site)
  /(^|\.)amazonaws\.com$/,
  /(^|\.)googleapis\.com$/,
  /(^|\.)windows\.net$/,
  /(^|\.)whatsapp\.net$/,
  /(^|\.)office\.net$/,
  /(^|\.)yandex\.net$/,
  /(^|\.)static\.microsoft$/,
  /(^|\.)aliyuncs\.com$/,
  /(^|\.)aws\.dev$/,
  /(^|\.)amazon\.dev$/,
  /(^|\.)amazonvideo\.com$/,
  /(^|\.)a2z\.com$/,
  /(^|\.)microsoftonline\.com$/,
  /(^|\.)googledomains\.com$/,
  /(^|\.)windowsupdate\.com$/,
  /(^|\.)apple-dns\.net$/,
  /(^|\.)domaincontrol\.com$/,
  /(^|\.)cpanel\.net$/,
  /(^|\.)registrar-servers\.com$/,
  /(^|\.)dropcatch\.com$/,
  /(^|\.)dnsowl\.com$/,
  /(^|\.)hichina\.com$/,
  /(^|\.)shopifysvc\.com$/,
  /(^|\.)launchpad\.net$/,

  // DNS / NTP / PKI / network infrastructure
  /(^|\.)gtld-servers\.net$/,
  /(^|\.)root-servers\.net$/,
  /(^|\.)nominetdns\.uk$/,
  /(^|\.)dns-parking\.com$/,
  /(^|\.)dns\.google$/,
  /(^|\.)ripn\.net$/,
  /(^|\.)nic\.ru$/,
  /(^|\.)alibabadns\.com$/,
  /(^|\.)jomodns\.com$/,
  /(^|\.)duckdns\.org$/,
  /(^|\.)ntp\.org$/,
  /(^|\.)one\.one$/,
  /(^|\.)digicert\.com$/,
  /(^|\.)pki\.goog$/,
  /(^|\.)lencr\.org$/,
  /(^|\.)ipv4only\.arpa$/,
  /(^|\.)3gppnetwork\.org$/,
  /(^|\.)msftncsi\.com$/,
  /(^|\.)msftconnecttest\.com$/,
  /(^|\.)ampproject\.org$/,
  /(^|\.)nginx\.(org|com)$/,
  /(^|\.)apache\.org$/,
  /(^|\.)f5\.com$/,
  /(^|\.)userapi\.com$/,
  /(^|\.)vkuserphoto\.ru$/,
  /(^|\.)mangosip\.ru$/,
  /(^|\.)mailinabox\.email$/,
  /(^|\.)telekom\.net$/,
  /(^|\.)keenetic\.io$/,
  /(^|\.)myfritz\.net$/,
  /(^|\.)ui\.com$/,
  /(^|\.)meraki\.com$/,
  /(^|\.)cisco\.com$/,
  /(^|\.)oxylabs\.io$/,
  /(^|\.)comcast\.net$/,
  /(^|\.)t-online\.de$/,
  /(^|\.)telekom\.de$/,
  /(^|\.)reg\.ru$/,
  /(^|\.)mts\.ru$/,
  /(^|\.)dzen\.ru$/,
  /(^|\.)drom\.ru$/,
  /(^|\.)iiko\.it$/,
  /(^|\.)miit\.gov\.cn$/,
  /(^|\.)steamserver\.net$/,
  /(^|\.)playstation\.net$/,
  /(^|\.)googleblog\.com$/,
  /(^|\.)wsdvs\.com$/,
  /(^|\.)shalltry\.com$/,
  /(^|\.)forter\.com$/,
  /(^|\.)sentry\.io$/,

  // Tracking / analytics / ad networks
  /(^|\.)doubleclick\.net$/,
  /(^|\.)googletagmanager\.com$/,
  /(^|\.)googlesyndication\.com$/,
  /(^|\.)googleadservices\.com$/,
  /(^|\.)google-analytics\.com$/,
  /(^|\.)adtrafficquality\.google$/,
  /(^|\.)criteo\.com$/,
  /(^|\.)taboola\.com$/,
  /(^|\.)pubmatic\.com$/,
  /(^|\.)rubiconproject\.com$/,
  /(^|\.)adnxs\.com$/,
  /(^|\.)applovin\.com$/,
  /(^|\.)appsflyersdk\.com$/,
  /(^|\.)appsflyer\.com$/,
  /(^|\.)app-measurement\.com$/,
  /(^|\.)app-analytics-services\.com$/,
  /(^|\.)amazon-adsystem\.com$/,
  /(^|\.)vungle\.com$/,
  /(^|\.)inmobi\.com$/,
  /(^|\.)openx\.net$/,
  /(^|\.)3lift\.com$/,
  /(^|\.)media\.net$/,
  /(^|\.)casalemedia\.com$/,
  /(^|\.)omtrdc\.net$/,
  /(^|\.)adobe\.io$/,
  /(^|\.)scorecardresearch\.com$/,
  /(^|\.)adsafeprotected\.com$/,
  /(^|\.)doubleverify\.com$/,
  /(^|\.)smartadserver\.com$/,
  /(^|\.)adsrvr\.org$/,
  /(^|\.)sfx\.ms$/,
  /(^|\.)facebook\.net$/,
  /(^|\.)gravatar\.com$/,

  // URL shorteners / link redirectors (no real UI)
  /(^|\.)bit\.ly$/,
  /(^|\.)tinyurl\.com$/,
  /(^|\.)t\.co$/,
  /(^|\.)t\.me$/,
  /(^|\.)wa\.me$/,
  /(^|\.)goo\.gl$/,
  /(^|\.)youtu\.be$/,
  /(^|\.)forms\.gle$/,
  /(^|\.)discord\.gg$/,
  /(^|\.)linktr\.ee$/,
  /(^|\.)youtube-nocookie\.com$/,
  /(^|\.)github\.io$/,
  /(^|\.)blogspot\.com$/,
  /(^|\.)wixsite\.com$/,

  // Generic / utility domains where the site itself isn't the target
  /(^|\.)example\.com$/,
  /(^|\.)w3\.org$/,
  /(^|\.)doi\.org$/,
  /(^|\.)opera\.com$/,
  /(^|\.)mozilla\.com$/,
  /(^|\.)macromedia\.com$/,
];

function isDenied(domain) {
  return DENY_PATTERNS.some((re) => re.test(domain));
}

function parseArgs(argv) {
  const args = { source: null, output: null, count: 100 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--source" && argv[i + 1]) args.source = argv[++i];
    else if (argv[i] === "--output" && argv[i + 1]) args.output = argv[++i];
    else if (argv[i] === "--count" && argv[i + 1]) args.count = parseInt(argv[++i], 10);
  }
  if (!args.source) {
    console.error("usage: build-sites-json.cjs --source <tranco-csv> [--output <path>] [--count N]");
    process.exit(2);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const outPath =
    args.output || path.join(__dirname, "..", "sites.json");

  const csv = fs.readFileSync(args.source, "utf8").trim();
  const rows = csv.split("\n").map((line) => {
    const [rank, domain] = line.split(",");
    return { rank: parseInt(rank, 10), domain: domain.trim() };
  });

  const kept = [];
  const dropped = [];
  for (const row of rows) {
    if (isDenied(row.domain)) {
      dropped.push(row);
    } else {
      kept.push(row);
    }
    if (kept.length === args.count) break;
  }

  if (kept.length < args.count) {
    console.error(
      `WARN: only ${kept.length} sites kept after filtering ${rows.length} rows; need ${args.count}. ` +
        `Re-run with a larger CSV snapshot.`
    );
  }

  const sites = kept.map((row) => ({
    rank: row.rank,
    domain: row.domain,
    category: null,
    category_rationale: null,
    fixture_status: "not_started",
  }));

  const fileMeta = path.basename(args.source);
  const out = {
    source: "tranco-list.eu",
    source_file: fileMeta,
    list_id: fileMeta.match(/tranco-([A-Z0-9]+)-/)?.[1] || null,
    fetched_at: fileMeta.match(/\d{4}-\d{2}-\d{2}/)?.[0] || null,
    filtering_notes:
      "Dropped CDNs, cloud back-ends, DNS/PKI/NTP infra, tracking + ad networks, " +
      "link shorteners, and a few generic-utility domains (example.com, w3.org). " +
      "See benchmark/scripts/build-sites-json.cjs for the full deny-pattern list.",
    counts: {
      input_rows: rows.length,
      kept: kept.length,
      dropped: dropped.length,
    },
    taxonomy: null, // filled by issue #10
    sites,
  };

  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");

  console.log(`source:    ${args.source}`);
  console.log(`input:     ${rows.length} rows`);
  console.log(`kept:      ${kept.length}`);
  console.log(`dropped:   ${dropped.length}`);
  console.log(`wrote:     ${outPath}`);
  console.log("");
  console.log("=== kept sample (top 10) ===");
  for (const s of sites.slice(0, 10)) console.log(`  ${s.rank.toString().padStart(3)} ${s.domain}`);
  console.log("=== kept sample (bottom 10) ===");
  for (const s of sites.slice(-10)) console.log(`  ${s.rank.toString().padStart(3)} ${s.domain}`);
}

main();
