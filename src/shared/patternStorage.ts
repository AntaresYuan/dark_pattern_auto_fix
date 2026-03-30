import type {
  DetectionResult,
  HtmlSignature,
  PageFix,
  PatternArchive,
  PatternMatchResult,
} from "./types";
import {
  deriveUrlShape,
  LLM_FEATURE_THRESHOLD,
  PATTERN_SIMILARITY_THRESHOLD,
  scoreSignatureBreakdown,
  scoreLlmFeatures,
  scoreSignatureSimilarity,
  urlShapeConsistency,
} from "./patternMatcher";

const PATTERN_KEY_PREFIX = "pattern_fix::";

function patternKey(id: string): string {
  return `${PATTERN_KEY_PREFIX}${id}`;
}

export async function savePatternArchive(archive: PatternArchive): Promise<void> {
  await chrome.storage.local.set({ [patternKey(archive.id)]: archive });
}

/**
 * Load all pattern archives from storage.
 * Silently ignores malformed entries (returns empty array on total failure).
 */
export async function loadAllPatternArchives(): Promise<PatternArchive[]> {
  let all: Record<string, unknown>;
  try {
    all = await chrome.storage.local.get(null);
  } catch {
    return [];
  }

  const archives: PatternArchive[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(PATTERN_KEY_PREFIX) && value && typeof value === "object") {
      archives.push(value as PatternArchive);
    }
  }
  return archives;
}

/**
 * Find the pattern archive with the highest similarity score for the given URL shape
 * and HTML signature. Returns null if no archive scores above the threshold.
 *
 * Candidate recall: same hostname (not exact urlShape) — urlShape is a soft score component.
 * Score formula:
 *   LLM-primary path (archive has llmMatchFeatures):
 *     score = 0.55 × llmFeatureScore + 0.25 × sigScore + 0.20 × urlConsistencyScore
 *     threshold = LLM_FEATURE_THRESHOLD (0.50)
 *   Signature-fallback path (old archives without llmMatchFeatures):
 *     score = 0.70 × sigScore + 0.30 × urlConsistencyScore
 *     threshold = PATTERN_SIMILARITY_THRESHOLD (0.60)
 */
export async function findBestPatternMatch(
  urlShape: string,
  sig: HtmlSignature,
): Promise<PatternMatchResult | null> {
  const archives = await loadAllPatternArchives();
  const currentHost = urlShape.split("/")[0];
  let candidateCount = 0;
  let bestArchive: PatternArchive | null = null;
  let bestScore = 0;
  let bestScoreBreakdown: PatternMatchResult["scoreBreakdown"] | null = null;

  for (const archive of archives) {
    // Candidate recall: same hostname — cross-site matches are never valid
    const archiveHost = archive.urlShape.split("/")[0];
    if (currentHost !== archiveHost) continue;
    if (!archive.fixes || archive.fixes.length === 0) continue;

    candidateCount += 1;
    const sigBreakdown = scoreSignatureBreakdown(sig, archive.htmlSignature);
    const urlScore = urlShapeConsistency(urlShape, archive.urlShape);

    let score: number;
    let breakdown: PatternMatchResult["scoreBreakdown"];

    if (archive.llmMatchFeatures) {
      const llmDetail = scoreLlmFeatures(archive.llmMatchFeatures, sig, urlShape);
      score = 0.55 * llmDetail.score + 0.25 * sigBreakdown.combinedScore + 0.20 * urlScore;
      breakdown = {
        ...sigBreakdown,
        combinedScore: score,
        llmFeatureScore: llmDetail.score,
        requiredCoverage: llmDetail.requiredCoverage,
        negativePenalty: llmDetail.negativePenalty,
        urlConsistencyScore: urlScore,
        matchPath: "llm_primary",
      };
    } else {
      score = 0.70 * sigBreakdown.combinedScore + 0.30 * urlScore;
      breakdown = {
        ...sigBreakdown,
        combinedScore: score,
        urlConsistencyScore: urlScore,
        matchPath: "signature_fallback",
      };
    }

    const threshold = archive.llmMatchFeatures ? LLM_FEATURE_THRESHOLD : PATTERN_SIMILARITY_THRESHOLD;

    if (score >= threshold && score > bestScore) {
      bestArchive = archive;
      bestScore = score;
      bestScoreBreakdown = breakdown;
    }
  }

  if (!bestArchive || !bestScoreBreakdown) {
    return null;
  }

  return {
    archive: bestArchive,
    score: bestScore,
    scoreBreakdown: bestScoreBreakdown,
    candidateCount,
  };
}

/**
 * Create or update a pattern archive after a successful LLM detection run.
 * Stores reusable pattern/fix data for future local-only matching.
 */
export async function upsertPatternArchive(
  pageKey: string,
  sig: HtmlSignature,
  fixes: PageFix[],
  detectionResult?: DetectionResult,
): Promise<void> {
  if (fixes.length === 0) return;

  const urlShape = deriveUrlShape(pageKey);
  const archives = await loadAllPatternArchives();
  const llmMatchFeatures = detectionResult?.template_match_features;

  // Find an existing archive to update
  let bestMatch: PatternArchive | null = null;
  let bestScore = 0;
  for (const archive of archives) {
    if (archive.urlShape !== urlShape) continue;
    const score = scoreSignatureSimilarity(sig, archive.htmlSignature);
    if (score >= PATTERN_SIMILARITY_THRESHOLD && score > bestScore) {
      bestMatch = archive;
      bestScore = score;
    }
  }

  if (bestMatch) {
    const updated: PatternArchive = {
      ...bestMatch,
      fixes,
      htmlSignature: sig,
      hitCount: bestMatch.hitCount + 1,
      lastHitAt: Date.now(),
      ...(llmMatchFeatures !== undefined && { llmMatchFeatures }),
    };
    await savePatternArchive(updated);
    return;
  }

  const newArchive: PatternArchive = {
    id: `${urlShape}::${Date.now()}`,
    urlPattern: pageKey,
    urlShape,
    htmlSignature: sig,
    fixes,
    hitCount: 1,
    createdAt: Date.now(),
    lastHitAt: Date.now(),
    ...(llmMatchFeatures !== undefined && { llmMatchFeatures }),
  };
  await savePatternArchive(newArchive);
}
