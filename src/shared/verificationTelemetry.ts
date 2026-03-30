import { PATTERN_SIMILARITY_THRESHOLD } from "./patternMatcher";
import type { SignatureScoreBreakdown } from "./types";

type CaseStatus = "PASS" | "NOT_RUN";
type VerificationCase =
  | "exact_cache_hit_regression"
  | "cross_url_pattern_hit"
  | "different_template_no_false_match"
  | "reset_clears_both_layers"
  | "graceful_fallback_on_context_failure"
  | "pattern_upsert_not_duplicate"
  | "page_context_reuse_after_layer2_miss";

interface CaseResult {
  status: CaseStatus;
  reason: string;
}

interface VerificationState {
  traceId: string;
  pageKey: string;
  startedAt: number;
  layer1Result: "HIT" | "MISS" | "NOT_RUN";
  layer2Result: "HIT" | "MISS" | "SKIPPED" | "NOT_RUN";
  urlShape: string;
  candidateCount: number;
  fixesOnHit: number;
  scoreBreakdown: SignatureScoreBreakdown | null;
  threshold: number;
  finalState: "finished" | "initial" | "unknown";
  cases: Record<VerificationCase, CaseResult>;
}

const VERIFICATION_LOG_PREFIX = "[DarkPatternFixer:verify]";
const DEFAULT_REASON = "No observable signal for this run.";
// 0 = off, 1 = on (web-matching verification logs only)
const WEB_MATCH_DEBUG = 0;

let active: VerificationState | null = null;

function initCases(): Record<VerificationCase, CaseResult> {
  const names: VerificationCase[] = [
    "exact_cache_hit_regression",
    "cross_url_pattern_hit",
    "different_template_no_false_match",
    "reset_clears_both_layers",
    "graceful_fallback_on_context_failure",
    "pattern_upsert_not_duplicate",
    "page_context_reuse_after_layer2_miss",
  ];
  return names.reduce((acc, name) => {
    acc[name] = { status: "NOT_RUN", reason: DEFAULT_REASON };
    return acc;
  }, {} as Record<VerificationCase, CaseResult>);
}

function traceId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function setCase(name: VerificationCase, status: CaseStatus, reason: string): void {
  if (!active) return;
  active.cases[name] = { status, reason };
}

export function beginVerification(pageKey: string): void {
  active = {
    traceId: traceId(),
    pageKey,
    startedAt: Date.now(),
    layer1Result: "NOT_RUN",
    layer2Result: "NOT_RUN",
    urlShape: "",
    candidateCount: 0,
    fixesOnHit: 0,
    scoreBreakdown: null,
    threshold: PATTERN_SIMILARITY_THRESHOLD,
    finalState: "unknown",
    cases: initCases(),
  };
}

export function recordExactLayer(result: "HIT" | "MISS", fixes?: number): void {
  if (!active) return;
  active.layer1Result = result;
  if (result === "HIT") {
    active.fixesOnHit = fixes ?? active.fixesOnHit;
    setCase(
      "exact_cache_hit_regression",
      "PASS",
      `Exact page-key cache hit${typeof fixes === "number" ? ` with ${fixes} fixes` : ""}.`,
    );
  }
}

export function recordPatternLayerAttempt(urlShape: string): void {
  if (!active) return;
  active.urlShape = urlShape;
  active.layer2Result = "MISS";
}

export function recordPatternLayerHit(details: {
  urlShape: string;
  candidateCount: number;
  fixes: number;
  scoreBreakdown: SignatureScoreBreakdown;
}): void {
  if (!active) return;
  active.layer2Result = "HIT";
  active.urlShape = details.urlShape;
  active.candidateCount = details.candidateCount;
  active.fixesOnHit = details.fixes;
  active.scoreBreakdown = details.scoreBreakdown;
  setCase(
    "cross_url_pattern_hit",
    "PASS",
    `Pattern cache hit. score=${details.scoreBreakdown.combinedScore.toFixed(3)} threshold=${active.threshold.toFixed(3)}.`,
  );
}

export function recordPatternLayerMiss(details?: {
  candidateCount?: number;
  scoreBreakdown?: SignatureScoreBreakdown | null;
}): void {
  if (!active) return;
  active.layer2Result = active.layer2Result === "NOT_RUN" ? "MISS" : active.layer2Result;
  if (typeof details?.candidateCount === "number") {
    active.candidateCount = details.candidateCount;
  }
  if (details?.scoreBreakdown) {
    active.scoreBreakdown = details.scoreBreakdown;
  }
  setCase(
    "different_template_no_false_match",
    "PASS",
    "Pattern layer miss: no reusable template confidently matched.",
  );
}

export function recordPatternLayerSkipped(reason: string): void {
  if (!active) return;
  active.layer2Result = "SKIPPED";
  setCase("graceful_fallback_on_context_failure", "PASS", reason);
}

export function recordPatternUpsertSuccess(reason = "Pattern archive upsert succeeded."): void {
  setCase("pattern_upsert_not_duplicate", "PASS", reason);
}

export function recordContextReuse(reason = "Reused page context after layer-2 miss."): void {
  setCase("page_context_reuse_after_layer2_miss", "PASS", reason);
}

export function recordResetCacheSuccess(): void {
  setCase("reset_clears_both_layers", "PASS", "chrome.storage.local.clear() succeeded.");
}

export function flushVerification(finalState: "finished" | "initial" | "unknown"): void {
  if (!active) return;

  active.finalState = finalState;
  const durationMs = Date.now() - active.startedAt;
  const score = active.scoreBreakdown;

  if (!WEB_MATCH_DEBUG) {
    active = null;
    return;
  }

  console.group(`${VERIFICATION_LOG_PREFIX} trace=${active.traceId}`);
  console.info(`${VERIFICATION_LOG_PREFIX} overview`, {
    pageKey: active.pageKey,
    durationMs,
    finalState: active.finalState,
    layer1: active.layer1Result,
    layer2: active.layer2Result,
    urlShape: active.urlShape || "(none)",
    candidateCount: active.candidateCount,
    fixesOnHit: active.fixesOnHit,
  });

  console.table({
    scoring: {
      threshold: active.threshold.toFixed(3),
      matchPath: score?.matchPath ?? "n/a",
      combinedScore: score ? score.combinedScore.toFixed(3) : "n/a",
      llmFeatureScore: score?.llmFeatureScore != null ? score.llmFeatureScore.toFixed(3) : "n/a",
      requiredCoverage: score?.requiredCoverage != null ? score.requiredCoverage.toFixed(3) : "n/a",
      negativePenalty: score?.negativePenalty != null ? score.negativePenalty.toFixed(3) : "n/a",
      urlConsistencyScore: score?.urlConsistencyScore != null ? score.urlConsistencyScore.toFixed(3) : "n/a",
      tagScore: score ? score.tagScore.toFixed(3) : "n/a",
      classScore: score ? score.classScore.toFixed(3) : "n/a",
      attrScore: score ? score.attrScore.toFixed(3) : "n/a",
    },
  });

  console.table(
    Object.entries(active.cases).map(([name, entry]) => ({
      case: name,
      status: entry.status,
      reason: entry.reason,
    })),
  );
  console.groupEnd();

  active = null;
}
