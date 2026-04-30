export const DARK_PATTERN_SCHEMA = {
  type: "object",
  properties: {
    identified_dark_patterns: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: {
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
        required: ["dark_pattern_type", "html_evidence", "css_selector", "issues", "selector_stability"],
        additionalProperties: false
      }
    },
    template_match_features: {
      type: "object",
      properties: {
        url_path_tokens: {
          type: "array",
          maxItems: 6,
          items: { type: "string" }
        },
        required_attributes: {
          type: "array",
          maxItems: 12,
          items: { type: "string" }
        },
        optional_attributes: {
          type: "array",
          maxItems: 10,
          items: { type: "string" }
        },
        negative_attributes: {
          type: "array",
          maxItems: 8,
          items: { type: "string" }
        },
        fingerprint_tokens: {
          type: "array",
          maxItems: 15,
          items: { type: "string" }
        },
        match_confidence: {
          type: "string",
          enum: ["high", "medium", "low"]
        },
        url_shape: {
          anyOf: [{ type: "string" }, { type: "null" }]
        }
      },
      required: [
        "url_path_tokens",
        "required_attributes",
        "optional_attributes",
        "negative_attributes",
        "fingerprint_tokens",
        "match_confidence",
        "url_shape"
      ],
      additionalProperties: false
    }
  },
  required: [
    "identified_dark_patterns",
    "template_match_features"
  ],
  additionalProperties: false
} as const;
