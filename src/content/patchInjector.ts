import type { AdvertisementLabelFix, CssFix, PageFix } from "../shared/types";

const STYLE_ELEMENT_ID = "dark-pattern-fixer-overrides";
const INSERTED_LABEL_ATTR = "data-dark-pattern-fixer-ad-label";

function getStyleElement(): HTMLStyleElement {
  let styleElement = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!styleElement) {
    styleElement = document.createElement("style");
    styleElement.id = STYLE_ELEMENT_ID;
    document.documentElement.appendChild(styleElement);
  }

  return styleElement;
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

function applyAdvertisementLabelFix(fix: AdvertisementLabelFix): number {
  const target = document.querySelector(fix.css_selector);
  if (!target || hasExistingAdLabel(target)) {
    return 0;
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
  return 1;
}

export function applyFixesToPage(fixes: PageFix[]): number {
  const cssBlocks = fixes
    .filter((fix): fix is CssFix => fix.patch_type === "css")
    .map(serializeFix)
    .filter(Boolean);

  if (cssBlocks.length > 0) {
    getStyleElement().textContent = cssBlocks.join("\n");
  }

  return fixes.reduce((count, fix) => {
    if (fix.patch_type === "advertisement_label") {
      return count + applyAdvertisementLabelFix(fix);
    }

    return count + (serializeFix(fix) ? 1 : 0);
  }, 0);
}
