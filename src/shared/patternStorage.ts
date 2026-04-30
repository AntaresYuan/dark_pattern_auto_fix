import type {
  DetectionResult,
  HtmlSignature,
  PageFix,
  PatternArchive,
  PatternMatchResult,
} from "./types";
import {
  deriveUrlShape,
  getHostFromUrlShape,
  LLM_FEATURE_THRESHOLD,
  PATTERN_SIMILARITY_THRESHOLD,
  scoreSignatureBreakdown,
  scoreLlmFeatures,
  scoreSignatureSimilarity,
  urlShapeConsistency,
} from "./patternMatcher";

const PATTERN_KEY_PREFIX = "pattern_fix::";
const PATTERN_LOG_PREFIX = "[DarkPatternFixer:pattern]";
/** Maximum number of L2 archives stored per hostname. Oldest-by-lastHitAt are evicted first. */
const MAX_ARCHIVES_PER_HOST = 10;

function fmt(n: number): string {
  return n.toFixed(3);
}

/**
 * Result returned by upsertPatternArchive so callers can log truthfully.
 * `wrote: false` means nothing was persisted and the caller should not log "upserted".
 */
export type UpsertOutcome =
  | { wrote: true; action: "created" | "updated"; fixCount: number }
  | { wrote: false; reason: string };

function patternKey(id: string): string {
  return `${PATTERN_KEY_PREFIX}${id}`;
}

export async function savePatternArchive(archive: PatternArchive): Promise<void> {
  await chrome.storage.local.set({ [patternKey(archive.id)]: archive });
}

/**
 * Evict the oldest archives (by lastHitAt) for a given host when the count exceeds
 * MAX_ARCHIVES_PER_HOST. Pass the full post-write archive list so no extra storage
 * read is needed.
 */
async function evictOldestIfNeeded(host: string, allArchives: PatternArchive[]): Promise<void> {
  const hostArchives = allArchives
    .filter((a) => getHostFromUrlShape(a.urlShape) === host)
    .sort((a, b) => a.lastHitAt - b.lastHitAt); // oldest first

  if (hostArchives.length <= MAX_ARCHIVES_PER_HOST) return;

  const toEvict = hostArchives.slice(0, hostArchives.length - MAX_ARCHIVES_PER_HOST);
  await chrome.storage.local.remove(toEvict.map((a) => patternKey(a.id)));
  console.info(
    `${PATTERN_LOG_PREFIX} Evicted ${toEvict.length} oldest archive(s) for host "${host}" (cap: ${MAX_ARCHIVES_PER_HOST}):\n` +
    toEvict.map((a) => `  "${a.urlShape}" — last hit ${new Date(a.lastHitAt).toLocaleString()}`).join("\n"),
  );
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
  const currentHost = getHostFromUrlShape(urlShape);
  let candidateCount = 0;
  let bestArchive: PatternArchive | null = null;
  let bestScore = 0;
  let bestScoreBreakdown: PatternMatchResult["scoreBreakdown"] | null = null;

  let headerLogged = false;

  for (const archive of archives) {
    // Candidate recall: same hostname — cross-site matches are never valid
    const archiveHost = getHostFromUrlShape(archive.urlShape);
    if (currentHost !== archiveHost) continue;

    candidateCount += 1;

    if (!headerLogged) {
      console.group(`${PATTERN_LOG_PREFIX} Layer 2 — pattern matching for "${urlShape}"`);
      headerLogged = true;
    }

    const sigBreakdown = scoreSignatureBreakdown(sig, archive.htmlSignature);
    const urlScore = urlShapeConsistency(urlShape, archive.urlShape);

    let score: number;
    let breakdown: PatternMatchResult["scoreBreakdown"];

    if (archive.llmMatchFeatures) {
      const llmDetail = scoreLlmFeatures(archive.llmMatchFeatures, sig, urlShape);
      score = 0.35 * llmDetail.score + 0.45 * sigBreakdown.combinedScore + 0.20 * urlScore;
      breakdown = {
        ...sigBreakdown,
        combinedScore: score,
        llmFeatureScore: llmDetail.score,
        requiredCoverage: llmDetail.requiredCoverage,
        negativePenalty: llmDetail.negativePenalty,
        urlConsistencyScore: urlScore,
        matchPath: "llm_primary",
      };
      console.info(
        `${PATTERN_LOG_PREFIX} Candidate "${archive.urlShape}" (${archive.fixes.length} fix(es), ${archive.hitCount} hit(s)) — path: LLM-primary\n` +
        `  LLM score  = 0.45×${fmt(llmDetail.requiredCoverage)} (required attrs) + 0.20×${fmt(llmDetail.optionalScore)} (optional) + 0.25×${fmt(llmDetail.fingerprintScore)} (fingerprint classes) + 0.10×${fmt(llmDetail.urlMatchRate)} (url path) − 0.50×${fmt(llmDetail.negativeHitRate)} (negative penalty) = ${fmt(llmDetail.score)}\n` +
        `  Sig score  = 0.20×${fmt(sigBreakdown.tagScore)} (tags) + 0.40×${fmt(sigBreakdown.classScore)} (classes) + 0.40×${fmt(sigBreakdown.attrScore)} (attrs) = ${fmt(sigBreakdown.combinedScore)}\n` +
        `  URL match  = ${fmt(urlScore)}\n` +
        `  Final      = 0.35×${fmt(llmDetail.score)} + 0.45×${fmt(sigBreakdown.combinedScore)} + 0.20×${fmt(urlScore)} = ${fmt(score)}  (threshold ${fmt(LLM_FEATURE_THRESHOLD)}) → ${score >= LLM_FEATURE_THRESHOLD ? "✓ ABOVE THRESHOLD" : "✗ BELOW THRESHOLD"}`,
      );
    } else {
      score = 0.70 * sigBreakdown.combinedScore + 0.30 * urlScore;
      breakdown = {
        ...sigBreakdown,
        combinedScore: score,
        urlConsistencyScore: urlScore,
        matchPath: "signature_fallback",
      };
      console.info(
        `${PATTERN_LOG_PREFIX} Candidate "${archive.urlShape}" (${archive.fixes.length} fix(es), ${archive.hitCount} hit(s)) — path: signature-fallback (no LLM features)\n` +
        `  Sig score  = 0.20×${fmt(sigBreakdown.tagScore)} (tags) + 0.40×${fmt(sigBreakdown.classScore)} (classes) + 0.40×${fmt(sigBreakdown.attrScore)} (attrs) = ${fmt(sigBreakdown.combinedScore)}\n` +
        `  URL match  = ${fmt(urlScore)}\n` +
        `  Final      = 0.70×${fmt(sigBreakdown.combinedScore)} + 0.30×${fmt(urlScore)} = ${fmt(score)}  (threshold ${fmt(PATTERN_SIMILARITY_THRESHOLD)}) → ${score >= PATTERN_SIMILARITY_THRESHOLD ? "✓ ABOVE THRESHOLD" : "✗ BELOW THRESHOLD"}`,
      );
    }

    const threshold = archive.llmMatchFeatures ? LLM_FEATURE_THRESHOLD : PATTERN_SIMILARITY_THRESHOLD;

    if (score >= threshold && score > bestScore) {
      bestArchive = archive;
      bestScore = score;
      bestScoreBreakdown = breakdown;
    }
  }

  if (headerLogged) {
    if (bestArchive) {
      console.info(`${PATTERN_LOG_PREFIX} Winner: "${bestArchive.urlShape}" — score ${fmt(bestScore)}, applying ${bestArchive.fixes.length} fix(es)`);
    } else {
      console.info(`${PATTERN_LOG_PREFIX} No candidate scored above threshold — falling through to LLM detection`);
    }
    console.groupEnd();
  } else {
    console.info(`${PATTERN_LOG_PREFIX} Layer 2 — no same-site candidates found for "${urlShape}"`);
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
 *
 * Writes the archive even when fixes is empty — an empty-fix archive acts as a
 * negative-cache / debug record that suppresses repeated LLM calls and surfaces
 * in Layer-2 logs without ever being applied.
 *
 * Returns an UpsertOutcome so callers can log truthfully (wrote vs skipped).
 */
export async function upsertPatternArchive(
  pageKey: string,
  sig: HtmlSignature,
  fixes: PageFix[],
  detectionResult: DetectionResult,
): Promise<UpsertOutcome> {
  const rawFeatures = detectionResult.template_match_features;
  const patternCount = detectionResult.identified_dark_patterns.length;

  // Normalize LLM features against the actual extracted signature so we never
  // store hallucinated tokens (tokens the LLM invented from world knowledge but
  // that don't appear in the truncated HTML the extractor sees).
  const pageAttrSet = new Set(sig.attrTokens ?? []);
  const pageClassSet = new Set(sig.classTokens ?? []);
  const llmMatchFeatures: typeof rawFeatures = {
    ...rawFeatures,
    required_attributes: rawFeatures.required_attributes.filter((a) => pageAttrSet.has(a)),
    optional_attributes: rawFeatures.optional_attributes.filter((a) => pageAttrSet.has(a)),
    fingerprint_tokens: rawFeatures.fingerprint_tokens.filter((c) => pageClassSet.has(c)),
  };

  // Always use rule-based derivation for the canonical urlShape key so it matches
  // what findBestPatternMatch uses during lookup. The LLM-supplied url_shape may
  // omit "www." or use a different hostname format, causing a host-mismatch and
  // zero candidates on the next run.
  const urlShape = deriveUrlShape(pageKey);
  const archives = await loadAllPatternArchives();
  const host = getHostFromUrlShape(urlShape);
  const now = Date.now();

  const detectionMeta = {
    lastDetectionAt: now,
    lastDetectionPatternCount: patternCount,
    lastFixCount: fixes.length,
  };

  // Find an existing archive to update (same urlShape + similar HTML signature)
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

  let writtenArchive: PatternArchive;
  let action: "created" | "updated";

  if (bestMatch) {
    writtenArchive = {
      ...bestMatch,
      fixes,
      htmlSignature: sig,
      hitCount: bestMatch.hitCount + 1,
      lastHitAt: now,
      ...detectionMeta,
      ...(llmMatchFeatures !== undefined && { llmMatchFeatures }),
    };
    action = "updated";
  } else {
    writtenArchive = {
      id: `${urlShape}::${now}`,
      urlPattern: pageKey,
      urlShape,
      htmlSignature: sig,
      fixes,
      hitCount: 1,
      createdAt: now,
      lastHitAt: now,
      ...detectionMeta,
      ...(llmMatchFeatures !== undefined && { llmMatchFeatures }),
    };
    action = "created";
  }

  await savePatternArchive(writtenArchive);

  // Evict oldest archives beyond the per-host cap.
  // Build the post-write list in memory to avoid a second storage read.
  const postWriteArchives = bestMatch
    ? archives.map((a) => (a.id === writtenArchive.id ? writtenArchive : a))
    : [...archives, writtenArchive];
  await evictOldestIfNeeded(host, postWriteArchives);

  return { wrote: true, action, fixCount: fixes.length };
}
