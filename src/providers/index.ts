import { AI_CONFIG, type ProviderName } from "../config";
import type { DetectionResult } from "../shared/types";
import { geminiProvider } from "./gemini";
import { openAIProvider } from "./openai";
import type { DetectionProvider, DetectionProviderInput } from "./types";

const providers: Record<ProviderName, DetectionProvider> = {
  gpt: openAIProvider,
  gemini: geminiProvider
};

function getActiveProvider() {
  return providers[AI_CONFIG.activeProvider];
}

export async function detectDarkPatterns(input: DetectionProviderInput): Promise<DetectionResult> {
  return getActiveProvider().detectDarkPatterns(input);
}

export function hasConfiguredDetectionProvider(): boolean {
  return getActiveProvider().isConfigured();
}

export function getActiveProviderName(): ProviderName {
  return AI_CONFIG.activeProvider;
}
