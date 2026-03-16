export function buildDarkPatternPrompt(input: {
  screenshotString: string;
  truncatedHtml: string;
}): string {
  return `You are a website dark pattern evaluator.

Your task is to identify the top 3 most obvious dark patterns on the current webpage.

You must primarily rely on the screenshot of the webpage.
Use the truncated HTML only as secondary supporting evidence when the screenshot alone is insufficient.

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

Now analyze the following webpage.

Screenshot string:
${input.screenshotString}

Truncated HTML:
${input.truncatedHtml}`;
}
