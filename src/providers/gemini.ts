import { AI_CONFIG } from "../config";
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
    if (!config.apiKey) {
      throw new Error("Configure GEMINI_API_KEY in .env before running the Gemini provider.");
    }

    const screenshot = parseDataUrl(input.screenshotDataUrl);
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

    return JSON.parse(content) as DetectionResult;
  },

  isConfigured(): boolean {
    return Boolean(AI_CONFIG.providers.gemini.apiKey);
  }
};
