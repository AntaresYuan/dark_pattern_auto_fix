import { logEvent, safeUrl } from "./shared/logger";

export type ProviderName = "gpt" | "gemini";

export const AI_CONFIG = {
  // Change only this line to switch providers: "gpt" or "gemini".
  activeProvider: "gpt" as ProviderName,
  //activeProvider: "gemini" as ProviderName,
  providers: {
    gpt: {
      // Prefer a proxy endpoint for production so your API key does not ship inside the extension.
      proxyUrl: "",
      // Build script injects GPT_API_KEY from .env for local prototyping.
      apiKey: "__GPT_API_KEY__",
      // Change this model when activeProvider is "gpt".
      model: "gpt-5-mini",
      apiBaseUrl: "https://api.openai.com/v1",
    },
    gemini: {
      // Build script injects GEMINI_API_KEY from .env for local prototyping.
      apiKey: "__GEMINI_API_KEY__",
      // Change this model when activeProvider is "gemini".
      model: "gemini-3-flash-preview",
      apiBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    },
  },
} as const;

export function hasConfiguredValue(value: string): boolean {
  return Boolean(value && !value.startsWith("__"));
}

logEvent("provider", "config.snapshot", {
  activeProvider: AI_CONFIG.activeProvider,
  gpt: {
    model: AI_CONFIG.providers.gpt.model,
    apiBaseUrl: safeUrl(AI_CONFIG.providers.gpt.apiBaseUrl),
    hasProxyUrl: Boolean(AI_CONFIG.providers.gpt.proxyUrl),
    hasApiKey: hasConfiguredValue(AI_CONFIG.providers.gpt.apiKey)
  },
  gemini: {
    model: AI_CONFIG.providers.gemini.model,
    apiBaseUrl: safeUrl(AI_CONFIG.providers.gemini.apiBaseUrl),
    hasApiKey: hasConfiguredValue(AI_CONFIG.providers.gemini.apiKey)
  }
});
