import { extractRawHtml } from "./htmlExtractor";
import { extractTruncatedHtml } from "./truncated_new";
import { extractTruncatedHtml as extractTruncatedHtmlOld } from "./truncated";
import { planAndApplyFixes } from "./fixPlanner";
import { applyFixesToPage } from "./patchInjector";
import { getPageKeyFromUrl } from "../shared/pageKey";
import { normalizeError } from "../shared/utils";
import type { ExtensionMessage } from "../shared/messages";
import type { FixApplicationResult, PageContext, PageFixArchive } from "../shared/types";

function collectPageContext(): PageContext {
  return {
    truncatedHtml: extractTruncatedHtml(),
    viewport: {
      width: window.innerWidth,
      height: Math.min(window.innerHeight * 2, document.documentElement.scrollHeight),
      scrollY: window.scrollY
    }
  };
}

function applySavedFixes(archive: PageFixArchive): FixApplicationResult {
  const appliedCount = applyFixesToPage(archive.fixes);
  return { archive, appliedCount };
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "PING":
        sendResponse({ ok: true });
        return;
      case "COLLECT_PAGE_CONTEXT":
        sendResponse(collectPageContext());
        return;
      case "COLLECT_HTML_DEBUG": {
        const rawHtml = extractRawHtml();
        const truncatedHtml = extractTruncatedHtml();
        const truncatedHtmlOld = extractTruncatedHtmlOld();
        console.log(
          `[html-debug] original: ${rawHtml.length} chars` +
          ` | truncated_new: ${truncatedHtml.length} chars (${(truncatedHtml.length / rawHtml.length * 100).toFixed(1)}% of original)` +
          ` | truncated_old: ${truncatedHtmlOld.length} chars (${(truncatedHtmlOld.length / rawHtml.length * 100).toFixed(1)}% of original)`
        );
        sendResponse({ rawHtml, truncatedHtml, truncatedHtmlOld });
        return;
      }
      case "PLAN_AND_APPLY_FIXES": {
        const pageKey = getPageKeyFromUrl(window.location.href);
        sendResponse(planAndApplyFixes(pageKey, message.patterns));
        return;
      }
      case "APPLY_SAVED_FIXES":
        sendResponse(applySavedFixes(message.archive));
        return;
      default:
        sendResponse({ ok: true });
    }
  })().catch((error) => {
    sendResponse({
      archive: {
        page_key: getPageKeyFromUrl(window.location.href),
        fixes: []
      },
      appliedCount: 0,
      error: normalizeError(error)
    });
  });

  return true;
});
