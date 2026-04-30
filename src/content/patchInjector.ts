import type { AdvertisementLabelFix, CssFix, PageFix } from "../shared/types";
import { logEvent, startStep, truncateText } from "../shared/logger";

const STYLE_ELEMENT_ID = "dark-pattern-fixer-overrides";
const INSERTED_LABEL_ATTR = "data-dark-pattern-fixer-ad-label";

function getStyleElement(): { element: HTMLStyleElement; created: boolean } {
  let styleElement = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  let created = false;
  if (!styleElement) {
    styleElement = document.createElement("style");
    styleElement.id = STYLE_ELEMENT_ID;
    document.documentElement.appendChild(styleElement);
    created = true;
  }

  return { element: styleElement, created };
}

function serializeFix(fix: CssFix): string {
  const declarations = Object.entries(fix.css_rules)
    .filter(([, value]) => Boolean(value))
    .map(([property, value]) => `${property}: ${value} !important;`)
    .join(" ");

  if (!declarations) {
    return "";
  }

  return `${fix.css_selector} { ${declarations} }`;
}

function isAdLabelText(text: string | null | undefined): boolean {
  return /^(ad|advertisement)$/i.test(text?.trim() ?? "");
}

function hasExistingAdLabel(target: Element): boolean {
  const parent = target.parentElement;
  if (!parent) {
    return false;
  }

  for (const sibling of Array.from(parent.children)) {
    if (sibling === target) {
      break;
    }

    if (
      sibling instanceof HTMLElement
      && (sibling.hasAttribute(INSERTED_LABEL_ATTR) || isAdLabelText(sibling.textContent))
    ) {
      return true;
    }
  }

  return false;
}

function applyAdvertisementLabelFix(
  fix: AdvertisementLabelFix,
  logContext: { pageKey?: string; traceId?: string }
): "applied" | "target_missing" | "existing_label_present" {
  const target = document.querySelector(fix.css_selector);
  if (!target) {
    logEvent("content", "patch.apply.label", {
      pageKey: logContext.pageKey,
      selector: truncateText(fix.css_selector, 120),
      traceId: logContext.traceId,
      outcome: "target_missing"
    }, "warn");
    return "target_missing";
  }

  if (hasExistingAdLabel(target)) {
    logEvent("content", "patch.apply.label", {
      pageKey: logContext.pageKey,
      selector: truncateText(fix.css_selector, 120),
      traceId: logContext.traceId,
      outcome: "existing_label_present"
    }, "debug");
    return "existing_label_present";
  }

  const label = document.createElement("div");
  label.setAttribute(INSERTED_LABEL_ATTR, "true");
  label.textContent = fix.label_text;
  label.style.color = "#000000";
  label.style.fontSize = "13px";
  label.style.fontWeight = "600";
  label.style.letterSpacing = "0.18em";
  label.style.lineHeight = "1.2";
  label.style.marginBottom = "12px";
  label.style.textTransform = "uppercase";

  target.parentElement?.insertBefore(label, target);
  logEvent("content", "patch.apply.label", {
    pageKey: logContext.pageKey,
    selector: truncateText(fix.css_selector, 120),
    traceId: logContext.traceId,
    outcome: "applied"
  }, "info");
  return "applied";
}

export function applyFixesToPage(
  fixes: PageFix[],
  logContext: { pageKey?: string; traceId?: string } = {}
): number {
  const step = startStep("content", "patch.apply", {
    pageKey: logContext.pageKey,
    traceId: logContext.traceId,
    totalFixes: fixes.length,
    cssFixCount: fixes.filter((fix): fix is CssFix => fix.patch_type === "css").length,
    adLabelFixCount: fixes.filter((fix) => fix.patch_type === "advertisement_label").length
  });

  const requestedCssFixCount = fixes.filter((fix): fix is CssFix => fix.patch_type === "css").length;
  const cssBlocks = fixes
    .filter((fix): fix is CssFix => fix.patch_type === "css")
    .map(serializeFix)
    .filter(Boolean);
  let created = false;
  let appliedAdLabelCount = 0;
  let skippedAdLabelCount = 0;

  if (cssBlocks.length > 0) {
    const style = getStyleElement();
    created = style.created;
    style.element.textContent = cssBlocks.join("\n");
    logEvent("content", "patch.apply.css", {
      pageKey: logContext.pageKey,
      requestedCssFixCount,
      serializedCssBlockCount: cssBlocks.length,
      styleElementCreated: created,
      traceId: logContext.traceId
    }, "info");
  } else {
    logEvent("content", "patch.apply.css", {
      pageKey: logContext.pageKey,
      requestedCssFixCount,
      serializedCssBlockCount: 0,
      styleElementCreated: false,
      traceId: logContext.traceId
    }, "debug");
  }

  const appliedCount = fixes.reduce((count, fix) => {
    if (fix.patch_type === "advertisement_label") {
      const outcome = applyAdvertisementLabelFix(fix, logContext);
      if (outcome === "applied") {
        appliedAdLabelCount += 1;
        return count + 1;
      }

      skippedAdLabelCount += 1;
      return count;
    }

    return count + (serializeFix(fix) ? 1 : 0);
  }, 0);

  step.finish({
    requestedFixCount: fixes.length,
    serializedCssBlockCount: cssBlocks.length,
    appliedCssCount: cssBlocks.length,
    appliedAdLabelCount,
    skippedAdLabelCount,
    pageKey: logContext.pageKey,
    appliedCount
  });
  return appliedCount;
}
