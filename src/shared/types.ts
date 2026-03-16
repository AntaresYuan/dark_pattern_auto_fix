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
  css_selector: string;
  issues: IssueTag[];
}

export interface DetectionResult {
  identified_dark_patterns: IdentifiedDarkPattern[];
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
