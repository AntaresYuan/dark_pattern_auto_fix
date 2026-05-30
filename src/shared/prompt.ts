import { startStep } from "./logger";

export function buildDarkPatternPrompt(input: {
  pageKey?: string;
  traceId?: string;
  truncatedHtml: string;
  pageUrl: string;
}): string {
  const step = startStep("prompt", "buildDarkPatternPrompt", {
    pageKey: input.pageKey,
    traceId: input.traceId,
    truncatedHtmlLength: input.truncatedHtml.length
  });

  const prompt = `You are a website dark pattern evaluator.

Your task is to evaluate the current webpage for dark patterns.

CRITICAL DEFAULT: Most webpages contain ZERO dark patterns. The expected output for a typical, well-designed page (a normal product page, a normal homepage, a normal article page, a normal sign-up form) is an EMPTY list. Returning an empty list is the correct answer for most pages — it is not a failure to find anything.

Identify all the dark patterns on the page. Only include a candidate if you can clearly justify it against the harm test for its specific type (defined per type below). If you cannot articulate concrete user harm, do NOT include it. Do not pad the list to reach a target count. A high-confidence empty list is strictly better than a padded list with weak candidates.

You are given a screenshot (provided as a separate vision input) and the truncated HTML of the page.
Use the screenshot as your primary evidence. Use the html for secondary confirmation and to resolve ambiguities the screenshot alone cannot clarify.

Only identify dark patterns from the taxonomy below.
Do not invent any new dark pattern types.
If the evidence is weak or uncertain, do not include that candidate.

Reasoning protocol (you MUST fill the schema fields in this order — do NOT skip steps):

Step 1 — page_evaluation (fill BEFORE evaluating any element):
  Decide what kind of page this is (page_type) and write one concise sentence describing what the user is most likely trying to do on this page (user_primary_intent). Be specific:
    Good: "buy this wireless mouse", "read the article about climate policy", "cancel my Netflix subscription", "reject cookies and continue reading", "create a new account on this service"
    Bad: "shopping", "browsing", "using the site"
  Every harm test below references user_primary_intent. The harm test for False hierarchy, Disguised ad, Forced Action, etc. all depend on what the user came here to do — so this field is the foundation of every later judgment.

Step 2 — for each candidate dark pattern element, fill the schema fields in this order:
  (a) observed_signals — list 2-6 NEUTRAL, DESCRIPTIVE observations about what you see (e.g., "decline button is 11px gray text, no underline", "checkbox is pre-checked for marketing email opt-in"). Do NOT name the dark pattern type yet. Describe, do not judge.
  (b) harm_test_reasoning — explicitly walk through the harm test for the type you are about to claim. Reference user_primary_intent from Step 1. State the concrete harm: what the user will lose, give up, be charged for, or be tricked into doing. If you cannot state a specific harm grounded in the user's intent on THIS page, STOP and do not include this candidate.
  (c) dark_pattern_type — only commit to a type label after observed_signals + harm_test_reasoning establish that the harm test is satisfied. The type must match the harm test you walked through.
  (d) html_evidence, css_selector, issues, selector_stability — fill as defined later in this prompt.

Filling Step 2 fields out of order (deciding the type first and then writing observations to justify it) is the most common cause of false positives. Always describe before labeling.

Dark pattern taxonomy and few-shot examples:

- Disguised ad:
  Presents advertisements as legitimate interface elements (especially primary action buttons), making users likely to click them while believing they are activating the page's real function.

  Harm test (must be satisfied to label as Disguised ad):
  When the user clicks this element believing it triggers the page's primary action (e.g., adding the visible product to cart, downloading the file shown, selecting the plan being viewed), the click instead navigates to an UNRELATED destination (different product, sponsor's site, homepage, ad partner). If clicking the prominent element does what its label promises in the current page context, this is NOT Disguised ad — it is the real primary action, regardless of how visually prominent it looks.

  Example 1 (IS Disguised ad) — Fake CTA mimicking primary button:
    HTML:
      <div style="font-size: 10px; color: #565959;">Advertisement</div>
      <button style="width:100%; padding:20px; font-size:32px; font-weight:bold;
                     background: linear-gradient(to bottom, #f7dfa5, #f0c14b);
                     color:#111; border:1px solid #a88734; border-radius:8px;">
        ADD TO CART
      </button>
    Context: This button is injected ABOVE the real #addToCart_feature_div on a product page; its onclick redirects to https://www.amazon.com, not to this product's cart.
    Why it IS Disguised ad:
    • Mimics Amazon's native yellow CTA styling exactly (same gradient, same border colors)
    • Larger and more dominant than the real "Add to Cart" button on the same page
    • "Advertisement" label is 10px, low-contrast gray, easy to miss in scan
    • Harm test satisfied: clicking does NOT add the viewed product to cart; it navigates to an unrelated destination

  Example 2 (IS Disguised ad) — Sponsored result mimicking organic listing:
    HTML:
      <div class="s-result-item" data-component-type="s-search-result">
        <span style="font-size:11px; color:#565959;">Sponsored</span>
        <h2 class="a-text-normal">Wireless Headphones — Premium Audio</h2>
        <span class="a-price"><span class="a-offscreen">$49.99</span></span>
        <span class="a-icon-star"><span class="a-icon-alt">4.5 out of 5</span></span>
      </div>
    Why it IS Disguised ad:
    • Uses the exact same DOM structure and CSS classes (s-result-item, a-text-normal, a-price) as organic search results on the same page
    • Only differentiator is an 11px low-contrast "Sponsored" tag
    • Harm test satisfied: a user scanning search results treats this as organically ranked, but its position is paid; the visual parity is the deception

  Counterexample 1 (NOT Disguised ad) — Real Add to Cart on a product page:
    HTML:
      <div id="addToCart_feature_div">
        <span id="submit.add-to-cart" class="a-button a-button-primary">
          <span class="a-button-inner">
            <input id="add-to-cart-button" name="submit.add-to-cart"
                   type="submit" value="Add to Cart" class="a-button-input">
          </span>
        </span>
      </div>
    Why it is NOT Disguised ad:
    • This is a prominent yellow CTA button on an Amazon product page — visually identical asymmetry vs surrounding elements as Example 1
    • BUT clicking it does exactly what its label promises: adds THIS product to the cart on THIS site
    • Harm test NOT satisfied: no destination mismatch, no impersonation
    • "Visually prominent CTA on a product page" is normal e-commerce UX, not a dark pattern. Visual prominence alone is never sufficient evidence.

  Counterexample 2 (NOT Disguised ad) — Honestly labeled banner ad:
    HTML:
      <aside class="ad-slot" aria-label="Advertisement">
        <header style="font-size:14px; font-weight:700;
                       letter-spacing:2px; color:#333;">ADVERTISEMENT</header>
        <a href="https://sponsor.example.com" target="_blank">
          <img src="brand-banner.jpg" alt="Brand X — Shop Now">
        </a>
      </aside>
    Why it is NOT Disguised ad:
    • Clearly labeled with a prominent ADVERTISEMENT header
    • Visually distinct from the page's primary content — separate <aside> region, branded imagery, not styled to mimic a primary action button
    • Harm test NOT satisfied: no user is deceived about what they are clicking; the destination matches the visible advertising intent
    • Having ads on a page is not a dark pattern; DISGUISING them as native primary actions is.

- False hierarchy:
  Uses visual prominence (size, color, contrast, placement) to push users toward the option that benefits the operator at the cost of the user's stated goal on the current page. Important: "one option being more prominent than another" is NOT a dark pattern by itself — that is normal visual hierarchy and good UX. The dark pattern is the prominence being misaligned with what the user came to this page to do.

  Harm test (must be satisfied to label as False hierarchy):
  First identify what the user is trying to do on this specific page (e.g., add this product to cart, cancel a subscription, reject cookies, decline marketing emails). Then look at the visually dominant option. If it pushes the user TOWARD their stated goal on this page, this is correct visual hierarchy and NOT a dark pattern. If it pushes the user AWAY from their stated goal — and the option matching their goal is visually demoted (tiny, gray, low-contrast, hidden link, off-screen, no underline) — this IS False hierarchy.

  Example 1 (IS False hierarchy) — Cookie consent banner with demoted reject:
    HTML:
      <div class="cookie-banner">
        <p>We use cookies to improve your experience.</p>
        <button style="padding:12px 32px; background:#0058a3; color:#fff;
                       border-radius:4px; font-weight:700; font-size:16px;">
          Accept All Cookies
        </button>
        <a href="#" style="font-size:12px; color:#999; text-decoration:underline;">
          Manage preferences
        </a>
      </div>
    Context: User visited the site to read an article. The dominant blue CTA accepts ALL tracking; the only path to reject is a 12px gray text link.
    Why it IS False hierarchy:
    • Two functionally-symmetric choices (accept vs reject tracking) presented with extreme visual asymmetry
    • Accept benefits the site (more tracking data); reject benefits the user (privacy)
    • The privacy-protecting choice is intentionally hard to find
    • Harm test satisfied: user came to read content, not to opt into tracking; the dominant choice pushes user away from their privacy interest

  Example 2 (IS False hierarchy) — Subscription cancellation with retain-bias:
    HTML:
      <div class="cancel-flow-modal">
        <h2>Are you sure you want to cancel?</h2>
        <button style="width:100%; padding:16px; background:#0071e3; color:#fff;
                       border:none; border-radius:8px; font-size:18px; font-weight:700;">
          Keep My Subscription
        </button>
        <a href="/cancel-confirm" style="display:block; margin-top:24px;
                       font-size:11px; color:#aaa; text-decoration:none;">
          cancel anyway
        </a>
      </div>
    Context: User clicked "Cancel subscription" in account settings to reach this modal. The page presents a large primary CTA to retain, and the actual cancel action as 11px gray non-underlined text.
    Why it IS False hierarchy:
    • User's explicit intent on entering this flow: cancel. The page makes cancellation visually subordinate to retention.
    • Retention uses primary brand color, large size, button styling; the cancel action uses the smallest font on the page, low-contrast gray, no link underline
    • Harm test satisfied: the dominant option directly opposes the user's stated goal of cancelling

  Counterexample 1 (NOT False hierarchy) — Product page Add to Cart vs Save for Later:
    HTML:
      <div class="product-actions">
        <button style="width:100%; padding:14px; background:#FFD814;
                       border:1px solid #FCD200; border-radius:8px;
                       font-size:16px; font-weight:700;">
          Add to Cart
        </button>
        <a href="#" style="display:block; margin-top:8px; font-size:13px;
                       color:#0066c0; text-decoration:none;">
          Save for later
        </a>
      </div>
    Why it is NOT False hierarchy:
    • Same visual asymmetry as Example 1 and Example 2 (large primary button vs small text link)
    • BUT the user is on a product detail page; their intent is to acquire this product
    • The dominant CTA matches that intent; "Save for later" is a secondary affordance, not an option being suppressed against the user's interest
    • Harm test NOT satisfied: dominant option is aligned with the user's goal on this page; this is correct visual hierarchy, not a dark pattern

  Counterexample 2 (NOT False hierarchy) — Sign-up form with login link:
    HTML:
      <form>
        <h1>Create your account</h1>
        <input type="email" placeholder="Email">
        <input type="password" placeholder="Password">
        <button style="width:100%; padding:14px; background:#000; color:#fff;
                       border-radius:6px; font-size:16px; font-weight:600;">
          Create Account
        </button>
        <p style="margin-top:16px; font-size:13px; color:#666;">
          Already have an account?
          <a href="/login" style="color:#0066cc;">Log in</a>
        </p>
      </form>
    Why it is NOT False hierarchy:
    • Primary CTA "Create Account" is a large prominent black button; "Log in" is a small inline text link
    • Visual asymmetry IS present, BUT the user landed on a signup page intending to register; the prominent action matches that intent
    • The "Log in" link is a graceful fallback for users who arrived by mistake — it is not the user's blocked goal being suppressed
    • Harm test NOT satisfied: dominant option matches the page's apparent purpose and the user's intent

- Preselection:
  Pre-checks a checkbox, pre-selects a radio option, or pre-toggles a switch for a choice that benefits the operator at the user's expense, where the user must actively notice and reverse it during their primary task. The dark pattern is NOT "anything pre-selected" — that is normal sensible defaults. The dark pattern is the pre-selection extracting something the user did not intend to give up (money, data, consent, time).

  Harm test (must be satisfied to label as Preselection):
  Ask whether the pre-selected option (a) extracts something from the user that benefits the operator (a paid add-on, marketing consent, data sharing, recurring charge, donation tip), AND (b) is presented inside a flow where the user is focused on a different primary task and likely to skip past it without noticing, AND (c) reverses what a careful user would choose if asked deliberately. If the pre-selection is a sensible default that helps the user complete their own task (Remember me, Stay signed in on a personal device, language matching the browser locale, saved shipping address), it is NOT Preselection.

  Example 1 (IS Preselection) — Pre-checked marketing list opt-in at checkout:
    HTML:
      <div class="checkout-extras">
        <input type="checkbox" id="mailing-list" checked>
        <label for="mailing-list">Add me to the mailing list</label>
      </div>
    Context: Pre-ticked checkbox embedded between order summary and the "Continue" button on a checkout page. The user is focused on completing their purchase.
    Why it IS Preselection:
    • The opt-in extracts marketing consent that benefits the operator, not the user
    • Placed inside a focused checkout flow where attention is on placing the order, not auditing every checkbox
    • A user explicitly asked "Do you want marketing emails?" would, on average, decline; the pre-check reverses that default
    • Harm test satisfied: extracts data consent, embedded in a different primary task, reverses the deliberate-choice default

  Counterexample 1 (NOT Preselection) — "Keep me signed in" on login form:
    HTML:
      <form class="login">
        <input type="email" name="email">
        <input type="password" name="password">
        <input type="checkbox" id="remember-me" checked>
        <label for="remember-me">Keep me signed in on this device</label>
        <button type="submit">Sign in</button>
      </form>
    Why it is NOT Preselection:
    • The pre-checked option benefits the user (faster return visits), not the operator
    • Even if the user leaves it checked, the only trade-off is convenience-vs-security on their own device — no extraction
    • Harm test NOT satisfied: no operator-favoring extraction; the default is a usability convenience

  Counterexample 2 (NOT Preselection) — Locale/language preselected from browser:
    HTML:
      <select name="language">
        <option value="en-US" selected>English (United States)</option>
        <option value="es-ES">Español</option>
        <option value="fr-FR">Français</option>
      </select>
    Why it is NOT Preselection:
    • Default option matches the user's browser locale — purely a convenience default
    • The operator does not benefit financially or attentionally from this default
    • Harm test NOT satisfied: nothing is being extracted; this is sensible UX

- Pop-up ad:
  Interrupts the user's primary task with an unrelated promotional overlay where the dismiss path is intentionally hard to use (tiny close button, near-transparent close icon, no close button at all, or "X" placed off-screen). The dark pattern is NOT "any modal" — modals confirming a destructive user-initiated action (delete account, remove from cart) or required disclosures are normal UX. The dark pattern is the combination of (unrelated promotional content) + (degraded dismiss path).

  Harm test (must be satisfied to label as Pop-up ad):
  Check whether (a) the modal contains promotional content unrelated to what the user just did, AND (b) the close/dismiss control is degraded relative to the modal's primary CTA (extreme size mismatch, low-contrast color, hidden in a corner, near-transparent, or absent). A modal where the user explicitly opened it (clicked Delete, clicked Sign in) and the close button is normal-sized is NOT Pop-up ad.

  Example 1 (IS Pop-up ad) — Subscription upsell modal with near-invisible close:
    HTML:
      <div style="position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:9998;"></div>
      <div style="position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
                  width:400px; padding:24px; background:#fff; border-radius:16px; z-index:9999;">
        <h1 style="font-size:36px; font-weight:700;">Uber One</h1>
        <p>$0 Delivery Fee + up to 10% off Uber One</p>
        <button style="width:100%; padding:14px; background:black; color:white;
                       border-radius:8px; font-size:16px;">
          Try free for 4 weeks
        </button>
      </div>
      <button style="position:fixed; top:15px; right:20px; font-size:35px;
                     color:rgba(255,255,255,0.2); background:transparent; border:none;
                     z-index:10000;">×</button>
    Context: Modal appears unprompted on the home page. The "X" close button is positioned outside the modal at the top-right of the page, rendered in 20%-opacity white that is nearly invisible against most page backgrounds.
    Why it IS Pop-up ad:
    • Promotional content unrelated to user's current activity (was browsing, not subscribing)
    • Primary CTA is full-width prominent black button with bold label
    • Dismiss control uses 20% opacity — visually almost absent
    • Harm test satisfied: unrelated promotion + heavily degraded dismiss path

  Counterexample 1 (NOT Pop-up ad) — User-triggered confirmation modal:
    HTML:
      <div role="dialog" style="position:fixed; top:50%; left:50%;
                                 transform:translate(-50%,-50%); padding:24px;
                                 background:#fff; border-radius:8px;
                                 box-shadow:0 4px 12px rgba(0,0,0,0.15);">
        <h2>Delete your account?</h2>
        <p>This action cannot be undone. All your data will be permanently removed.</p>
        <button style="background:#fff; border:1px solid #ccc; padding:10px 16px;">
          Cancel
        </button>
        <button style="background:#d32f2f; color:#fff; border:none; padding:10px 16px;">
          Delete account
        </button>
      </div>
    Why it is NOT Pop-up ad:
    • User explicitly clicked "Delete account" to reach this modal — it is not unprompted promotional content
    • Both options are clearly visible and equally accessible
    • The "Cancel" path back to safety is a normal-sized button, not a degraded dismiss control
    • Harm test NOT satisfied: required confirmation UX directly tied to a destructive user-initiated action

- Trick wording:
  Uses double negatives, semantically reversed phrasing, or label/action mismatches on interactive controls so a casual reader selects the opposite of what they intend (e.g., labels the opt-in button with negative phrasing so it reads like a decline). The dark pattern is in the WORDING ON THE CONTROL ITSELF being structured to invert intuitive interpretation.

  Harm test (must be satisfied to label as Trick wording):
  Read the button/checkbox/radio label aloud and ask: would a hurried user, scanning quickly, interpret this label as the opposite of what it actually does? Common patterns include double negatives ("I do not want no notifications"), reversed checkbox logic ("Uncheck to opt out"), and CTA labels that conceal a paid commitment ("Get started" on a page that initiates a subscription). Standard, plain-English labels ("Subscribe", "Cancel", "Decline", "No thanks") are NOT Trick wording even when paired with strong visual emphasis.

  Example 1 (IS Trick wording) — Double-negative notification prompt:
    HTML:
      <div class="notification-modal">
        <p>Amazon would like to send you notifications</p>
        <button class="notification-popup-button">I want no notifications</button>
        <button class="notification-popup-button">I do not want no notifications</button>
      </div>
    Context: Two buttons of equal styling. Their labels use double negatives. A user reading "I do not want no notifications" parses it as "I do not want notifications" and clicks — but the button is wired to opt the user IN.
    Why it IS Trick wording:
    • Both labels contain "no notifications", camouflaging the actual difference
    • The decisive negation ("do not want") inverts the meaning in a way casual readers miss
    • The semantic reversal happens in the LABEL itself, regardless of styling
    • Harm test satisfied: a hurried user clicks the button whose label sounds like decline and ends up subscribed

  Counterexample 1 (NOT Trick wording) — Standard notification permission prompt:
    HTML:
      <div class="notification-modal">
        <p>Allow notifications from this site?</p>
        <button>Block</button>
        <button>Allow</button>
      </div>
    Why it is NOT Trick wording:
    • Each label maps directly and unambiguously to its action
    • No double negation, no inversion, no concealed commitment
    • A user reading either label correctly predicts what clicking does
    • Harm test NOT satisfied: standard plain-English labels with intuitive meaning

- Confirm shaming:
  Labels the decline/opt-out option with text that shames or guilts the user for choosing the safe/free choice — framing the decline as foolish, irresponsible, or self-destructive. The dark pattern is the LABEL on the decline button, not the existence of a decline option or its visual treatment.

  Harm test (must be satisfied to label as Confirm shaming):
  Read the decline option’s label and ask: does it use first-person voice that makes the user disparage themselves ("No, I’d rather miss out", "No, I don’t care about my safety", "No, I prefer to pay full price")? Or does it frame the safe choice as foolish behavior in third-person? A neutral decline label ("No thanks", "Skip", "Maybe later", "Not now", "Decline", "Close") is NOT Confirm shaming, even when visually demoted next to a colorful Accept button. The signal is in the WORDING, not the styling.

  Example 1 (IS Confirm shaming) — Newsletter signup with self-shaming decline:
    HTML:
      <div class="signup-modal">
        <h2>Stay up to date! Would you like to receive notifications about our best deals?</h2>
        <button class="primary-btn">Yes, please</button>
        <button class="primary-btn">No, I’d rather miss out on savings.</button>
      </div>
    Context: A newsletter or notification opt-in modal. The decline button uses first-person voice that frames declining as self-harm.
    Why it IS Confirm shaming:
    • The decline label puts a shame-inducing self-statement in the user’s mouth
    • "Miss out on savings" emotionally reframes a routine "no thanks" as a loss the user is volunteering for
    • The wording is the manipulation; the styling is incidental
    • Harm test satisfied: decline label uses self-disparaging first-person framing

  Counterexample 1 (NOT Confirm shaming) — Newsletter signup with neutral decline:
    HTML:
      <div class="signup-modal">
        <h2>Subscribe to our newsletter</h2>
        <button class="primary-btn">Subscribe</button>
        <button class="link-btn">No thanks</button>
      </div>
    Why it is NOT Confirm shaming:
    • Decline label is the standard neutral phrase "No thanks"
    • Even though "Subscribe" is visually more prominent, the decline carries no shame language
    • A user declining feels neither guilty nor foolish from the wording itself
    • Harm test NOT satisfied: decline label is plain and neutral; visual asymmetry alone is not Confirm shaming

- Fake social proof:
  Displays a popularity/urgency/credibility signal that is unverifiable or known to be artificially generated, used to manipulate the user toward a specific action ("99% of customers add this", "Only 2 left in stock", "Booked 47 times today", "John from NYC just purchased this"). The dark pattern is the use of an UNVERIFIABLE claim of social consensus to pressure a decision.

  Harm test (must be satisfied to label as Fake social proof):
  Look at the social signal and ask: (a) Is the source of the claim disclosed? (b) Could the user verify it from public, audited data? (c) Is it being used to pressure a specific decision (urgency, scarcity, consensus)? If the answer to (a) or (b) is "no" AND (c) is "yes", this is Fake social proof. A genuine review aggregate from a published, linkable source ("4.7 ★ from 8,234 verified buyers, see all reviews →") is NOT Fake social proof.

  Example 1 (IS Fake social proof) — Unverifiable consensus claim on upsell:
    HTML:
      <div class="protection-popup">
        <h2>Don't Forget Your Protection Plan!</h2>
        <p>9 out of 10 savvy shoppers protect their purchase from accidental damage and malfunctions. Don't miss out!</p>
        <button class="popup-button-primary">Yes, Add Protection</button>
        <button class="popup-button-secondary">No thanks</button>
      </div>
    Context: A protection plan upsell modal that quotes a consensus statistic with no source, no methodology, and no link to verify the population from which "9 out of 10" was computed.
    Why it IS Fake social proof:
    • The "9 out of 10" claim has no published source or methodology
    • Flattering framing ("savvy shoppers") signals the claim's purpose is persuasion, not information
    • The signal is used to pressure a specific decision (add the upsell) under emotional framing ("Don't miss out")
    • Harm test satisfied: unverifiable + unsourced + used as decision pressure

  Counterexample 1 (NOT Fake social proof) — Verifiable aggregate review rating:
    HTML:
      <div class="reviews-summary">
        <span class="rating">4.7</span>
        <span class="stars">★★★★★</span>
        <a href="/reviews?sort=verified">See 8,234 verified reviews</a>
      </div>
    Why it is NOT Fake social proof:
    • The rating is an aggregate the user can drill into and audit
    • The link goes to the underlying reviews, filterable by verified-purchase status
    • The signal informs rather than pressures — no urgency framing, no "don't miss out"
    • Harm test NOT satisfied: source disclosed, verifiable, not used as urgency pressure

- Forced Action:
  Blocks the user’s actual task with an unrelated demand (sign up, install app, take a survey, accept marketing, share contacts) and either (a) presents the unrelated demand as if it were required when it is not, OR (b) hides/severely demotes the skip path. The dark pattern is the coercion: making a non-essential action feel mandatory.

  Harm test (must be satisfied to label as Forced Action):
  Identify what the user is trying to do (read article, complete checkout, view product). Then ask: is the page demanding an unrelated action (account, app install, survey, contact import) before letting them proceed? Is the skip option hidden, made nearly invisible (small font, low opacity, no underline, gray-on-white), or absent? Genuine authentication requirements (banking, identity-verified services), age verification on regulated content, and required legal disclosures are NOT Forced Action — those demands are intrinsic to the requested service.

  Example 1 (IS Forced Action) — App install demand with hidden web continue:
    HTML:
      <div class="modal">
        <img src="app-icon.png" alt="App icon">
        <h2>Open in the Yelp App to Continue</h2>
        <p>For the fastest experience — write reviews, message businesses, and access app-only perks — please use the Yelp app.</p>
        <button style="background:#d32323; color:#fff; padding:14px;
                       border-radius:4px; font-size:16px; font-weight:bold;">
          Download Yelp App
        </button>
        <button style="background:none; border:none; color:#6e6e70;
                       font-size:13px; opacity:0.25;">
          Skip
        </button>
      </div>
    Context: User opened the website on a mobile browser. The page can render the requested content directly, but a modal demands installing the native app. The "Skip" option is rendered at 25% opacity, almost invisible against the white background.
    Why it IS Forced Action:
    • The demanded action (install app) is unrelated to the user’s task (browse a business)
    • The web alternative exists technically but is hidden behind a 25%-opacity skip control
    • Visual treatment makes "Download" feel mandatory and "Skip" feel like a non-option
    • Harm test satisfied: unrelated demand blocking primary task with severely demoted skip path

  Counterexample 1 (NOT Forced Action) — Bank login required for account access:
    HTML:
      <form class="login-form">
        <h1>Sign in to your account</h1>
        <input type="text" name="username" placeholder="Username">
        <input type="password" name="password" placeholder="Password">
        <button type="submit" class="btn-primary">Sign in</button>
        <a href="/forgot-password">Forgot password?</a>
      </form>
    Why it is NOT Forced Action:
    • The user is trying to access account-specific banking functionality, which intrinsically requires authentication
    • The demand (log in) is directly tied to the requested service, not unrelated
    • There is no skip option because the requested operation is impossible without authentication — by design, not by manipulation
    • Harm test NOT satisfied: required action is intrinsic to the user’s task, not coerced extra friction

- Hidden information:
  Conceals decision-critical information (additional fees, recurring billing, return restrictions, data sharing scope, mandatory add-ons) behind extra clicks, fine-print, "Learn more" toggles, or post-commitment reveals — so the user makes a decision without seeing the full implication. The dark pattern is the gap between the visible decision context and the actual commitment.

  Harm test (must be satisfied to label as Hidden information):
  Identify the decision the user is being asked to make on this page (purchase, subscribe, accept terms, place order). Then ask: is information that would materially change a careful user's decision (true total cost, recurring billing terms, mandatory add-ons, data sale to third parties, key restrictions) hidden behind a non-default reveal — collapsed disclosure, "Learn more" toggle, footnote, or only shown after the user commits? Optional drill-down to non-essential details (general FAQ, full terms in legal language, shipping carrier choice) is NOT Hidden information — that is normal progressive disclosure.

  Example 1 (IS Hidden information) — Mandatory fees concealed behind disclosure toggle:
    HTML:
      <div class="product-actions">
        <span class="price">$24.99</span>
        <button class="see-fee-btn" style="background:none; border:none;
                color:#808080; font-size:0.9rem;">
          See extra fee of this product
        </button>
        <div class="fees-section" style="display:none;">
          <p>Fragile Item Insurance: $12.99 (mandatory coverage for breakage during shipping)</p>
          <p>Additional Handling Fee: $8.50 (special packaging and transport for delicate items)</p>
        </div>
        <button class="btn-primary">Add to Cart</button>
      </div>
    Context: The headline price reads $24.99. Mandatory unavoidable fees totaling $21.49 are concealed inside a low-contrast text button labeled "See extra fee of this product" — a user who clicks Add to Cart without expanding the disclosure does not see the true ~88% price increase.
    Why it IS Hidden information:
    • The hidden fees are mandatory, not optional — they are decision-critical
    • The disclosure toggle is styled as a low-contrast text link, not part of the visible price
    • A user proceeding to "Add to Cart" without clicking the toggle commits without seeing the true cost
    • Harm test satisfied: material cost information hidden behind a non-default reveal at the moment of commitment

  Counterexample 1 (NOT Hidden information) — Collapsible FAQ for general help:
    HTML:
      <section class="faq">
        <h2>Frequently Asked Questions</h2>
        <details>
          <summary>How long does shipping take?</summary>
          <p>Standard shipping takes 3-5 business days. Express options available at checkout.</p>
        </details>
        <details>
          <summary>What is your return policy?</summary>
          <p>Free returns within 30 days. See our full return policy for details.</p>
        </details>
      </section>
    Why it is NOT Hidden information:
    • Collapsed content is general help info, not material to the immediate purchase decision (which has its own visible cost and policy summary)
    • The disclosure pattern is normal progressive disclosure for non-essential reference material
    • Nothing decision-critical is hidden — the user can place an order without expanding any FAQ
    • Harm test NOT satisfied: no concealment of decision-critical information; this is standard reference UX

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

1. Identify every dark pattern present on the page — there is no maximum. But each one must independently pass its harm test; the anti-padding rule above still holds (an empty list beats weak candidates).
2. Rank them from most obvious to least obvious.
3. Use the screenshot first to spot candidate dark patterns across the full page; then use the HTML as secondary support to confirm details and pin down the exact element.
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

Now analyze the following webpage. A screenshot of the page is provided separately as a vision input alongside this prompt — refer to it for visual confirmation; do not expect the screenshot bytes inside this text.

Current page URL: ${input.pageUrl}

Truncated HTML:
${input.truncatedHtml}`;

  step.finish({
    pageKey: input.pageKey,
    promptLength: prompt.length
  });

  return prompt;
}
