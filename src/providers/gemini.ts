import { AI_CONFIG } from "../config";
import { DARK_PATTERN_SCHEMA } from "../shared/schema";
import type { DetectionResult } from "../shared/types";
import type { DetectionProvider, DetectionProviderInput } from "./types";

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

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
