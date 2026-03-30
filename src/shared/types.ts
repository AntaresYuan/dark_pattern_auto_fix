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

export interface IdentifiedDarkPattern {
  dark_pattern_type: DarkPatternType;
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
}

export interface DetectionResult {
  identified_dark_patterns: IdentifiedDarkPattern[];
  template_match_features: TemplateMatchFeatures;
}

export interface CssFix {
  css_selector: string;
  patch_type: "css";
  css_rules: Partial<Record<"color" | "font-size" | "background-color" | "background-image", string>>;
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
  fixes: PageFix[];
  hitCount: number;
  createdAt: number; // unix ms
  lastHitAt: number; // unix ms
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
