import { AI_CONFIG } from "../config";
import { safeUrl, startStep, summarizeDataUrl, truncateText } from "../shared/logger";
import { DARK_PATTERN_SCHEMA } from "../shared/schema";
import type { DetectionResult } from "../shared/types";
import type { DetectionProvider, DetectionProviderInput } from "./types";

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

/**
 * Gemini compiles `responseJsonSchema` into a constrained-decoding FSM before
 * generation; the canonical DARK_PATTERN_SCHEMA trips its "too many states for
 * serving" limit (400) because of long `description` text, nested `maxItems`
 * arrays, and `anyOf` unions. This strips those state-multiplying constructs at
 * send time ONLY — the canonical schema (and the OpenAI path, which doesn't hit
 * this limit) are left untouched. Enum values and field shapes are preserved, so
 * downstream parsing is unaffected; the guidance the descriptions carried already
 * lives in prompt.ts. Reversible: delete this and pass DARK_PATTERN_SCHEMA raw.
 */
function stripSchemaForGemini(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(stripSchemaForGemini);
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    // Collapse `anyOf: [{type:"string"}, {type:"null"}]` to its single non-null branch.
    if (Array.isArray(obj.anyOf)) {
      const nonNull = obj.anyOf.filter(
        (branch) => !(branch && typeof branch === "object" && (branch as Record<string, unknown>).type === "null")
      );
      if (nonNull.length === 1) {
        const { anyOf, ...rest } = obj;
        return stripSchemaForGemini({ ...rest, ...(nonNull[0] as Record<string, unknown>) });
      }
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      // `description` is redundant with prompt.ts; `maxItems`/`minItems` force the
      // FSM to unroll arrays N times (the dominant state multiplier).
      if (key === "description" || key === "maxItems" || key === "minItems") continue;
      out[key] = stripSchemaForGemini(value);
    }
    return out;
  }
  return node;
}

const GEMINI_RESPONSE_SCHEMA = stripSchemaForGemini(DARK_PATTERN_SCHEMA);

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

export const geminiProvider: DetectionProvider = {
  async detectDarkPatterns(input: DetectionProviderInput): Promise<DetectionResult> {
    const config = AI_CONFIG.providers.gemini;

    const step = startStep("provider", "gemini.detect", {
      endpoint: safeUrl(`${config.apiBaseUrl}/models/${config.model}:generateContent`),
      model: config.model,
      pageKey: input.pageKey,
      promptLength: input.prompt.length,
      screenshot: input.screenshotDataUrl ? summarizeDataUrl(input.screenshotDataUrl) : null,
      traceId: input.traceId
    });

    try {
      if (!config.apiKey) {
        throw new Error("Configure GEMINI_API_KEY in .env before running the Gemini provider.");
      }

      const parts: GeminiPart[] = [{ text: input.prompt }];

      if (input.screenshotDataUrl) {
        // Strip the data URL prefix to get raw base64
        const base64 = input.screenshotDataUrl.replace(/^data:image\/\w+;base64,/, "");
        parts.push({ inlineData: { mimeType: "image/jpeg", data: base64 } });
      }

      const endpoint = `${config.apiBaseUrl}/models/${config.model}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            responseMimeType: "application/json",
            responseJsonSchema: GEMINI_RESPONSE_SCHEMA
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Gemini request failed with ${response.status}: ${await response.text()}`);
      }

      const payload = (await response.json()) as GeminiGenerateContentResponse;
      const content = payload.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? "")
        .join("")
        .trim();

      if (!content) {
        throw new Error("Gemini returned an empty response.");
      }

      const result = JSON.parse(content) as DetectionResult;
      step.finish({
        patternCount: result.identified_dark_patterns.length,
        patterns: result.identified_dark_patterns.map((p) => ({
          type: p.dark_pattern_type,
          htmlEvidence: truncateText(p.html_evidence, 120)
        }))
      });
      return result;
    } catch (error) {
      step.fail(error, { pageKey: input.pageKey, traceId: input.traceId });
      throw error;
    }
  },

  isConfigured(): boolean {
    return Boolean(AI_CONFIG.providers.gemini.apiKey);
  }
};
