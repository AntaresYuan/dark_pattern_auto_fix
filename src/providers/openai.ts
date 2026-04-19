import { AI_CONFIG, hasConfiguredValue } from "../config";
import { safeUrl, startStep, summarizeDataUrl } from "../shared/logger";
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

interface ProviderError extends Error {
  httpStatus?: number;
  responseBodyLength?: number;
}

export const openAIProvider: DetectionProvider = {
  async detectDarkPatterns(input: DetectionProviderInput): Promise<DetectionResult> {
    const config = AI_CONFIG.providers.gpt;
    const step = startStep("provider", "openai.detect", {
      model: config.model,
      apiBaseUrl: safeUrl(config.apiBaseUrl),
      pageKey: input.pageKey,
      requestPath: "/chat/completions",
      usesProxy: Boolean(config.proxyUrl),
      promptLength: input.prompt.length,
      screenshot: summarizeDataUrl(input.screenshotDataUrl),
      traceId: input.traceId
    });

    try {
      const endpoint = config.proxyUrl || `${config.apiBaseUrl}/chat/completions`;
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
              content: [
                {
                  type: "text",
                  text: input.prompt
                },
                {
                  type: "image_url",
                  image_url: {
                    url: input.screenshotDataUrl
                  }
                }
              ]
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

      const responseText = await response.text();
      if (!response.ok) {
        const error = new Error(`OpenAI request failed with ${response.status}`) as ProviderError;
        error.httpStatus = response.status;
        error.responseBodyLength = responseText.length;
        throw error;
      }

      const payload = JSON.parse(responseText) as ChatCompletionsResponse;
      const content = payload.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error("OpenAI returned an empty response.");
      }

      const result = JSON.parse(content) as DetectionResult;
      step.finish({
        httpStatus: response.status,
        responseBodyLength: responseText.length,
        contentLength: content.length,
        patternCount: result.identified_dark_patterns.length
      });
      return result;
    } catch (error) {
      const providerError = error as ProviderError;
      step.fail(error, {
        httpStatus: providerError.httpStatus,
        responseBodyLength: providerError.responseBodyLength
      });
      throw error;
    }
  },

  isConfigured(): boolean {
    const config = AI_CONFIG.providers.gpt;
    return Boolean(config.proxyUrl || hasConfiguredValue(config.apiKey));
  }
};
