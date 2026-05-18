import type {
  AdvertisementLabelFix,
  CssFix,
  IdentifiedDarkPattern,
  IssueTag,
  PageFix,
  PageFixArchive
} from "../shared/types";
import { logEvent, startStep, truncateText } from "../shared/logger";
import { applyFixesToPage } from "./patchInjector";
import { buildStableSelector, deriveSelector, pickBestMatch } from "./domSelector";
import {
  computeBlackness,
  inferSafeBackgroundColor,
  inferSafeColor,
  inferSafeFontSize,
  isVisible,
  resolveFixTarget
} from "./styleInference";

// Pattern types that have actionable fixes
const FIXABLE_TYPES = new Set([
  "Disguised ad", "False hierarchy", "Preselection", "Pop-up ad",
  "Trick wording", "Confirm shaming", "Fake social proof", "Forced Action", "Hidden information"
]);
// Strategies for patterns where no issue-specific fix was generated
const POPUP_TYPES = new Set(["Pop-up ad"]);
const TEXT_DIM_TYPES = new Set([
  "Preselection", "Trick wording", "Confirm shaming",
  "Fake social proof", "Forced Action", "Hidden information"
]);
// Dim slightly to visually flag the element without breaking layout
const DIM_FALLBACK_TYPES = new Set(["Disguised ad", "False hierarchy"]);

const ADVERTISEMENT_LABEL_TEXT = "ADVERTISEMENT";
const MIN_AD_LABEL_BLACKNESS = 0.5;

function isAdvertisementLabelText(text: string | null | undefined): boolean {
  return /^(ad|advertisement)$/i.test(text?.trim() ?? "");
}

// Finds an existing "Ad" / "Advertisement" label immediately before the target in the DOM.
function findAdvertisementLabel(target: Element): HTMLElement | null {
  const parent = target.parentElement;
  if (!parent) return null;

  for (const sibling of Array.from(parent.children)) {
    if (sibling === target) break;
    if (sibling instanceof HTMLElement && isAdvertisementLabelText(sibling.textContent)) {
      return sibling;
    }
  }

  const match = Array.from(parent.querySelectorAll("*")).find(
    (el) => el instanceof HTMLElement && isAdvertisementLabelText(el.textContent)
  );
  return match instanceof HTMLElement ? match : null;
}

function createAdvertisementLabelFix(
  target: Element,
  pattern: IdentifiedDarkPattern,
  traceId: string,
  stableSelector?: string
): AdvertisementLabelFix | null {
  const existingLabel = findAdvertisementLabel(target);
  if (existingLabel) {
    logEvent("content", "fix.pattern.ad_label.skip", {
      traceId,
      htmlEvidence: truncateText(pattern.html_evidence, 120),
      targetSelector: truncateText(buildStableSelector(target), 120),
      outcome: "existing_label_present"
    }, "debug");
    return null;
  }

  logEvent("content", "fix.pattern.ad_label.create", {
    traceId,
    htmlEvidence: truncateText(pattern.html_evidence, 120),
    targetSelector: truncateText(buildStableSelector(target), 120),
    outcome: "fix_created"
  }, "info");
  return {
    css_selector: stableSelector ?? buildStableSelector(target),
    patch_type: "advertisement_label",
    label_text: ADVERTISEMENT_LABEL_TEXT,
    source_dark_pattern_type: pattern.dark_pattern_type,
    applied_issues: ["add_advertisement_title"]
  };
}

function createAdvertisementLabelEnhancementFix(
  target: Element,
  pattern: IdentifiedDarkPattern,
  traceId: string
): CssFix | null {
  const existingLabel = findAdvertisementLabel(target);
  if (!existingLabel) {
    logEvent("content", "fix.pattern.ad_label.skip", {
      traceId,
      htmlEvidence: truncateText(pattern.html_evidence, 120),
      targetSelector: truncateText(buildStableSelector(target), 120),
      outcome: "label_missing_for_enhancement"
    }, "debug");
    return null;
  }

  if (computeBlackness(window.getComputedStyle(existingLabel).color) >= MIN_AD_LABEL_BLACKNESS) {
    logEvent("content", "fix.pattern.ad_label.skip", {
      traceId,
      htmlEvidence: truncateText(pattern.html_evidence, 120),
      targetSelector: truncateText(buildStableSelector(existingLabel), 120),
      outcome: "label_already_dark_enough"
    }, "debug");
    return null;
  }

  logEvent("content", "fix.pattern.ad_label.enhance", {
    traceId,
    htmlEvidence: truncateText(pattern.html_evidence, 120),
    targetSelector: truncateText(buildStableSelector(existingLabel), 120),
    outcome: "fix_created"
  }, "info");
  return {
    css_selector: buildStableSelector(existingLabel),
    patch_type: "css",
    css_rules: { color: "#000000" },
    source_dark_pattern_type: pattern.dark_pattern_type,
    applied_issues: ["enhance_advertisement_title"]
  };
}

function createFixesForPattern(pattern: IdentifiedDarkPattern, traceId: string): PageFix[] {
  const evidence = truncateText(pattern.html_evidence, 120);

  if (!FIXABLE_TYPES.has(pattern.dark_pattern_type)) {
    logEvent("content", "fix.pattern.skip", {
      traceId, darkPatternType: pattern.dark_pattern_type,
      htmlEvidence: evidence, issues: pattern.issues, outcome: "unfixable_type"
    }, "debug");
    return [];
  }

  const derivedSelector = deriveSelector(pattern.html_evidence);
  if (!derivedSelector) {
    logEvent("content", "fix.pattern.skip", {
      traceId, darkPatternType: pattern.dark_pattern_type,
      htmlEvidence: evidence, outcome: "no_stable_anchor"
    }, "warn");
    return [];
  }

  let matchedElement: Element | null = null;
  try {
    const candidates = document.querySelectorAll(derivedSelector);
    if (candidates.length > 0) {
      matchedElement = pickBestMatch(candidates, pattern.html_evidence, traceId, derivedSelector);
    }
  } catch { /* derivedSelector should always be valid, but guard just in case */ }

  if (!matchedElement) {
    logEvent("content", "fix.pattern.skip", {
      traceId, darkPatternType: pattern.dark_pattern_type,
      derivedSelector: truncateText(derivedSelector, 120), htmlEvidence: evidence,
      outcome: "element_not_found"
    }, "warn");
    return [];
  }

  const elementVisible = isVisible(matchedElement);
  if (!elementVisible) {
    logEvent("content", "fix.pattern.hidden_element", {
      traceId, darkPatternType: pattern.dark_pattern_type,
      derivedSelector: truncateText(derivedSelector, 120)
    }, "debug");
  }

  const resolution = resolveFixTarget(matchedElement, pattern.issues);
  const targetElement = resolution.target;
  const targetSelector = buildStableSelector(targetElement);
  if (resolution.reason) {
    logEvent("content", "fix.pattern.resolve_target", {
      traceId, darkPatternType: pattern.dark_pattern_type,
      derivedSelector: truncateText(derivedSelector, 120),
      resolvedSelector: truncateText(targetSelector, 120),
      reason: resolution.reason
    }, "debug");
  }

  const fixes: PageFix[] = [];

  // Build CSS property fixes based on the issues the LLM flagged
  const cssRules: CssFix["css_rules"] = {};
  const appliedIssues: IssueTag[] = [];
  const appliedIssueSummaries: Array<{ issue: IssueTag; value: string; usedFallback: boolean }> = [];

  if (pattern.issues.includes("color")) {
    const inferred = inferSafeColor(targetElement);
    cssRules.color = inferred.value;
    appliedIssues.push("color");
    appliedIssueSummaries.push({ issue: "color", value: inferred.value, usedFallback: inferred.usedFallback });
  }
  if (pattern.issues.includes("background_color")) {
    const inferred = inferSafeBackgroundColor(targetElement);
    cssRules["background-color"] = inferred.value;
    cssRules["background-image"] = "none";
    appliedIssues.push("background_color");
    appliedIssueSummaries.push({ issue: "background_color", value: inferred.value, usedFallback: inferred.usedFallback });
  }
  if (pattern.issues.includes("font_size")) {
    const inferred = inferSafeFontSize(targetElement);
    cssRules["font-size"] = inferred.value;
    appliedIssues.push("font_size");
    appliedIssueSummaries.push({ issue: "font_size", value: inferred.value, usedFallback: inferred.usedFallback });
  }

  if (appliedIssues.length > 0) {
    fixes.push({
      css_selector: targetSelector,
      patch_type: "css",
      css_rules: cssRules,
      source_dark_pattern_type: pattern.dark_pattern_type,
      applied_issues: appliedIssues
    });
    logEvent("content", "fix.pattern.generate", {
      traceId, darkPatternType: pattern.dark_pattern_type,
      derivedSelector: truncateText(derivedSelector, 120),
      resolvedSelector: truncateText(targetSelector, 120),
      appliedIssues, inferredStyles: appliedIssueSummaries, cssRules
    }, "info");
  }

  // Advertisement label fixes (only apply to visible elements)
  if (elementVisible && pattern.dark_pattern_type === "Disguised ad") {
    if (pattern.issues.includes("add_advertisement_title")) {
      const labelFix = createAdvertisementLabelFix(targetElement, pattern, traceId, targetSelector);
      if (labelFix) fixes.push(labelFix);
    }
    if (pattern.issues.includes("enhance_advertisement_title")) {
      const enhanceFix = createAdvertisementLabelEnhancementFix(targetElement, pattern, traceId);
      if (enhanceFix) fixes.push(enhanceFix);
    }
  }

  // Fallback strategies when no issue-specific fix was generated
  if (fixes.length === 0) {
    let fallbackRules: CssFix["css_rules"] | null = null;
    let strategy = "";
    if (POPUP_TYPES.has(pattern.dark_pattern_type)) {
      fallbackRules = { display: "none" };
      strategy = "universal_hide";
    } else if (TEXT_DIM_TYPES.has(pattern.dark_pattern_type)) {
      fallbackRules = { opacity: "0.5" };
      strategy = "universal_dim";
    } else if (DIM_FALLBACK_TYPES.has(pattern.dark_pattern_type)) {
      fallbackRules = { opacity: "0.7" };
      strategy = "dim_fallback";
    }

    if (fallbackRules) {
      fixes.push({
        css_selector: targetSelector,
        patch_type: "css",
        css_rules: fallbackRules,
        source_dark_pattern_type: pattern.dark_pattern_type,
        applied_issues: []
      });
      logEvent("content", "fix.pattern.generate", {
        traceId, darkPatternType: pattern.dark_pattern_type,
        derivedSelector: truncateText(derivedSelector, 120),
        resolvedSelector: truncateText(targetSelector, 120),
        appliedIssues: [], cssRules: fallbackRules, strategy
      }, "info");
    } else {
      logEvent("content", "fix.pattern.skip", {
        traceId, darkPatternType: pattern.dark_pattern_type,
        derivedSelector: truncateText(derivedSelector, 120),
        outcome: "no_fixes_generated"
      }, "warn");
    }
  }

  return fixes;
}

export function planAndApplyFixes(
  pageKey: string,
  patterns: IdentifiedDarkPattern[],
  traceId: string
): { archive: PageFixArchive; appliedCount: number } {
  const step = startStep("content", "fix.plan", { pageKey, patternCount: patterns.length, traceId });

  const fixes = patterns
    .flatMap((pattern) => createFixesForPattern(pattern, traceId))
    .filter((fix): fix is PageFix => Boolean(fix));

  const archive: PageFixArchive = { page_key: pageKey, fixes };
  const appliedCount = applyFixesToPage(fixes, { pageKey, traceId });

  step.finish({ pageKey, patternCount: patterns.length, fixCount: fixes.length, appliedCount });
  return { archive, appliedCount };
}
