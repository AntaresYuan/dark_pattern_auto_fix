# Benchmark Fixture Plan — first 5 (starter batch)

> **STATUS (archived)**: all 5 fixtures shipped (#21, #23, #24, #25, #26) plus
> the pre-existing amazon-product-page. The 2026-05-15 realism audit (PR #28,
> issue #27) then dropped non-canonical DPs per fixture — current totals are
> in [`benchmark/README.md`](../README.md), not here. This doc is preserved
> for planning context. Devloop is paused; future fixtures 6+ are unscoped.

This is the queue of fixtures to build in issues #12–#16. After #16 merges, devloop pauses for human review before scaling to fixtures 6+ (eventual target: ~50 sites).

## Picking criteria applied

- **Category diversity**: 5 picks → 5 distinct categories (Travel, News, Streaming, Social, Finance). The existing `benchmark/fixtures/amazon-product-page/` covers E-commerce, so we deliberately skip that bucket here.
- **Page-type diversity**: 5 distinct page types — hotel checkout, article-with-paywall, cancel-subscription, account-deactivation, account-close.
- **DP density**: every page type chosen is academically attested as DP-rich (Mathur 2019, Gray 2018, Bösch 2016, plus the injection-mapping prior work).
- **Reference signal**: 2 of 5 (booking.com, nytimes.com) appear directly in `benchmark/injection-mapping-index.json`. The other 3 (netflix, facebook, paypal) don't — but their page types closely resemble entries in the index that can be adapted.

## The 5 fixtures

| Row | Slug | Site (mimicked) | Category | Page type | Why DP-rich | Reference snippets in injection-mapping |
|---|---|---|---|---|---|---|
| 1 | `booking-hotel-checkout` | booking.com | Travel & hospitality (4) | Hotel checkout | Urgency banners ("only 2 left at this price"), scarcity messaging, **preselected** travel insurance, hidden resort fees, post-search-result modal pop-ups. Travel checkout is the canonical DP-dense surface (Mathur 2019). | `bki_pop_up`, `bki_double_negative`, `bki_confirm_shaming` (3 direct snippets — Booking.com is one of the best-covered sites in the index). |
| 2 | `nytimes-article-paywall` | nytimes.com | News & media (2) | Article with paywall modal | Confirm-shaming decline link ("No thanks, I'd rather pay full price"), **preselected** annual billing on plan grid, cookie banner with pre-checked tracking. Newspaper paywalls are a documented hot-spot for confirm-shaming + preselection. | `nyt_social` (direct), plus adapt `eco_preselect`, `eco_double_negative`, `eco_confirm_shaming` (Economist; very similar paywall shape). |
| 3 | `netflix-cancel-flow` | netflix.com | Streaming & entertainment (7) | Cancel-subscription flow | Multi-step cancel friction, downgrade-instead-of-cancel preselects ("Pause your account?"), retention copy with confirm-shaming ("Are you sure? You'll lose your watchlist"). Streaming cancel-flow is the canonical Streaming DP — heavily studied. | None direct, but adapt `stm_double_negative` + `stm_confirm_shaming` (Steam; gaming-platform cancel flow has the same multi-step + retention-copy shape). |
| 4 | `facebook-deactivation` | facebook.com | Social media (3) | Account deactivation / privacy settings | Privacy preselects (data sharing on by default), scary copy on opt-out ("Your friends will miss you"), multi-step friction to permanently delete vs. temporarily deactivate, dark-style "Cancel" button vs. bright "Keep account" button. Privacy preselects + deactivation friction are the canonical Social DPs (Bösch 2016). | None direct. Adapt generic `*_confirm_shaming` (any-site) + `*_preselect` (Apple has 3 product-bundle preselects with similar UI patterns). |
| 5 | `paypal-account-close` | paypal.com | Finance & fintech (5) | Account-close / sign-up with marketing preselects | Hidden fee disclosures on conversions (collapsed under disclosure links), preselected marketing-email opt-ins on signup, multi-step account-close that resembles a deactivation rather than a delete. Finance/fintech account-close friction is well-attested (Hertz, JCPenney, etc. in the index). | None direct. Adapt `hrz_forced_action` (Hertz coverage page = forced-decision pattern), `jpp_forced_action` (JCPenney signup-style forced-action), `eco_preselect` (preselected marketing opt-in). |

## Coverage check vs. acceptance criteria

- ✅ 5 distinct categories (Travel, News, Streaming, Social, Finance) — exceeds the 4-distinct minimum
- ✅ 5 distinct page types — exceeds the 4-distinct minimum
- ✅ None of the 5 is e-commerce PDP (Amazon already covers it)
- ✅ Every row cites at least one reference key from `injection-mapping-index.json`, OR explains the adaptation path
- ✅ Every row has a 1-2 sentence DP-richness rationale
- ✅ `fixture_status` updated in `sites.json` for the 5 picks (via `benchmark/scripts/mark-planned-fixtures.cjs`)

## Notes / debt to flag

- **3 of 5 picks have no direct reference snippet** (netflix, facebook, paypal). The injection-mapping was authored against a different site set, mostly mid-tail brand e-commerce. The 5 categories we want to cover (especially Streaming, Social, Finance) underlap the index. This is fine for adaptation — the harm tests + UI patterns transfer — but adds design judgment per fixture.
- **Apple is in injection-mapping AND in our top 100** but isn't picked here. It's e-commerce-ish and would compete with the existing Amazon fixture for category coverage. Reserved for fixtures 6+.
- **eBay is also in both** but we already have an e-commerce PDP fixture. Could be picked later for a different page type (e.g., bidding flow) but not in starter 5.

## How fixtures #12–#16 are blocked

Issues #12 through #16 each correspond to one row above (in order). #12 is the full template spec; #13–#16 say "follow #12 with row N substituted." Each PR pauses until its predecessor merges (sequential dep chain), so each fixture build can incorporate review feedback from the previous one.
