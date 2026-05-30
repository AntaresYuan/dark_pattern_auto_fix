export const DARK_PATTERN_SCHEMA = {
  type: "object",
  properties: {
    page_evaluation: {
      type: "object",
      description: "Identify the page context BEFORE evaluating any element. Every harm test below references the user's primary intent on this page.",
      properties: {
        page_type: {
          type: "string",
          enum: [
            "product_detail",
            "product_listing",
            "checkout",
            "cart",
            "homepage",
            "article",
            "sign_up",
            "sign_in",
            "account_settings",
            "subscription_management",
            "cookie_consent_overlay",
            "other"
          ],
          description: "What kind of page is this? Choose the closest match."
        },
        user_primary_intent: {
          type: "string",
          description: "One concise sentence describing what the user is most likely trying to do on THIS specific page (e.g., 'buy this wireless mouse', 'read the article about X', 'cancel my subscription', 'reject cookies and continue reading'). Be specific — 'shopping' is too vague."
        }
      },
      required: ["page_type", "user_primary_intent"],
      additionalProperties: false
    },
    identified_dark_patterns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          observed_signals: {
            type: "array",
            maxItems: 6,
            items: { type: "string" },
            description: "List 2-6 NEUTRAL, DESCRIPTIVE observations about what you see in the HTML or visual layout for this candidate element. Do NOT name the dark pattern type yet. Examples: 'decline button is 11px gray text, no underline', 'CTA button label says ADD TO CART but onclick navigates to a different URL', 'checkbox is pre-checked for marketing email opt-in', '99% statistic stated with no source link'."
          },
          harm_test_reasoning: {
            type: "string",
            description: "Walk through the harm test for the dark pattern type you are about to claim. Reference page_evaluation.user_primary_intent above. Articulate the CONCRETE HARM — what the user will lose, give up, or be tricked into doing. If you cannot point to a specific harm grounded in the user's intent on THIS page, do NOT include this item in the list — return an empty list rather than padding."
          },
          dark_pattern_type: {
            type: "string",
            enum: [
              "Disguised ad",
              "False hierarchy",
              "Preselection",
              "Pop-up ad",
              "Trick wording",
              "Confirm shaming",
              "Fake social proof",
              "Forced Action",
              "Hidden information"
            ]
          },
          html_evidence: {
            type: "string",
            description: "The exact opening tag (or 1-2 lines) of the target element, copied verbatim from the provided HTML. Must include its actual class names and attributes."
          },
          css_selector: {
            type: "string"
          },
          issues: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "color",
                "font_size",
                "background_color",
                "add_advertisement_title",
                "enhance_advertisement_title"
              ]
            }
          },
          selector_stability: {
            type: "string",
            enum: ["stable", "dynamic"]
          }
        },
        required: [
          "observed_signals",
          "harm_test_reasoning",
          "dark_pattern_type",
          "html_evidence",
          "css_selector",
          "issues",
          "selector_stability"
        ],
        additionalProperties: false
      }
    },
  },
  required: [
    "page_evaluation",
    "identified_dark_patterns"
  ],
  additionalProperties: false
} as const;
