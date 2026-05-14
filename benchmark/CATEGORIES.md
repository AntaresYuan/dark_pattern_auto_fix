# Site Categories

The 100 sites in `benchmark/sites.json` are classified into 10 categories. The taxonomy is grounded in dark-pattern literature (Mathur 2019 *Dark Patterns at Scale*, Gray 2018 *The Dark (Patterns) Side of UX Design*) — each category has a meaningfully different DP signature, which matters for benchmark balance.

## Taxonomy

| # | Category | # of sites |
|---|---|---|
| 1 | E-commerce | 13 |
| 2 | News & media | 10 |
| 3 | Social media | 14 |
| 4 | Travel & hospitality | 1 |
| 5 | Finance & fintech | 3 |
| 6 | Productivity SaaS | 28 |
| 7 | Streaming & entertainment | 8 |
| 8 | Dating & gaming | 2 |
| 9 | Education | 3 |
| 10 | Utility & misc | 18 |
| **total** | | **100** |

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

See `benchmark/sites.json` — every entry has `category` (1-10) + `category_rationale`.
