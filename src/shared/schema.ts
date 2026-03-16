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
          }
        },
        required: ["dark_pattern_type", "css_selector", "issues"],
        additionalProperties: false
      }
    }
  },
  required: ["identified_dark_patterns"],
  additionalProperties: false
} as const;
