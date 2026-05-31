import type {
  AdvertisementLabelFix,
  AnnotateFix,
  ClickFix,
  CssFix,
  IdentifiedDarkPattern,
  IssueTag,
  PageFix,
  PageFixArchive,
  ReplaceTextFix,
  UncheckFix
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
// Fallback strategies for patterns where no issue-specific fix was generated.
// HIDE: remove the element entirely — appropriate when the element itself IS the manipulation.
const HIDE_TYPES = new Set(["Pop-up ad", "Fake social proof", "Forced Action"]);
// DIM: opacity flag — used only when no better fix applies (Preselection without a
// checkable input, Hidden information without fix_hint and without a self-hidden or
// toggle target). Trick wording is handled by AnnotateFix, not dim.
const TEXT_DIM_TYPES = new Set(["Preselection", "Hidden information"]);
// Fallback used when no fix_hint is provided for a Confirm shaming pattern.
const NEUTRAL_DECLINE_TEXT_FALLBACK = "No thanks";
const CONFIRM_SHAMING_TYPES = new Set(["Confirm shaming"]);
const TRICK_WORDING_TYPES = new Set(["Trick wording"]);
// Dim slightly to visually flag the element without breaking layout
const DIM_FALLBACK_TYPES = new Set(["Disguised ad", "False hierarchy"]);

const ADVERTISEMENT_LABEL_TEXT = "ADVERTISEMENT";
const MIN_AD_LABEL_BLACKNESS = 0.5;
type FixTargetResolutionReason = "clickable_ancestor" | "styled_surface_ancestor";

/**
 * Returns just the first element's opening tag from an html_evidence string.
 * The model often copies a parent tag followed by descendants
 * (e.g. `<label ...> <input type="radio" name="x" checked>`); selector derivation
 * and candidate scoring must use ONLY the first tag's attributes — scraping a child's
 * attributes onto the parent produces a selector that matches nothing.
 */
function firstOpeningTag(evidence: string): string {
  const match = evidence.match(/<[a-z][a-z0-9-]*\b[^>]*>/i);
  return match ? match[0] : evidence;
}

// Walks down from `element` to find the actual <input type="checkbox|radio">.
// The LLM often points at a wrapper <div> or <label> rather than the input itself.
function findCheckableInput(element: Element): HTMLInputElement | null {
  if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) {
    return element;
  }
  return element.querySelector<HTMLInputElement>('input[type="checkbox"], input[type="radio"]');
}

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

const INTERACTIVE_SELECTOR = 'button, a, input[type="button"], input[type="submit"], [role="button"]';

// Returns true when an element is an interactive disclosure control (button, summary,
// or role=button/tab/switch) — used to decide whether a Hidden information target
// should receive a simulated click rather than a dim.
function isToggleElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute("role");
  return (
    tag === "button" || tag === "summary" ||
    role === "button" || role === "tab" || role === "switch"
  );
}

// Walks up the ancestor chain to find the nearest fixed/absolute positioned overlay
// with a positive z-index — the popup shell that contains the identified element.
// Used for Fake social proof so we hide the full modal rather than just its text node.
function findModalAncestor(element: Element): Element | null {
  let current = element.parentElement;
  while (current && current !== document.documentElement) {
    const style = window.getComputedStyle(current);
    const zIndex = parseInt(style.zIndex, 10);
    if (
      (style.position === "fixed" || style.position === "absolute") &&
      !Number.isNaN(zIndex) && zIndex > 0
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

// Finds the smallest interactive sibling within the same parent — the demoted
// user-favoring element the site intentionally made hard to see. Only returns a
// sibling when its font size is meaningfully smaller than the dominant target (< 85%).
function findDemotedSibling(target: Element): Element | null {
  const parent = target.parentElement;
  if (!parent) return null;
  const targetFontSize = parseFloat(window.getComputedStyle(target).fontSize);
  let smallest: Element | null = null;
  let smallestFontSize = Infinity;
  for (const candidate of Array.from(parent.querySelectorAll(INTERACTIVE_SELECTOR))) {
    if (candidate === target || target.contains(candidate) || candidate.contains(target)) continue;
    if (!isVisible(candidate)) continue;
    const fontSize = parseFloat(window.getComputedStyle(candidate).fontSize);
    if (fontSize < smallestFontSize) {
      smallestFontSize = fontSize;
      smallest = candidate;
    }
  }
  return smallest && smallestFontSize < targetFontSize * 0.85 ? smallest : null;
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

  // False hierarchy: also boost the demoted user-favoring sibling so the visual
  // hierarchy becomes fair. The CSS fix above demotes the dominant element; this
  // counterpart promotes the option the site intentionally hid.
  if (elementVisible && pattern.dark_pattern_type === "False hierarchy") {
    const demotedSibling = findDemotedSibling(targetElement);
    if (demotedSibling) {
      const siblingSelector = buildStableSelector(demotedSibling);
      fixes.push({
        css_selector: siblingSelector,
        patch_type: "css",
        css_rules: { color: "#111111", "font-size": "1rem", opacity: "1" },
        source_dark_pattern_type: pattern.dark_pattern_type,
        applied_issues: []
      });
      logEvent("content", "fix.pattern.generate", {
        traceId, darkPatternType: pattern.dark_pattern_type,
        derivedSelector: truncateText(derivedSelector, 120),
        resolvedSelector: truncateText(siblingSelector, 120),
        strategy: "boost_demoted_sibling"
      }, "info");
    }
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

  // Confirm shaming: replace the shame-laden decline label with a neutral phrase.
  // Prefer the context-specific text from fix_hint; fall back to the generic constant
  // so existing cached archives (which have no fix_hint) continue to work unchanged.
  if (elementVisible && CONFIRM_SHAMING_TYPES.has(pattern.dark_pattern_type)) {
    const replacementText = pattern.fix_hint?.trim() || NEUTRAL_DECLINE_TEXT_FALLBACK;
    const replaceTextFix: ReplaceTextFix = {
      css_selector: targetSelector,
      patch_type: "replace_text",
      replacement_text: replacementText,
      source_dark_pattern_type: pattern.dark_pattern_type,
      applied_issues: []
    };
    fixes.push(replaceTextFix);
    logEvent("content", "fix.pattern.generate", {
      traceId, darkPatternType: pattern.dark_pattern_type,
      derivedSelector: truncateText(derivedSelector, 120),
      resolvedSelector: truncateText(targetSelector, 120),
      replacementText,
      usedFixHint: Boolean(pattern.fix_hint?.trim())
    }, "info");
  }

  // Trick wording: when the detection source provides a corrected label via fix_hint,
  // replace the misleading text directly.
  if (elementVisible && TRICK_WORDING_TYPES.has(pattern.dark_pattern_type) && pattern.fix_hint?.trim()) {
    const correctedText = pattern.fix_hint.trim();
    const replaceTextFix: ReplaceTextFix = {
      css_selector: targetSelector,
      patch_type: "replace_text",
      replacement_text: correctedText,
      source_dark_pattern_type: pattern.dark_pattern_type,
      applied_issues: []
    };
    fixes.push(replaceTextFix);
    logEvent("content", "fix.pattern.generate", {
      traceId, darkPatternType: pattern.dark_pattern_type,
      derivedSelector: truncateText(derivedSelector, 120),
      resolvedSelector: truncateText(targetSelector, 120),
      replacementText: correctedText
    }, "info");
  }

  // Trick wording: when no corrected label is available from fix_hint, annotate the
  // element with an amber outline and hover tooltip. A dim (opacity:0.5) leaves the
  // deceptive text intact and fully readable — a user confused by the double-negative
  // is equally misled by a slightly dimmer version of the same label. The annotation
  // makes the danger visible without altering the element's function.
  if (elementVisible && TRICK_WORDING_TYPES.has(pattern.dark_pattern_type) && !pattern.fix_hint?.trim()) {
    const annotateFix: AnnotateFix = {
      css_selector: targetSelector,
      patch_type: "annotate",
      outline_style: "2px solid #f59e0b",
      warning_title: "Warning: this button’s wording may be misleading — read carefully before clicking",
      source_dark_pattern_type: pattern.dark_pattern_type,
      applied_issues: []
    };
    fixes.push(annotateFix);
    logEvent("content", "fix.pattern.generate", {
      traceId, darkPatternType: pattern.dark_pattern_type,
      derivedSelector: truncateText(derivedSelector, 120),
      resolvedSelector: truncateText(targetSelector, 120),
      strategy: "annotate_misleading_label"
    }, "info");
  }

  // Preselection: uncheck the pre-checked input.
  // The LLM may point at a wrapper or label — walk down to find the actual input.
  // Falls back to dim (via fixes.length === 0 path below) only when no checkable
  // descendant exists (e.g. it's a pre-selected <select> or a toggle switch styled
  // with CSS rather than a real checkbox).
  if (pattern.dark_pattern_type === "Preselection") {
    const checkable = findCheckableInput(targetElement);
    if (checkable) {
      const checkableSelector = buildStableSelector(checkable);
      const uncheckFix: UncheckFix = {
        css_selector: checkableSelector,
        patch_type: "uncheck",
        source_dark_pattern_type: pattern.dark_pattern_type,
        applied_issues: []
      };
      fixes.push(uncheckFix);
      logEvent("content", "fix.pattern.generate", {
        traceId, darkPatternType: pattern.dark_pattern_type,
        derivedSelector: truncateText(derivedSelector, 120),
        resolvedSelector: truncateText(checkableSelector, 120),
        strategy: "uncheck_input"
      }, "info");
    }
  }

  // Hidden information: reveal the concealed content.
  // Two paths:
  //   (a) fix_hint is a CSS selector pointing at the hidden container — use it directly.
  //       This handles the common case where the LLM's html_evidence targets the
  //       disclosure toggle/button rather than the hidden element itself.
  //   (b) The matched element is itself hidden (display:none) — apply display:block
  //       directly. This handles the case where the LLM correctly identified the
  //       hidden container.
  // Falls back to dim when neither condition is met.
  if (pattern.dark_pattern_type === "Hidden information") {
    const hintSelector = pattern.fix_hint?.trim();
    if (hintSelector) {
      try {
        if (document.querySelector(hintSelector)) {
          fixes.push({
            css_selector: hintSelector,
            patch_type: "css",
            css_rules: { display: "block", opacity: "1" },
            source_dark_pattern_type: pattern.dark_pattern_type,
            applied_issues: []
          });
          logEvent("content", "fix.pattern.generate", {
            traceId, darkPatternType: pattern.dark_pattern_type,
            derivedSelector: truncateText(derivedSelector, 120),
            resolvedSelector: truncateText(hintSelector, 120),
            strategy: "reveal_via_fix_hint"
          }, "info");
        }
      } catch { /* fix_hint was not a valid selector — fall through */ }
    } else if (!elementVisible) {
      // Target element itself is hidden — reveal it in place.
      fixes.push({
        css_selector: targetSelector,
        patch_type: "css",
        css_rules: { display: "block", opacity: "1" },
        source_dark_pattern_type: pattern.dark_pattern_type,
        applied_issues: []
      });
      logEvent("content", "fix.pattern.generate", {
        traceId, darkPatternType: pattern.dark_pattern_type,
        derivedSelector: truncateText(derivedSelector, 120),
        resolvedSelector: truncateText(targetSelector, 120),
        strategy: "reveal_self"
      }, "info");
    } else if (isToggleElement(targetElement)) {
      // LLM identified the visible disclosure toggle (button/summary) rather than
      // the hidden container. Simulate a click to trigger the element's own expand
      // behaviour — this works for any toggle pattern without needing fix_hint.
      const clickFix: ClickFix = {
        css_selector: targetSelector,
        patch_type: "click",
        source_dark_pattern_type: pattern.dark_pattern_type,
        applied_issues: []
      };
      fixes.push(clickFix);
      logEvent("content", "fix.pattern.generate", {
        traceId, darkPatternType: pattern.dark_pattern_type,
        derivedSelector: truncateText(derivedSelector, 120),
        resolvedSelector: truncateText(targetSelector, 120),
        strategy: "click_toggle"
      }, "info");
    }
  }

  // Fallback strategies when no issue-specific fix was generated
  if (fixes.length === 0) {
    let fallbackRules: CssFix["css_rules"] | null = null;
    let strategy = "";
    let fallbackSelector = targetSelector;

    if (HIDE_TYPES.has(pattern.dark_pattern_type)) {
      fallbackRules = { display: "none" };
      strategy = "universal_hide";
      // Fake social proof claims often live inside a full-screen popup. Hiding just
      // the text node leaves the modal shell and backdrop visible — the user is still
      // blocked. Walk up to find the popup ancestor and hide that instead.
      if (pattern.dark_pattern_type === "Fake social proof") {
        const modal = findModalAncestor(targetElement);
        if (modal) {
          fallbackSelector = buildStableSelector(modal);
          strategy = "hide_modal_ancestor";
        }
      }
    } else if (TEXT_DIM_TYPES.has(pattern.dark_pattern_type)) {
      fallbackRules = { opacity: "0.5" };
      strategy = "universal_dim";
    } else if (DIM_FALLBACK_TYPES.has(pattern.dark_pattern_type)) {
      fallbackRules = { opacity: "0.7" };
      strategy = "dim_fallback";
    }

    if (fallbackRules) {
      fixes.push({
        css_selector: fallbackSelector,
        patch_type: "css",
        css_rules: fallbackRules,
        source_dark_pattern_type: pattern.dark_pattern_type,
        applied_issues: []
      });
      logEvent("content", "fix.pattern.generate", {
        traceId, darkPatternType: pattern.dark_pattern_type,
        derivedSelector: truncateText(derivedSelector, 120),
        resolvedSelector: truncateText(fallbackSelector, 120),
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

function isPageFix(fix: PageFix | null): fix is PageFix {
  return Boolean(fix);
}

/**
 * Locates the live-DOM element a model's html_evidence refers to, using the exact
 * same selector derivation + best-match scoring the fix path uses. Returns null when
 * no stable selector can be derived or nothing matches. Used by the F1 scorer so that
 * "which element did the model flag" is resolved identically to "which element gets fixed".
 */
export function locateElementForEvidence(
  htmlEvidence: string,
  modelSelector?: string,
  traceId = "f1",
): Element | null {
  // 1. Selector derived from the verbatim opening tag (most precise).
  const derived = deriveSelector(htmlEvidence);
  if (derived) {
    try {
      const candidates = document.querySelectorAll(derived);
      if (candidates.length > 0) {
        return pickBestMatch(candidates, htmlEvidence, traceId, derived);
      }
    } catch {
      // fall through
    }
  }
  // 2. The model's own css_selector — survives when html_evidence truncates on a quote.
  if (modelSelector && modelSelector.trim()) {
    try {
      const candidates = document.querySelectorAll(modelSelector);
      if (candidates.length > 0) {
        return pickBestMatch(candidates, htmlEvidence, traceId, modelSelector);
      }
    } catch {
      // invalid selector — fall through
    }
  }
  // 3. Text-content match for attribute-less evidence like `<a>No thanks…</a>`.
  return locateByText(htmlEvidence);
}

/**
 * Last-resort locator for the F1 scorer: finds the smallest element of the evidence's
 * tag whose normalized text equals (or tightly contains) the evidence's text. Used only
 * for "did the model point at this element" scoring — never for applying a fix.
 */
function locateByText(evidence: string): Element | null {
  const head = firstOpeningTag(evidence);
  const tagMatch = head.match(/^<([a-z][a-z0-9-]*)/i);
  const tag = tagMatch ? tagMatch[1].toLowerCase() : "";
  const text = evidence.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (text.length < 4) return null; // too short to disambiguate reliably

  const scope = tag ? document.querySelectorAll(tag) : document.querySelectorAll("*");
  let best: Element | null = null;
  let bestLen = Infinity;
  for (const element of Array.from(scope)) {
    const elementText = (element.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!elementText) continue;
    const isMatch = elementText === text || elementText.includes(text);
    // Prefer the most specific (shortest-text) element that still contains the evidence text.
    if (isMatch && elementText.length < bestLen) {
      best = element;
      bestLen = elementText.length;
    }
  }
  return best;
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
