import { AI_CONFIG, hasConfiguredValue } from "../config";
import { safeUrl, startStep, summarizeDataUrl } from "../shared/logger";
import { DARK_PATTERN_SCHEMA } from "../shared/schema";
import type { DetectionResult } from "../shared/types";
import type { DetectionProvider, DetectionProviderInput } from "./types";

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
}

interface ProviderError extends Error {
  httpStatus?: number;
  responseBodyLength?: number;
  mimeType?: string;
  dataLength?: number;
}

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } {
  const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);
  if (!match) {
    throw new Error("Screenshot data URL was not in the expected base64 format.");
  }

  return {
    mimeType: match[1],
    data: match[2]
  };
}

export const geminiProvider: DetectionProvider = {
  async detectDarkPatterns(input: DetectionProviderInput): Promise<DetectionResult> {
    const config = AI_CONFIG.providers.gemini;
    const step = startStep("provider", "gemini.detect", {
      endpoint: safeUrl(`${config.apiBaseUrl}/models/${config.model}:generateContent`),
      model: config.model,
      apiBaseUrl: safeUrl(config.apiBaseUrl),
      pageKey: input.pageKey,
      promptLength: input.prompt.length,
      screenshot: summarizeDataUrl(input.screenshotDataUrl),
      traceId: input.traceId
    });

    try {
      if (!config.apiKey) {
        throw new Error("Configure GEMINI_API_KEY in .env before running the Gemini provider.");
      }

    const endpoint = `${config.apiBaseUrl}/models/${config.model}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: input.prompt
              }
            ]
      const parseStep = startStep("provider", "gemini.parseScreenshot", {
        dataUrlLength: input.screenshotDataUrl.length,
        pageKey: input.pageKey,
        traceId: input.traceId
      });
      let screenshot: { mimeType: string; data: string };
      try {
        screenshot = parseDataUrl(input.screenshotDataUrl);
        parseStep.finish({
          mimeType: screenshot.mimeType,
          dataLength: screenshot.data.length
        });
      } catch (error) {
        parseStep.fail(error);
        throw error;
      }

      const endpoint = `${config.apiBaseUrl}/models/${config.model}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: input.prompt
                },
                {
                  inline_data: {
                    mime_type: screenshot.mimeType,
                    data: screenshot.data
                  }
                }
              ]
            }
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseJsonSchema: DARK_PATTERN_SCHEMA
          }
        })
      });

      const responseText = await response.text();
      if (!response.ok) {
        const error = new Error(`Gemini request failed with ${response.status}`) as ProviderError;
        error.httpStatus = response.status;
        error.responseBodyLength = responseText.length;
        throw error;
      }

      const payload = (JSON.parse(responseText) as GeminiGenerateContentResponse);
      const content = payload.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? "")
        .join("")
        .trim();

      if (!content) {
        throw new Error("Gemini returned an empty response.");
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
        responseBodyLength: providerError.responseBodyLength,
        mimeType: providerError.mimeType,
        dataLength: providerError.dataLength
      });
      throw error;
    }
  },

  isConfigured(): boolean {
    return hasConfiguredValue(AI_CONFIG.providers.gemini.apiKey);
  }
};
