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

export type SelectorStability = "stable" | "dynamic";

export type PageType =
  | "product_detail"
  | "product_listing"
  | "checkout"
  | "cart"
  | "homepage"
  | "article"
  | "sign_up"
  | "sign_in"
  | "account_settings"
  | "subscription_management"
  | "cookie_consent_overlay"
  | "other";

/**
 * LLM's up-front read of the page context. The model fills this BEFORE
 * evaluating any candidate dark pattern, so every harm_test_reasoning
 * below can reference user_primary_intent.
 */
export interface PageEvaluation {
  page_type: PageType;
  user_primary_intent: string;
}

export interface IdentifiedDarkPattern {
  /**
   * Step 1 of the model's reasoning: 2-6 neutral, descriptive observations
   * about the suspicious element. Required to come BEFORE dark_pattern_type
   * in the schema so the model commits to evidence before committing to a label.
   */
  observed_signals: string[];
  /**
   * Step 2: explicit walkthrough of the harm test for the dark_pattern_type
   * being claimed, grounded in PageEvaluation.user_primary_intent. If the
   * model cannot articulate concrete user harm, the item should not appear.
   */
  harm_test_reasoning: string;
  dark_pattern_type: DarkPatternType;
  /** Exact HTML snippet copied verbatim from the provided HTML for the target element. */
  html_evidence: string;
  css_selector: string;
  issues: IssueTag[];
  selector_stability: SelectorStability;
}

/**
 * LLM-extracted features used for local-only L2 pattern matching on future visits.
 * All tokens must be template-stable (not page-specific content).
 */
export interface TemplateMatchFeatures {
  /** Normalized path segments that identify this URL template (e.g. ["dp", "{id}"]). */
  url_path_tokens: string[];
  /** Attributes that MUST be present on every page of this template. Format: "data-X", "role:val", "type:val", "aria-X". */
  required_attributes: string[];
  /** Attributes that appear on most pages of this template but are not guaranteed. */
  optional_attributes: string[];
  /** Attributes whose presence indicates a DIFFERENT template (false-positive guard). */
  negative_attributes: string[];
  /** Distinctive CSS class names or structural cues from the site's design system. */
  fingerprint_tokens: string[];
  /** LLM-assessed confidence that these features are stable and reusable. */
  match_confidence: "high" | "medium" | "low";
  /**
   * LLM-derived canonical URL shape: hostname + normalized path (e.g. "amazon.com/dp/{id}").
   * When present, overrides the rule-based deriveUrlShape() result for this archive.
   * Absent if the LLM could not determine a stable URL template.
   */
  url_shape?: string;
}

export interface DetectionResult {
  page_evaluation: PageEvaluation;
  identified_dark_patterns: IdentifiedDarkPattern[];
  template_match_features: TemplateMatchFeatures;
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
  /** LLM-extracted features for local matching. Absent on pre-migration archives — fall back to signature scoring. */
  llmMatchFeatures?: TemplateMatchFeatures;
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
  /** Number of dark patterns the LLM identified in the most recent detection run. */
  lastDetectionPatternCount?: number;
  /** Number of page fixes the fix planner produced in the most recent detection run. */
  lastFixCount?: number;
}

export interface SignatureScoreBreakdown {
  // Algorithmic signature components
  tagScore: number;
  classScore: number;
  attrScore: number;
  combinedScore: number; // final blended score used for threshold comparison
  // LLM-feature components (present only on llm_primary path)
  llmFeatureScore?: number;
  requiredCoverage?: number;
  negativePenalty?: number;
  // URL consistency score (present when URL soft-scoring is active)
  urlConsistencyScore?: number;
  matchPath?: "llm_primary" | "signature_fallback";
}

export interface PatternMatchResult {
  archive: PatternArchive;
  score: number;
  scoreBreakdown: SignatureScoreBreakdown;
  candidateCount: number;
}
