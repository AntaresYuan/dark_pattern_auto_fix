import { locateElementForEvidence } from "./fixPlanner";
import { BUILD_ID } from "../shared/buildInfo";
import { startStep } from "../shared/logger";
import type { IdentifiedDarkPattern } from "../shared/types";
import type {
  F1PredictionDetail,
  F1Result,
  GroundTruthFile,
} from "../shared/f1";

/**
 * Derives the sibling ground-truth.json URL from the current page URL by replacing
 * the last path segment (the fixture .html filename) with "ground-truth.json".
 * e.g. .../fixtures/booking-hotel-checkout/booking-hotel-checkout.html
 *   -> .../fixtures/booking-hotel-checkout/ground-truth.json
 */
export function deriveGroundTruthUrl(href: string): string {
  const url = new URL(href);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/[^/]*$/, "ground-truth.json");
  return url.toString();
}

/**
 * Runs the benchmark's identification F1 metric in-page against the served fixture.
 * Matching mirrors AntaresYuan/dark-pattern-benchmark's `scoring` block: a prediction
 * is located in the live DOM (same locator the fix path uses), then mapped to the
 * nearest `data-gt-id` anchor.
 *   - dark_patterns gt_id + accepted type  -> TP
 *   - dark_patterns gt_id + other type     -> wrong_type (separate; not TP, not FN)
 *   - counterexample gt_id                 -> FP
 *   - no gt_id anchor                      -> FP (extraneous)
 *   - unresolvable html_evidence           -> FP (surfaced separately as unlocatable)
 * FN = dark_patterns gt_ids no prediction located. precision=TP/(TP+FP), recall=TP/(TP+FN).
 */
export async function scoreF1(patterns: IdentifiedDarkPattern[]): Promise<F1Result> {
  const groundTruthUrl = deriveGroundTruthUrl(window.location.href);
  const step = startStep("content", "f1.score", {
    groundTruthUrl,
    predictionCount: patterns.length,
  });

  const response = await fetch(groundTruthUrl);
  if (!response.ok) {
    throw new Error(
      `ground-truth.json not found at ${groundTruthUrl} (HTTP ${response.status}). ` +
        `Open the fixture served alongside its ground-truth.json (e.g. localhost:8000/fixtures/<name>/<name>.html).`,
    );
  }
  const gt = (await response.json()) as GroundTruthFile;
  const dpById = new Map(gt.dark_patterns.map((entry) => [entry.gt_id, entry]));
  const ceIds = new Set((gt.counterexamples ?? []).map((entry) => entry.gt_id));

  const matched = new Set<string>();
  const predictions: F1PredictionDetail[] = [];
  let tp = 0;
  let fp = 0;
  let wrongType = 0;
  let duplicate = 0;
  let unlocatable = 0;

  for (const pattern of patterns) {
    const base = {
      htmlEvidence: pattern.html_evidence,
      predictedType: pattern.dark_pattern_type,
    };
    const element = locateElementForEvidence(pattern.html_evidence, pattern.css_selector);
    if (!element) {
      unlocatable += 1;
      fp += 1;
      predictions.push({ ...base, matchedGtId: null, verdict: "unlocatable" });
      continue;
    }

    const anchor = element.closest("[data-gt-id]");
    const gtId = anchor?.getAttribute("data-gt-id") ?? null;

    if (gtId && dpById.has(gtId)) {
      const dp = dpById.get(gtId)!;
      if (matched.has(gtId)) {
        duplicate += 1;
        predictions.push({ ...base, matchedGtId: gtId, acceptsTypes: dp.accepts_types, verdict: "duplicate" });
      } else if (dp.accepts_types.includes(pattern.dark_pattern_type)) {
        tp += 1;
        matched.add(gtId);
        predictions.push({ ...base, matchedGtId: gtId, acceptsTypes: dp.accepts_types, verdict: "tp" });
      } else {
        wrongType += 1;
        matched.add(gtId);
        predictions.push({ ...base, matchedGtId: gtId, acceptsTypes: dp.accepts_types, verdict: "wrong_type" });
      }
    } else if (gtId && ceIds.has(gtId)) {
      fp += 1;
      predictions.push({ ...base, matchedGtId: gtId, verdict: "fp_counterexample" });
    } else {
      fp += 1;
      predictions.push({ ...base, matchedGtId: gtId, verdict: "fp_extraneous" });
    }
  }

  const missed = gt.dark_patterns
    .filter((entry) => !matched.has(entry.gt_id))
    .map((entry) => ({ gt_id: entry.gt_id, type: entry.type }));
  const fn = missed.length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  const result: F1Result = {
    contentBuildId: BUILD_ID,
    groundTruthUrl,
    injectedTotal: gt.dark_patterns.length,
    predictionCount: patterns.length,
    counts: { tp, fp, fn, wrongType, duplicate, unlocatable },
    precision,
    recall,
    f1,
    predictions,
    missed,
  };
  step.finish({ ...result.counts, precision, recall, f1 });
  return result;
}
