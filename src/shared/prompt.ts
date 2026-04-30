import { startStep } from "./logger";

export function buildDarkPatternPrompt(input: {
  pageKey?: string;
  screenshotString: string;
  traceId?: string;
  truncatedHtml: string;
  pageUrl: string;
}): string {
  const step = startStep("prompt", "buildDarkPatternPrompt", {
    pageKey: input.pageKey,
    screenshotStringLength: input.screenshotString.length,
    traceId: input.traceId,
    truncatedHtmlLength: input.truncatedHtml.length
  });

  const prompt = `You are a website dark pattern evaluator.

Your task is to identify the top 3 most obvious dark patterns on the current webpage.

You are given a base64-encoded JPEG screenshot and truncated HTML of the page.
Use the HTML as your primary evidence. Use the screenshot for visual confirmation and to resolve ambiguities the HTML alone cannot clarify.

Only identify dark patterns from the taxonomy below.
Do not invent any new dark pattern types.
If the evidence is weak or uncertain, do not include that candidate.

Dark pattern taxonomy:

- Disguised ad:
  Presents advertisements as legitimate interface elements, making users more likely to click on them unintentionally.
  Real examples:
  • Softpedia / SourceForge: multiple large "Download" buttons styled identically to the real download button — the ad buttons are larger and more prominent; the real download link is smaller and placed aside.
  • CNN / news sites: sponsored articles formatted exactly like editorial content with only a small, low-contrast "Sponsored" or "Ad" label that blends into the header.
  • Search result pages: ad listings that mimic organic results, distinguished only by a tiny "Ad" badge with very low contrast.
  Typical HTML: an '<a>' or '<div>' inside a wrapper that shares the same visual style as real content, sometimes with a barely-visible label like '<span class="ad-label">Sponsored</span>'.

- False hierarchy:
  Manipulates the visual prominence, size, color, placement, or layout order of interface elements to mislead users about which option is more important, safer, or recommended.
  Real examples:
  • Subscription cancel flows: "Keep my subscription" rendered as a large filled button (e.g. blue background) while "Cancel" is a tiny, low-contrast text link below it.
  • Cookie consent banners: "Accept All" is a large, brightly-colored button; "Manage Preferences" or "Reject" is a small gray text link or outlined button.
  • E-commerce checkout: "Express Checkout" (higher margin for site) is the primary CTA; "Continue as Guest" is de-emphasized with smaller font and gray color.
  Typical HTML: primary option is '<button class="btn-primary">' with high-contrast color; secondary option is '<a class="btn-link">' or '<button class="btn-secondary">' with muted color and smaller size.

- Preselection:
  Makes options that benefit the platform automatically checked, toggled on, or selected by default without the user’s explicit consent.
  Real examples:
  • Ryanair checkout: marketing email opt-in checkbox is pre-ticked; users must actively uncheck to opt out.
  • Online donation pages (e.g. Trump 2020 campaign): "Make this a monthly recurring donation" checkbox is checked by default — users unknowingly sign up for recurring charges.
  • Cookie banners: "Accept all cookies" toggle is on by default; users must manually toggle each category off.
  • E-commerce: "Add travel insurance" or "Add protection plan" is pre-added to the cart and must be removed manually.
  Typical HTML: '<input type="checkbox" checked>' or '<input type="radio" checked>' for an option that benefits the platform.

- Pop-up ad:
  Displays intrusive overlay windows, modal dialogs, or pop-ups that interrupt the user’s browsing flow or pressure the user into taking an action.
  Real examples:
  • Exit-intent modals: appear when the cursor moves toward the browser bar — "Wait! Don’t leave yet — here’s 10% off."
  • Time-delayed newsletter popups: appear after 5–15 seconds of reading, covering the article content with a sign-up form.
  • Hard-to-close modals: the close button (×) is tiny, low-contrast, or positioned off-screen; only "Continue" or a paid option is clearly visible.
  Typical HTML: '<div class="modal-overlay" style="position:fixed;z-index:9999">' wrapping a centered dialog; close button may be '<button class="close-btn">' with very small size or opacity.

- Trick wording:
  Uses confusing, ambiguous, or misleading wording to manipulate users into taking actions they did not intend.
  Real examples:
  • Double-negative opt-outs: "Uncheck here if you do not wish to receive marketing emails" — users must uncheck to opt out, reversing normal checkbox logic.
  • Free trial fine print: large headline says "Free for 30 days"; the cancellation requirement ("cancel before trial ends or you will be charged") is in small gray text at the bottom.
  • Urgency copy: "HURRY — only a few left!", "Offer expires in 00:03:42" countdown timers that reset on page reload, creating false scarcity.
  • Ambiguous button labels: "Get started" on a page that actually initiates a paid subscription.
  Typical HTML: urgency text in '<span>' or '<p>' with high-contrast color (red/orange); fine-print in '<small>' or '<p class="disclaimer">' with low-contrast gray.

- Confirm shaming:
  Uses guilt-inducing or emotionally manipulative language to pressure users into accepting an option or avoiding rejection.
  Real examples:
  • Newsletter decline link: "No thanks, I don’t want to save money" or "No, I prefer to pay full price."
  • VPN / security service cancellation: "Yes, cancel my protection" (the cancel option) vs. "No, keep me safe" (retain).
  • Subscription modal: "Yes, I want exclusive deals!" vs. "No, I don’t want deals" as the opt-out.
  Typical HTML: the dismiss/decline option is an '<a>' or '<button>' with shame-inducing label text, positioned below the primary CTA; often styled in small, gray or muted text.

- Fake social proof:
  Creates a misleading impression of popularity, urgency, trust, or credibility through fabricated or unverifiable social signals.
  Real examples:
  • Booking.com product pages: "Only 2 rooms left at this price!", "12 people are looking at this right now", "Booked 47 times today" — messages that may be based on platform-exclusive inventory, not total availability.
  • E-commerce: floating notification toasts like "Alycia from San Francisco just purchased this" with randomized or fabricated names and timestamps.
  • Review widgets: star-rating badges showing "4.9/5 from 2,847 reviews" where the review source or methodology is unverifiable.
  • Countdown timers: "Sale ends in 00:12:34" that reset on every page load.
  Typical HTML: '<div class="urgency-badge">' or '<span class="social-proof">' with red or orange text; floating notification as '<div class="toast" style="position:fixed;bottom:20px">'.

- Forced Action:
  Compels users to perform an unrelated or unwanted action before completing their intended task.
  Real examples:
  • LinkedIn contact importer: during signup, the "Continue" button secretly accessed the user’s full email contact list and spammed all contacts — the actual function was described in small, low-contrast gray text; "Skip this step" was a tiny link outside the main flow (LinkedIn paid $13M settlement in 2015).
  • Account creation walls: news sites or tools require creating an account (and accepting marketing) before allowing access to free content.
  • App permission over-ask: a flashlight app requesting access to contacts, microphone, and location before it will turn on.
  Typical HTML: a prominent '<button class="btn-primary">Continue</button>' where the secondary "Skip" is '<a class="skip-link">' with very small font-size, positioned outside the main card.

- Hidden information:
  Conceals, obscures, minimizes, or delays important information, options, costs, or consequences relevant to user decision-making.
  Real examples:
  • Ticketmaster: ticket listed at "$50" on search; at checkout three separate fees (facility charge, convenience charge, order processing) add 40–50% — total only shown on the final payment screen after the user has invested time selecting seats.
  • Ryanair: travel insurance is pre-added; the opt-out is hidden inside a nationality dropdown as "No Travel Insurance Required" alphabetically between "Latvia" and "Lithuania."
  • Subscription services: free plan limitations (storage cap, watermark, export limit) listed only in a collapsed "Compare plans" table or in footnotes below the pricing cards.
  • Shipping cost: shown only after address entry on the final checkout step, not on the product or cart page.
  Typical HTML: fees or conditions in '<small>', '<span class="fine-print">', or collapsed '<details>' elements; pricing displayed as '<span class="base-price">' while fees are in a separate '<table class="fee-breakdown">' revealed only at checkout.

Issue tag rules:

- For Disguised ad:
  - include "color" if color contributes to deceptiveness
  - include "font_size" if font size contributes to deceptiveness
  - include "background_color" if background color contributes to deceptiveness or click pressure
  - include "add_advertisement_title" if the ad is missing a visible "ad" or "advertisement" title above it
  - include "enhance_advertisement_title" if the ad already has an "ad" or "advertisement" title above it but that title is lighter than 50% black or visually hidden

- For False hierarchy:
  - include "color" if color contributes to misleading prominence
  - include "font_size" if font size contributes to misleading prominence
  - include "background_color" if background color contributes to misleading prominence

- For all other dark pattern types:
  - return an empty issue list unless the schema or downstream system specifies otherwise

Identification rules:

1. Identify at most 3 dark patterns.
2. Rank them from most obvious to least obvious.
3. Use HTML evidence first, and then for more detailed dark pattern issues, use screenshot evidence as a support.
4. Screenshot covers the full page. Use it alongside the HTML to identify dark patterns throughout.
5. Use HTML to help localize or confirm the suspicious element.
6. Only use issue tags from this set: ["color", "font_size", "background_color", "add_advertisement_title", "enhance_advertisement_title"].
7. If no dark pattern is confidently identified, return an empty result.

HTML evidence and CSS selector rules (strictly enforced):

8. For every identified dark pattern you MUST first locate the exact element in the provided HTML by text-searching for it.
   Then copy the element's opening tag (or up to 2 lines including its attributes) verbatim into html_evidence.
   Example — if you find '<button class="btn-primary add-to-cart" data-product-id="123">Add to Cart</button>'
   in the HTML, set html_evidence to that exact string. Do NOT paraphrase or reconstruct it.
   If you cannot find the element verbatim in the provided HTML, do not include that dark pattern.

9. Derive css_selector from the html_evidence you just copied — not from memory or inference.
   Use the id (#id), data attributes ([data-*="value"]), or the exact class names visible in html_evidence.
   Never invent a class name that is not present in html_evidence.

10. Only use standard CSS selectors valid for document.querySelector(). Never use jQuery-style pseudo-selectors such as :contains(), :has() with text, :visible, or :eq().
11. Never generate selectors for elements that only appear after user interaction — including cart drawers, modal popups, tooltips, or any element with display:none or visibility:hidden that requires a click to reveal.
12. Prefer selectors using id (#id), data attributes ([data-*="value"]), or descriptive class names (.product-price, .add-to-cart). Avoid generic tag selectors (span, div) without a stable class or attribute anchor.
13. If you are uncertain whether an element exists in the HTML, omit that dark pattern rather than guessing.

14. For every identified dark pattern, set selector_stability:
    - "stable": the CSS selector uses an #id, a [data-*] attribute, a semantic element name, or a descriptive class name that belongs to the site's design system (e.g. .product-title, .price-block, [data-testid="add-to-cart"])
    - "dynamic": the selector relies on hashed or generated class names (e.g. ._3Bx2a, .s-1k9p4m), deeply-nested :nth-child paths with no class anchoring, or text-content-specific matches that would not survive across different instances of this template

Template matching features (for local-only reuse on future visits):

10. Fill template_match_features so the extension can match this page template locally without calling the LLM again.
    Every token must be stable across ALL URLs sharing this template — never include product titles, prices, ASINs, user names, query strings, or any other page-specific content.

    - url_path_tokens: 2–4 path segments that identify this URL pattern.
      Use normalized placeholders for variable segments.
      Good: ["dp", "{id}"] for an Amazon product page, ["search"] for search results.
      Bad: ["B08N5WRWNW", "the-product-title"].

    - required_attributes: up to 8 HTML attributes that MUST appear on every page of this template.
      Format each token exactly as one of: "data-X" (attribute name only), "role:value", "type:value",
      "aria-X" (attribute name only), "attr:id" (presence of any id attribute), "name:value".
      Good: ["data-asin", "role:button", "type:submit", "data-add-to-cart"].
      Bad: ["data-asin:B08N5WRWNW", "class:a-button"] — do not include class names here.

    - optional_attributes: up to 6 attributes present on most pages of this template but not guaranteed.
      Same format as required_attributes.

    - negative_attributes: up to 4 attributes whose presence would indicate this is a DIFFERENT template.
      Good (for a product page): ["data-search-result", "data-filter-panel"] — these appear on search pages, not product pages.

    - fingerprint_tokens: up to 10 CSS class names that are distinctive to this site's design system for this template.
      Use only descriptive, stable class names visible in the HTML — not hashed names (e.g. "_3Bx2a").
      Good: ["a-price-whole", "a-button-primary", "s-result-item"].

    - match_confidence: "high" if features are highly distinctive across many URLs of this template;
      "medium" if some features may occasionally be absent; "low" if uncertain or the page is not clearly templated.

    - url_shape: The canonical shape of this URL template — hostname + path with variable segments replaced.
      Use {id} for numeric IDs, ASINs, UUIDs, or any opaque identifier. Use {slug} for long mixed-alphanumeric slugs.
      Good: "amazon.com/dp/{id}", "shop.com/product/{slug}", "example.com/search".
      Bad: "amazon.com/dp/B08N5WRWNW" (raw ID), "example.com/posts/my-article-title" (content-specific slug left as-is).
      Set to null if the URL structure is ambiguous or not clearly templated.

Now analyze the following webpage.

Current page URL: ${input.pageUrl}

Truncated HTML:
${input.truncatedHtml}

Screenshot (base64-encoded JPEG):
${input.screenshotString}`;

  step.finish({
    pageKey: input.pageKey,
    promptLength: prompt.length
  });

  return prompt;
}
