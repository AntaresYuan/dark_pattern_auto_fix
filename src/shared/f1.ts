import type { DarkPatternType } from "./types";

/**
 * Shape of a benchmark fixture's ground-truth.json (the subset the in-extension
 * F1 scorer needs). Authoritative source: AntaresYuan/dark-pattern-benchmark
 * fixtures/<name>/ground-truth.json — see its `scoring` block for the metric.
 */
export interface GroundTruthDp {
  gt_id: string;
  type: string;
  selector: string;
  element?: string;
  /** Dark-pattern types that count as a correct label for this element. */
  accepts_types: string[];
}

export interface GroundTruthCounterexample {
  gt_id: string;
  looks_like?: string;
  selector?: string;
}

export interface GroundTruthFile {
  fixture?: string;
  dark_patterns: GroundTruthDp[];
  counterexamples?: GroundTruthCounterexample[];
}

export type F1Verdict =
  | "tp" // located a dark_patterns gt_id with an accepted type
  | "wrong_type" // located the right element but the wrong type
  | "fp_counterexample" // located a counterexample gt_id
  | "fp_extraneous" // located an element under no gt_id anchor
  | "unlocatable" // html_evidence could not be resolved to a DOM element
  | "duplicate"; // a second prediction hitting an already-matched dark_patterns gt_id

export interface F1PredictionDetail {
  htmlEvidence: string;
  predictedType: DarkPatternType;
  matchedGtId: string | null;
  acceptsTypes?: string[];
  verdict: F1Verdict;
}

export interface F1Counts {
  tp: number;
  fp: number;
  fn: number;
  wrongType: number;
  duplicate: number;
  unlocatable: number;
}

export interface F1Result {
  /** BUILD_ID of the content script that produced this result (stale-code detector). */
  contentBuildId: string;
  groundTruthUrl: string;
  /** Number of injected dark patterns in the fixture (TP + FN + wrong_type universe). */
  injectedTotal: number;
  predictionCount: number;
  counts: F1Counts;
  precision: number;
  recall: number;
  f1: number;
  predictions: F1PredictionDetail[];
  /** dark_patterns gt_ids no prediction located at all (the FN list). */
  missed: Array<{ gt_id: string; type: string }>;
}
