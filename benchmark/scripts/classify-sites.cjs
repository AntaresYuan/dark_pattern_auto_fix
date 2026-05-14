#!/usr/bin/env node

// Reads benchmark/sites.json, fills `category` (1-10) + `category_rationale`
// on every site entry, adds the top-level `taxonomy` block, and writes
// benchmark/CATEGORIES.md (taxonomy table + per-category counts).
//
// Taxonomy grounded in dark-pattern literature (Mathur 2019, Gray 2018):
// each category has a meaningfully different DP signature, which matters
// for benchmark balance.
//
// usage: node benchmark/scripts/classify-sites.cjs

const fs = require("fs");
const path = require("path");

const TAXONOMY = {
  1: "E-commerce",
  2: "News & media",
  3: "Social media",
  4: "Travel & hospitality",
  5: "Finance & fintech",
  6: "Productivity SaaS",
  7: "Streaming & entertainment",
  8: "Dating & gaming",
  9: "Education",
  10: "Utility & misc",
};

// Per-domain category assignment + one-line rationale.
// Justification format: "<primary surface>; <DP-rich page-type if obvious>"
const CLASSIFICATIONS = {
  // ---- 1. E-commerce ----
  "amazon.com":   [1, "Marketplace; PDP, cart, checkout flows are DP-dense (preselects, hidden fees, false hierarchy)."],
  "apple.com":    [1, "Direct sales storefront; product configurator + protection plan upsells trigger preselect + false hierarchy."],
  "microsoft.com":[1, "Consumer hardware/software store; product pages + subscription cross-sell."],
  "samsung.com":  [1, "Consumer electronics storefront; PDP + bundle upsells."],
  "windows.com":  [1, "Redirects to Microsoft's Windows commerce surface; edition + upgrade upsells."],
  "godaddy.com":  [1, "Domain registrar e-commerce; cart preselects (privacy, hosting bundles) are notorious."],
  "gandi.net":    [1, "Domain registrar e-commerce; cart/extras flow."],
  "ebay.com":     [1, "Auction/marketplace; PDP, bidding flow, post-bid upsells."],
  "ozon.ru":      [1, "Russian marketplace; PDP + checkout."],
  "xiaomi.com":   [1, "Consumer hardware storefront."],
  "miui.com":     [1, "Xiaomi consumer surface (MIUI account / store)."],
  "kaspersky.com":[1, "Consumer security-software purchase flow; auto-renew preselects, hidden fee structures."],
  "avast.com":    [1, "Consumer security-software purchase flow; free-to-paid upgrade DPs."],

  // ---- 2. News & media ----
  "dzen.ru":         [2, "Yandex consumer news/feed; cookie + consent + content-recommendation DPs."],
  "yahoo.com":       [2, "News portal + email; subscription paywall + content gates."],
  "msn.com":         [2, "Microsoft news portal."],
  "nytimes.com":     [2, "Paywalled news; subscription preselects, confirm-shaming decline link."],
  "medium.com":      [2, "Publishing platform; metered paywall + member-upsell modals."],
  "cnn.com":         [2, "News site; ad consent, newsletter modals."],
  "theguardian.com": [2, "News site with donation upsell flow."],
  "forbes.com":      [2, "News site; aggressive interstitials + paywall."],
  "bbc.com":         [2, "International news; consent banners + algorithmic-content gates."],
  "bbc.co.uk":       [2, "UK news + iPlayer streaming."],

  // ---- 3. Social media ----
  "facebook.com":  [3, "Social network; privacy preselects, deactivation friction, growth nudges."],
  "instagram.com": [3, "Social/photo; privacy + deactivation, ad consent."],
  "twitter.com":   [3, "Microblogging; account deletion friction, ad consent."],
  "x.com":         [3, "Twitter-rebranded surface; same DP signature."],
  "linkedin.com":  [3, "Professional social; growth dark patterns (connect prompts), data preselects."],
  "pinterest.com": [3, "Visual social; cookie + recommendation preselects."],
  "tiktok.com":    [3, "Short-video social; consent + personalization, FYP opt-out friction."],
  "reddit.com":    [3, "Community forum; signup wall, premium upsells, mobile-app deeplinks."],
  "vk.com":        [3, "Russian social network; privacy + ad consent."],
  "qq.com":        [3, "Tencent social/IM portal; bundle preselects + cross-product nudges."],
  "snapchat.com":  [3, "Ephemeral social; account deletion + ad personalization."],
  "tumblr.com":    [3, "Microblog/social; subscription preselects (Tumblr Premium)."],
  "discord.com":   [3, "Community chat; Nitro subscription upsells, deletion friction."],
  "flickr.com":    [3, "Photo-sharing social; Pro subscription preselects."],

  // ---- 4. Travel & hospitality ----
  "booking.com":   [4, "Hotel booking; classic DP-dense surface — urgency banners, scarcity messaging, preselected insurance, hidden resort fees."],

  // ---- 5. Finance & fintech ----
  "intuit.com":    [5, "TurboTax/Quicken parent; tax-filing tier upsells, preselected add-ons."],
  "paypal.com":    [5, "Payments; account-close friction, hidden conversion fees."],
  "stripe.com":    [5, "Payment platform; signup + plan-tier UI."],

  // ---- 6. Productivity SaaS ----
  "cloudflare.com": [6, "DNS/CDN SaaS; signup + plan-tier preselects, free-to-paid friction."],
  "mail.ru":        [6, "Russian webmail/portal; account + storage upsells."],
  "office.com":     [6, "Microsoft 365 productivity surface."],
  "live.com":       [6, "Microsoft consumer login + Outlook/OneDrive."],
  "azure.com":      [6, "Microsoft cloud signup; paid-tier preselects on free signup."],
  "github.com":     [6, "Dev SaaS; Pro/Team upgrade flows, billing UX."],
  "skype.com":      [6, "Messaging; subscription credit + auto-renew preselects."],
  "sharepoint.com": [6, "Microsoft 365 collaboration."],
  "chatgpt.com":    [6, "Consumer LLM SaaS; Plus subscription, cancel-flow friction."],
  "whatsapp.com":   [6, "Messaging SaaS; account deletion + backup preselects."],
  "cloud.microsoft":[6, "Microsoft cloud portal entry."],
  "icloud.com":     [6, "Apple consumer storage; tier-upgrade nudges."],
  "adobe.com":      [6, "Creative Cloud SaaS; annual-vs-monthly preselects, cancel-flow notoriously dark."],
  "zoom.us":        [6, "Video-conferencing SaaS; pro plan upsells."],
  "office365.com":  [6, "Microsoft 365 SaaS."],
  "wordpress.com":  [6, "Hosted blog SaaS; plan upgrade nudges."],
  "outlook.com":    [6, "Microsoft consumer email."],
  "dropbox.com":    [6, "File storage SaaS; tier upsells + cancel friction."],
  "shopify.com":    [6, "Merchant SaaS; plan-tier signup."],
  "webex.com":      [6, "Video-conferencing SaaS."],
  "oracle.com":     [6, "Enterprise SaaS; cloud signup."],
  "gmail.com":      [6, "Consumer email surface."],
  "canva.com":      [6, "Design SaaS; Pro upsells, free-to-paid friction."],
  "telegram.org":   [6, "Messaging; Premium upsells."],
  "hubspot.com":    [6, "Marketing/CRM SaaS; free-to-paid + plan-tier UI."],
  "openai.com":     [6, "LLM SaaS; signup + plan-tier."],
  "autodesk.com":   [6, "Engineering SaaS; subscription billing UX."],
  "unity3d.com":    [6, "Game-engine SaaS; subscription + asset-store."],

  // ---- 7. Streaming & entertainment ----
  "youtube.com":   [7, "Video streaming; cancel/Premium friction, autoplay preselects."],
  "netflix.com":   [7, "Video streaming; plan preselects, cancel-flow."],
  "spotify.com":   [7, "Audio streaming; Premium preselects, family-plan upsells."],
  "vimeo.com":     [7, "Video hosting; tier preselects."],
  "soundcloud.com":[7, "Audio streaming; Premium upsells."],
  "roku.com":      [7, "Streaming device portal; channel preselects, account billing."],
  "twitch.tv":     [7, "Live streaming; subscription + cancel friction, Prime-linking preselects."],
  "imdb.com":      [7, "Entertainment metadata; ad consent, Amazon-account nudges."],

  // ---- 8. Dating & gaming ----
  "roblox.com":    [8, "Online gaming platform; in-app currency + parental-control friction."],
  "epicgames.com": [8, "Game store + launcher; Epic Games store checkout, account deletion friction."],

  // ---- 9. Education ----
  "sciencedirect.com": [9, "Academic publishing (Elsevier); paywall + access-tier UI."],
  "researchgate.net":  [9, "Academic social network; data preselects, paper-access gates."],
  "mit.edu":           [9, "University site; mostly informational + admissions UX."],

  // ---- 10. Utility & misc ----
  "google.com":          [10, "Primary surface is search; account/settings pages carry consent + preselect DPs."],
  "wikipedia.org":       [10, "Encyclopedia + donation banners; low DP density."],
  "bing.com":            [10, "Search engine + Rewards consent."],
  "wordpress.org":       [10, "Open-source community/download site."],
  "baidu.com":           [10, "Chinese search + portal."],
  "mozilla.org":         [10, "Browser foundation site + Firefox download."],
  "yandex.ru":           [10, "Russian search/portal."],
  "europa.eu":           [10, "EU government info site."],
  "nih.gov":             [10, "US government health info."],
  "archive.org":         [10, "Internet Archive; donation banners."],
  "creativecommons.org": [10, "Open-license organization."],
  "weather.com":         [10, "Weather utility; ad-heavy but largely information."],
  "sourceforge.net":     [10, "Open-source download portal."],
  "ubuntu.com":          [10, "Linux distribution; community + download."],
  "android.com":         [10, "Google's Android info site."],
  "nist.gov":            [10, "US standards body."],
  "who.int":             [10, "World Health Organization."],
  "wikimedia.org":       [10, "Wikimedia Foundation umbrella site."],
};

function main() {
  const sitesPath = path.join(__dirname, "..", "sites.json");
  const sites = JSON.parse(fs.readFileSync(sitesPath, "utf8"));

  const unclassified = [];
  for (const s of sites.sites) {
    const entry = CLASSIFICATIONS[s.domain];
    if (!entry) {
      unclassified.push(s.domain);
      continue;
    }
    s.category = entry[0];
    s.category_rationale = entry[1];
  }

  if (unclassified.length > 0) {
    console.error("ERROR: unclassified domains in sites.json:");
    for (const d of unclassified) console.error(`  - ${d}`);
    process.exit(1);
  }

  // Also flag dead map entries — classifications for domains that aren't in sites.json.
  // Catches drift between the filter (build-sites-json.cjs) and this classifier.
  const sitesSet = new Set(sites.sites.map((s) => s.domain));
  const dead = Object.keys(CLASSIFICATIONS).filter((d) => !sitesSet.has(d));
  if (dead.length > 0) {
    console.error("ERROR: classifications for domains not in sites.json (dead map entries):");
    for (const d of dead) console.error(`  - ${d}`);
    process.exit(1);
  }

  // Sanity: every category 1-10 has at least one site, none has more than 50.
  const counts = {};
  for (let i = 1; i <= 10; i++) counts[i] = 0;
  for (const s of sites.sites) counts[s.category]++;
  for (let i = 1; i <= 10; i++) {
    if (counts[i] === 0) {
      console.error(`ERROR: category ${i} (${TAXONOMY[i]}) has 0 sites.`);
      process.exit(1);
    }
    if (counts[i] > 50) {
      console.error(`ERROR: category ${i} (${TAXONOMY[i]}) has ${counts[i]} sites (>50).`);
      process.exit(1);
    }
  }

  sites.taxonomy = TAXONOMY;
  fs.writeFileSync(sitesPath, JSON.stringify(sites, null, 2) + "\n");

  // Build CATEGORIES.md.
  const catRows = Object.entries(TAXONOMY)
    .map(([id, name]) => `| ${id} | ${name} | ${counts[id]} |`)
    .join("\n");
  const catMd = `# Site Categories

The 100 sites in \`benchmark/sites.json\` are classified into 10 categories. The taxonomy is grounded in dark-pattern literature (Mathur 2019 *Dark Patterns at Scale*, Gray 2018 *The Dark (Patterns) Side of UX Design*) — each category has a meaningfully different DP signature, which matters for benchmark balance.

## Taxonomy

| # | Category | # of sites |
|---|---|---|
${catRows}
| **total** | | **${sites.sites.length}** |

## Why these 10

- **E-commerce** is the highest-DP-density bucket in Mathur 2019 — PDP, cart, checkout flows.
- **News & media** carries paywalls, subscription preselects, cookie banners.
- **Social media** has privacy preselects, deactivation friction, growth dark patterns.
- **Travel & hospitality** is the canonical "urgency / scarcity / hidden fees" surface.
- **Finance & fintech** features confirm shaming, preselected products, account-close friction.
- **Productivity SaaS** lives or dies on trial-to-paid + downgrade friction.
- **Streaming & entertainment** is dominated by cancel-flow friction + autoplay preselects.
- **Dating & gaming** has subscription tiers, lootbox patterns, in-app-currency UX.
- **Education** has free-trial countdowns + paywalls on certificates / paper access.
- **Utility & misc** is lower DP density but balances coverage; also a counterexample source.

## Per-domain classifications

See \`benchmark/sites.json\` — every entry has \`category\` (1-10) + \`category_rationale\`.
`;
  fs.writeFileSync(path.join(__dirname, "..", "CATEGORIES.md"), catMd);

  console.log(`classified:    ${sites.sites.length} / ${sites.sites.length}`);
  console.log(`taxonomy:      added to top of sites.json`);
  console.log(`CATEGORIES.md: written`);
  console.log("");
  console.log("=== per-category counts ===");
  for (let i = 1; i <= 10; i++) {
    console.log(`  ${i}. ${TAXONOMY[i].padEnd(28)} ${counts[i]}`);
  }
}

main();
