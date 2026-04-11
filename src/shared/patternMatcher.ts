import type { HtmlSignature, SignatureScoreBreakdown, TemplateMatchFeatures } from "./types";

/**
 * Minimum combined score for the signature-only (fallback) path.
 * Score = 0.2 × tagJaccard + 0.4 × classJaccard + 0.4 × attrJaccard.
 */
export const PATTERN_SIMILARITY_THRESHOLD = 0.6;

/**
 * Minimum combined score for the LLM-feature-primary path.
 * Lower than the signature threshold because LLM features are semantically precise
 * and URL consistency is scored jointly (not hard-gated).
 * Final score = 0.55 × llmFeatureScore + 0.25 × sigScore + 0.20 × urlConsistencyScore.
 */
export const LLM_FEATURE_THRESHOLD = 0.50;

const MAX_TAG_TOKENS = 50;
const MAX_CLASS_TOKENS = 200;
const MAX_ATTR_TOKENS = 160;

/**
 * Replace variable path segments in a page key (hostname+pathname) with typed placeholders
 * so that structurally-equivalent URLs from the same site template share the same shape.
 *
 * Examples:
 *   amazon.com/dp/B08N5WRWNW  →  amazon.com/dp/{id}
 *   shop.com/product/123456   →  shop.com/product/{id}
 *   site.com/posts/abc-def-1234abc  →  site.com/posts/{slug}
 */
export function deriveUrlShape(pageKey: string): string {
  const parts = pageKey.split("/");
  const hostname = parts[0];
  const segments = parts.slice(1);

  const normalized = segments.map((segment) => {
    if (!segment) return segment;
    // Pure integers (page numbers, numeric IDs)
    if (/^\d+$/.test(segment)) return "{id}";
    // UUID / hex blob (8+ hex chars, optional hyphens)
    if (/^[0-9a-f]{8,}(-[0-9a-f]{4,}){0,4}$/i.test(segment)) return "{id}";
    // Amazon ASIN-style: 8+ uppercase letters+digits
    if (/^[A-Z0-9]{8,}$/.test(segment)) return "{id}";
    // Long mixed-alphanumeric slugs that contain digits — likely encode an ID
    if (segment.length >= 8 && /\d/.test(segment)) return "{slug}";
    return segment;
  });

  return [hostname, ...normalized].join("/");
}

/** Extract the hostname portion from a URL shape (the segment before the first '/'). */
export function getHostFromUrlShape(urlShape: string): string {
  return urlShape.split("/")[0];
}

function logBucket(n: number): number {
  return Math.floor(Math.log2(n + 1));
}

/**
 * Extract a structural, content-agnostic fingerprint from truncated HTML.
 * Uses regex scanning (no DOM parsing) so it works in the popup context.
 */
export function extractHtmlSignature(truncatedHtml: string): HtmlSignature {
  if (!truncatedHtml) return { tagTokens: [], classTokens: [], attrTokens: [] };

  // --- Tag frequency histogram ---
  const tagCounts = new Map<string, number>();
  for (const m of truncatedHtml.matchAll(/<([\w-]+)/g)) {
    const tag = m[1].toLowerCase();
    tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }

  const tagTokens = Array.from(tagCounts.entries())
    .map(([tag, count]) => `${tag}:${logBucket(count)}`)
    .sort()
    .slice(0, MAX_TAG_TOKENS);

  // --- Unique class-name tokens ---
  const classSet = new Set<string>();
  for (const m of truncatedHtml.matchAll(/\bclass=["']([^"']*?)["']/g)) {
    for (const cls of m[1].split(/\s+/)) {
      if (cls && classSet.size < MAX_CLASS_TOKENS) {
        classSet.add(cls);
      }
    }
  }

  const classTokens = Array.from(classSet).sort();

  // --- Stable attribute tokens ---
  // Strategy per attribute type:
  //   data-* / id  — name only: values vary per page instance (ASINs, numeric IDs, slugs)
  //   role / type  — name:value: drawn from a small, spec-defined vocabulary (stable)
  //   name         — name:value only for purely-alphabetic values (e.g. "email", "quantity");
  //                  skip if the value contains digits (likely a token/hash field name)
  //   aria-label / aria-labelledby — name only: values are human-readable content text
  const attrSet = new Set<string>();

  // data-* attribute names (presence is structural; values are content-specific)
  for (const m of truncatedHtml.matchAll(/\bdata-([\w-]+)\b/gi)) {
    if (attrSet.size >= MAX_ATTR_TOKENS) break;
    attrSet.add(`data-${m[1].toLowerCase()}`);
  }

  // id attribute — presence-only signal (values are unique per element)
  if (/\bid\s*=/.test(truncatedHtml)) {
    attrSet.add("attr:id");
  }

  // role="value" — ARIA roles are a fixed structural vocabulary
  for (const m of truncatedHtml.matchAll(/\brole=["']([\w-]+)["']/g)) {
    if (attrSet.size >= MAX_ATTR_TOKENS) break;
    const val = m[1].toLowerCase();
    if (/^[a-z][a-z-]{0,22}$/.test(val)) attrSet.add(`role:${val}`);
  }

  // type="value" — HTML input/button types are a fixed vocabulary
  for (const m of truncatedHtml.matchAll(/\btype=["']([\w-]+)["']/g)) {
    if (attrSet.size >= MAX_ATTR_TOKENS) break;
    const val = m[1].toLowerCase();
    if (/^[a-z][a-z-]{0,18}$/.test(val)) attrSet.add(`type:${val}`);
  }

  // name="value" — form field names; only keep purely alphabetic values
  for (const m of truncatedHtml.matchAll(/\bname=["']([\w-]+)["']/g)) {
    if (attrSet.size >= MAX_ATTR_TOKENS) break;
    const val = m[1].toLowerCase();
    if (/^[a-z][a-z_-]{0,23}$/.test(val)) attrSet.add(`name:${val}`);
  }

  // aria-* attribute names (values are human-readable text, not structural)
  for (const m of truncatedHtml.matchAll(/\b(aria-[\w-]+)=/gi)) {
    if (attrSet.size >= MAX_ATTR_TOKENS) break;
    attrSet.add(m[1].toLowerCase());
  }

  const attrTokens = Array.from(attrSet).sort();

  return { tagTokens, classTokens, attrTokens };
}

/**
 * URL shape consistency score ∈ [0, 1].
 * Returns 1.0 on exact match. Returns 0 if hostnames differ (cross-site).
 * Otherwise computes Jaccard similarity over path+hostname segments so that
 * structurally-similar URLs on the same site score high without an exact match.
 *
 * Examples (amazon.com host):
 *   /dp/{id}  vs /dp/{id}              → 1.00 (exact)
 *   /dp/{id}  vs /dp/{id}/ref/{slug}   → 0.60
 *   /dp/{id}  vs /s (search page)      → 0.25
 */
export function urlShapeConsistency(currentShape: string, archiveShape: string): number {
  if (currentShape === archiveShape) return 1.0;
  const currentParts = currentShape.split("/");
  const archiveParts = archiveShape.split("/");
  // Hostname must match — never match across different sites
  if (currentParts[0] !== archiveParts[0]) return 0;
  return jaccardSimilarity(currentParts, archiveParts);
}

function jaccardSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const setB = new Set(b);
  let intersection = 0;
  for (const token of a) {
    if (setB.has(token)) intersection++;
  }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 1 : intersection / union;
}

/**
 * Combined similarity score ∈ [0, 1].
 * Tag structure contributes 20 %, CSS class tokens 40 %, and HTML attributes 40 %.
 */
export function scoreSignatureSimilarity(a: HtmlSignature, b: HtmlSignature): number {
  return scoreSignatureBreakdown(a, b).combinedScore;
}

export function scoreSignatureBreakdown(
  a: HtmlSignature,
  b: HtmlSignature,
): SignatureScoreBreakdown {
  const tagScore = jaccardSimilarity(a.tagTokens, b.tagTokens);
  const classScore = jaccardSimilarity(a.classTokens, b.classTokens);
  // Defensive: archives written before attrTokens was added have undefined at runtime
  const aAttr = Array.isArray(a.attrTokens) ? a.attrTokens : [];
  const bAttr = Array.isArray(b.attrTokens) ? b.attrTokens : [];
  const attrScore = jaccardSimilarity(aAttr, bAttr);
  const combinedScore = 0.2 * tagScore + 0.4 * classScore + 0.4 * attrScore;
  return { tagScore, classScore, attrScore, combinedScore };
}

/**
 * Score a page (described by its HtmlSignature and urlShape) against LLM-extracted
 * template match features stored in a PatternArchive.
 *
 * Formula:
 *   rawScore = 0.45 × requiredCoverage
 *            + 0.20 × optionalJaccard
 *            + 0.25 × fingerprintJaccard
 *            + 0.10 × urlMatchRate
 *   penalty  = 0.50 × negativeHitRate
 *   llmScore = max(0, rawScore − penalty)
 *
 * The combined final score in findBestPatternMatch is:
 *   finalScore = 0.70 × llmScore + 0.30 × sigScore
 *
 * requiredCoverage: fraction of required_attributes found in page attrTokens.
 * negativeHitRate:  fraction of negative_attributes found — each hit reduces score.
 */
export function scoreLlmFeatures(
  features: TemplateMatchFeatures,
  sig: HtmlSignature,
  urlShape: string,
): {
  score: number;
  requiredCoverage: number;
  negativePenalty: number;
  optionalScore: number;
  fingerprintScore: number;
  urlMatchRate: number;
  negativeHitRate: number;
} {
  const pageAttrSet = new Set(Array.isArray(sig.attrTokens) ? sig.attrTokens : []);

  // required_coverage — high weight; these must be present for a template match
  const reqTotal = features.required_attributes.length;
  const reqFound = features.required_attributes.filter((a) => pageAttrSet.has(a)).length;
  const requiredCoverage = reqTotal === 0 ? 1 : reqFound / reqTotal;

  // optional overlap — Jaccard against page attrs
  const optionalScore = jaccardSimilarity(features.optional_attributes, sig.attrTokens ?? []);

  // fingerprint overlap — distinctive class names against page class tokens
  const pageClassTokens = Array.isArray(sig.classTokens) ? sig.classTokens : [];
  const fingerprintScore = jaccardSimilarity(features.fingerprint_tokens, pageClassTokens);

  // url path match — fraction of url_path_tokens found as segments in urlShape
  const urlParts = new Set(urlShape.split("/"));
  const urlTotal = features.url_path_tokens.length;
  const urlFound = features.url_path_tokens.filter((t) => urlParts.has(t)).length;
  const urlMatchRate = urlTotal === 0 ? 1 : urlFound / urlTotal;

  // negative penalty — presence of any negative attr indicates wrong template
  const negTotal = features.negative_attributes.length;
  const negFound = features.negative_attributes.filter((a) => pageAttrSet.has(a)).length;
  const negativeHitRate = negTotal === 0 ? 0 : negFound / negTotal;

  const rawScore =
    0.45 * requiredCoverage +
    0.20 * optionalScore +
    0.25 * fingerprintScore +
    0.10 * urlMatchRate;

  const negativePenalty = 0.50 * negativeHitRate;
  const score = Math.max(0, rawScore - negativePenalty);

  return { score, requiredCoverage, negativePenalty, optionalScore, fingerprintScore, urlMatchRate, negativeHitRate };
}
