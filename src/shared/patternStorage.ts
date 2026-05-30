import type {
  HtmlSignature,
  PageFix,
  PatternArchive,
  PatternMatchResult,
} from "./types";
import {
  deriveUrlShape,
  getHostFromUrlShape,
  PATTERN_SIMILARITY_THRESHOLD,
  scoreSignatureBreakdown,
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
 * Candidate pool: all archives for the same hostname.
 * Score formula: 0.70 × sigScore + 0.30 × urlConsistencyScore
 *   where sigScore = 0.20 × tagJaccard + 0.40 × classJaccard + 0.40 × attrJaccard
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
    // Cross-site matches are never valid — filter by hostname first
    if (getHostFromUrlShape(archive.urlShape) !== currentHost) continue;

    candidateCount += 1;

    if (!headerLogged) {
      console.group(`${PATTERN_LOG_PREFIX} Layer 2 — pattern matching for "${urlShape}"`);
      headerLogged = true;
    }

    const sigBreakdown = scoreSignatureBreakdown(sig, archive.htmlSignature);
    const urlScore = urlShapeConsistency(urlShape, archive.urlShape);
    const score = 0.70 * sigBreakdown.combinedScore + 0.30 * urlScore;
    const breakdown: PatternMatchResult["scoreBreakdown"] = {
      ...sigBreakdown,
      combinedScore: score,
      urlConsistencyScore: urlScore,
    };

    console.info(
      `${PATTERN_LOG_PREFIX} Candidate "${archive.urlShape}" (${archive.fixes.length} fix(es), ${archive.hitCount} hit(s))\n` +
      `  Sig score  = 0.20×${fmt(sigBreakdown.tagScore)} (tags) + 0.40×${fmt(sigBreakdown.classScore)} (classes) + 0.40×${fmt(sigBreakdown.attrScore)} (attrs) = ${fmt(sigBreakdown.combinedScore)}\n` +
      `  URL match  = ${fmt(urlScore)}\n` +
      `  Final      = 0.70×${fmt(sigBreakdown.combinedScore)} + 0.30×${fmt(urlScore)} = ${fmt(score)}  (threshold ${fmt(PATTERN_SIMILARITY_THRESHOLD)}) → ${score >= PATTERN_SIMILARITY_THRESHOLD ? "✓ ABOVE THRESHOLD" : "✗ BELOW THRESHOLD"}`,
    );

    if (score >= PATTERN_SIMILARITY_THRESHOLD && score > bestScore) {
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
): Promise<UpsertOutcome> {
  const urlShape = deriveUrlShape(pageKey);
  const archives = await loadAllPatternArchives();
  const host = getHostFromUrlShape(urlShape);
  const now = Date.now();

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
      lastDetectionAt: now,
      lastFixCount: fixes.length,
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
      lastDetectionAt: now,
      lastFixCount: fixes.length,
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
