export type DarkPatternType =
  | "Disguised ad"
  | "False hierarchy"
  | "Preselection"
  | "Pop-up ad"
  | "Trick wording"
  | "Confirm shaming"
  | "Fake social proof"
  | "Forced Action"
  | "Hidden information";

export type IssueTag =
  | "color"
  | "font_size"
  | "background_color"
  | "add_advertisement_title"
  | "enhance_advertisement_title";

export interface IdentifiedDarkPattern {
  dark_pattern_type: DarkPatternType;
  /** Exact opening tag copied verbatim from the provided HTML for the target element. */
  html_evidence: string;
  /**
   * The model's own selector for the target element. The fix planner re-derives its
   * selector from html_evidence and ignores this, but the F1 locator uses it as a
   * fallback when html_evidence is truncated/unusable (it has no quotes to truncate on).
   */
  css_selector?: string;
  issues: IssueTag[];
}

export interface DetectionResult {
  identified_dark_patterns: IdentifiedDarkPattern[];
}

export interface CssFix {
  css_selector: string;
  patch_type: "css";
  css_rules: Partial<Record<"color" | "font-size" | "background-color" | "background-image" | "opacity" | "display", string>>;
  source_dark_pattern_type: DarkPatternType;
  applied_issues: IssueTag[];
}

export interface AdvertisementLabelFix {
  css_selector: string;
  patch_type: "advertisement_label";
  label_text: string;
  source_dark_pattern_type: DarkPatternType;
  applied_issues: IssueTag[];
}

export type PageFix = CssFix | AdvertisementLabelFix;

export interface PageFixArchive {
  page_key: string;
  fixes: PageFix[];
}

export interface PageContext {
  truncatedHtml: string;
  viewport: {
    width: number;
    height: number;
    scrollY: number;
  };
}

export interface FixApplicationResult {
  archive: PageFixArchive;
  appliedCount: number;
}

// --- Pattern-level cache types ---

export interface HtmlSignature {
  /** Sorted "tag:logBucket" strings — structural histogram, content-agnostic */
  tagTokens: string[];
  /** Sorted unique CSS class-name tokens found in the page */
  classTokens: string[];
  /** Sorted stable HTML attribute tokens extracted from the page */
  attrTokens: string[];
}

export interface PatternArchive {
  id: string;
  /** Original page_key (hostname+pathname) that seeded this archive */
  urlPattern: string;
  /** URL shape with variable segments replaced: pure-numbers→{id}, ASINs→{id}, long slugs→{slug} */
  urlShape: string;
  htmlSignature: HtmlSignature;
  /**
   * Page fixes produced by the fix planner on the last detection run.
   * May be empty when the LLM found patterns but the planner could not map them to
   * actionable DOM fixes (selector not found, non-fixable type, etc.).
   * Archives with fixes.length === 0 are kept as negative-cache / debug records
   * and are never "applied" — they suppress repeated LLM calls and surface in logs.
   */
  fixes: PageFix[];
  hitCount: number;
  createdAt: number; // unix ms
  lastHitAt: number; // unix ms
  /** Unix ms timestamp of the most recent LLM detection run that produced this archive. */
  lastDetectionAt?: number;
  /** Number of page fixes the fix planner produced in the most recent detection run. */
  lastFixCount?: number;
}

export interface SignatureScoreBreakdown {
  tagScore: number;
  classScore: number;
  attrScore: number;
  /** Final blended score = 0.70 × sigScore + 0.30 × urlConsistencyScore */
  combinedScore: number;
  urlConsistencyScore?: number;
}

export interface PatternMatchResult {
  archive: PatternArchive;
  score: number;
  scoreBreakdown: SignatureScoreBreakdown;
  candidateCount: number;
}
