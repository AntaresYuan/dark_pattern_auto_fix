import { AI_CONFIG, hasConfiguredValue, type ProviderName } from "../config";
import { logEvent, safeUrl, startStep, summarizeDataUrl, summarizeDetectionResult } from "../shared/logger";
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
  const providerName = AI_CONFIG.activeProvider;
  const provider = getActiveProvider();
  const step = startStep("provider", "detectDarkPatterns", {
    activeModel: AI_CONFIG.providers[providerName].model,
    provider: providerName,
    configured: provider.isConfigured(),
    config: {
      apiBaseUrl: safeUrl(AI_CONFIG.providers[providerName].apiBaseUrl),
      gptConfigured: Boolean(AI_CONFIG.providers.gpt.proxyUrl || hasConfiguredValue(AI_CONFIG.providers.gpt.apiKey)),
      geminiConfigured: hasConfiguredValue(AI_CONFIG.providers.gemini.apiKey),
      hasProxy: Boolean(AI_CONFIG.providers.gpt.proxyUrl)
    },
    pageKey: input.pageKey,
    promptLength: input.prompt.length,
    screenshot: summarizeDataUrl(input.screenshotDataUrl),
    traceId: input.traceId
  });

  try {
    const result = await provider.detectDarkPatterns(input);
    step.finish(summarizeDetectionResult(result));
    return result;
  } catch (error) {
    step.fail(error);
    throw error;
  }
}

export function hasConfiguredDetectionProvider(): boolean {
  const configured = getActiveProvider().isConfigured();
  logEvent("provider", "provider.config.check", {
    activeProvider: AI_CONFIG.activeProvider,
    configured
  }, configured ? "debug" : "warn");
  return configured;
}

export function getActiveProviderName(): ProviderName {
  return AI_CONFIG.activeProvider;
}

logEvent("provider", "provider.selected", {
  activeProvider: AI_CONFIG.activeProvider,
  configured: getActiveProvider().isConfigured(),
  model: AI_CONFIG.providers[AI_CONFIG.activeProvider].model
});
