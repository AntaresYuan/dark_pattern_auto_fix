import type { DetectionResult } from "../shared/types";

export interface DetectionProviderInput {
  pageKey?: string;
  prompt: string;
  screenshotDataUrl: string;
  traceId?: string;
}

export interface DetectionProvider {
  detectDarkPatterns(input: DetectionProviderInput): Promise<DetectionResult>;
  isConfigured(): boolean;
}
