import { startStep } from "./logger";

export function buildDarkPatternPrompt(input: {
  pageKey?: string;
  screenshotString: string;
  traceId?: string;
  truncatedHtml: string;
  screenshotString: string;
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

- False hierarchy:
  Manipulates the visual prominence, size, color, placement, or layout order of interface elements to mislead users about which option is more important, safer, or recommended.

- Preselection:
  Makes options that benefit the platform automatically checked, toggled on, or selected by default without the user's explicit consent.

- Pop-up ad:
  Displays intrusive overlay windows, modal dialogs, or pop-ups that interrupt the user’s browsing flow or pressure the user into taking an action.

- Trick wording:
  Uses confusing, ambiguous, or misleading wording to manipulate users into taking actions they did not intend.

- Confirm shaming:
  Uses guilt-inducing or emotionally manipulative language to pressure users into accepting an option or avoiding rejection.

- Fake social proof:
  Creates a misleading impression of popularity, urgency, trust, or credibility through fabricated or unverifiable social signals.

- Forced Action:
  Compels users to perform an unrelated or unwanted action before completing their intended task.

- Hidden information:
  Conceals, obscures, minimizes, or delays important information, options, costs, or consequences relevant to user decision-making.

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
4. Screenshot is not full paged, so for the rest of the page, use HTML to identify dark patterns, screenshot is just for infer.
5. Use HTML to help localize or confirm the suspicious element.
6. If an exact CSS selector cannot be inferred, provide the best possible selector-like locator.
7. Only use issue tags from this set: ["color", "font_size", "background_color", "add_advertisement_title", "enhance_advertisement_title"].
8. If no dark pattern is confidently identified, return an empty result.

9. For every identified dark pattern, set selector_stability:
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
${input.truncatedHtml}`;

  step.finish({
    pageKey: input.pageKey,
    promptLength: prompt.length
  });

  return prompt;
}
