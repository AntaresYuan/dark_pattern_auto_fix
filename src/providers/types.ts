import type { DetectionResult } from "../shared/types";

export interface DetectionProviderInput {
  prompt: string;
  screenshotDataUrl: string;
}

export interface DetectionProvider {
  detectDarkPatterns(input: DetectionProviderInput): Promise<DetectionResult>;
  isConfigured(): boolean;
}
