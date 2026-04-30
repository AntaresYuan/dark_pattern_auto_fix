import { AI_CONFIG } from "../config";
import { safeUrl, startStep } from "../shared/logger";
import { DARK_PATTERN_SCHEMA } from "../shared/schema";
import type { DetectionResult } from "../shared/types";
import type { DetectionProvider, DetectionProviderInput } from "./types";

interface ChatCompletionsResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export const openAIProvider: DetectionProvider = {
  async detectDarkPatterns(input: DetectionProviderInput): Promise<DetectionResult> {
    const config = AI_CONFIG.providers.gpt;
    const endpoint = config.proxyUrl || `${config.apiBaseUrl}/chat/completions`;

    const step = startStep("provider", "openai.detect", {
      endpoint: safeUrl(endpoint),
      model: config.model,
      pageKey: input.pageKey,
      promptLength: input.prompt.length,
      traceId: input.traceId
    });

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json"
      };

      if (!config.proxyUrl) {
        if (!config.apiKey) {
          throw new Error("Configure GPT_API_KEY in .env or set an OpenAI proxyUrl before running the extension.");
        }

        headers.Authorization = `Bearer ${config.apiKey}`;
      }

      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: config.model,
          messages: [
            {
              role: "user",
              content: input.prompt
            }
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "dark_pattern_detection",
              strict: true,
              schema: DARK_PATTERN_SCHEMA
            }
          }
        })
      });

      if (!response.ok) {
        throw new Error(`OpenAI request failed with ${response.status}: ${await response.text()}`);
      }

      const payload = (await response.json()) as ChatCompletionsResponse;
      const content = payload.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error("OpenAI returned an empty response.");
      }

      const result = JSON.parse(content) as DetectionResult;
      step.finish({
        patternCount: result.identified_dark_patterns.length,
        patterns: result.identified_dark_patterns.map((p) => ({
          type: p.dark_pattern_type,
          selector: p.css_selector
        }))
      });
      return result;
    } catch (error) {
      step.fail(error, { pageKey: input.pageKey, traceId: input.traceId });
      throw error;
    }
  },

  isConfigured(): boolean {
    const config = AI_CONFIG.providers.gpt;
    return Boolean(config.proxyUrl || config.apiKey);
  }
};
