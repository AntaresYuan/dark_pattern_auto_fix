import { extractTruncatedHtml } from "./htmlExtractor";
import { planAndApplyFixes } from "./fixPlanner";
import { applyFixesToPage } from "./patchInjector";
import { getPageKeyFromUrl } from "../shared/pageKey";
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
      error: error instanceof Error ? error.message : String(error)
    });
  });

  return true;
});
