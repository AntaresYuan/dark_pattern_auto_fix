import { extractRawHtml } from "./htmlExtractor";
import { extractTruncatedHtml } from "./truncated_new";
import { extractTruncatedHtml as extractTruncatedHtmlOld } from "./truncated";
import { planAndApplyFixes } from "./fixPlanner";
import { applyFixesToPage } from "./patchInjector";
import { getPageKeyFromUrl } from "../shared/pageKey";
import { normalizeError } from "../shared/utils";
import type { ExtensionMessage } from "../shared/messages";
import { createTraceId, logEvent, startStep } from "../shared/logger";
import type { FixApplicationResult, PageContext, PageFixArchive } from "../shared/types";

function collectPageContext(traceId: string, pageKey: string): PageContext {
  const step = startStep("content", "context.collect", { traceId, pageKey });
  const truncatedHtml = extractTruncatedHtml();
  const context: PageContext = {
    truncatedHtml,
    viewport: {
      width: window.innerWidth,
      height: Math.min(window.innerHeight * 2, document.documentElement.scrollHeight),
      scrollY: window.scrollY
    }
  };
  step.finish({ traceId, pageKey, truncatedHtmlLength: truncatedHtml.length, viewport: context.viewport });
  return context;
}

function applySavedFixes(traceId: string, archive: PageFixArchive): FixApplicationResult {
  const step = startStep("content", "archive.apply", {
    traceId,
    pageKey: archive.page_key,
    fixCount: archive.fixes.length
  });
  const appliedCount = applyFixesToPage(archive.fixes, { pageKey: archive.page_key, traceId });
  step.finish({ traceId, pageKey: archive.page_key, fixCount: archive.fixes.length, appliedCount });
  return { archive, appliedCount };
}

logEvent("content", "content.script.start", {
  traceId: createTraceId("content-init"),
  url: window.location.href,
  readyState: document.readyState
});

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  const pageKey = getPageKeyFromUrl(window.location.href);
  const traceId = message.meta?.traceId ?? createTraceId("content");
  const step = startStep("content", "message.handle", {
    traceId,
    pageKey,
    messageType: message.type
  });

  (async () => {
    switch (message.type) {
      case "PING":
        sendResponse({ ok: true });
        step.finish({ traceId, pageKey, messageType: message.type });
        return;
      case "COLLECT_PAGE_CONTEXT":
        sendResponse(collectPageContext(traceId, pageKey));
        step.finish({ traceId, pageKey, messageType: message.type });
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
        step.finish({ traceId, pageKey, messageType: message.type });
        return;
      }
      case "PLAN_AND_APPLY_FIXES": {
        const result = planAndApplyFixes(pageKey, message.patterns, traceId);
        sendResponse(result);
        step.finish({
          traceId,
          pageKey,
          messageType: message.type,
          patternCount: message.patterns.length,
          fixCount: result.archive.fixes.length,
          appliedCount: result.appliedCount
        });
        return;
      }
      case "APPLY_SAVED_FIXES": {
        sendResponse(applySavedFixes(traceId, message.archive));
        step.finish({ traceId, pageKey, messageType: message.type, fixCount: message.archive.fixes.length });
        return;
      }
      default:
        sendResponse({ ok: true });
        step.finish({ traceId, pageKey, messageType: "UNKNOWN" });
    }
  })().catch((error) => {
    step.fail(error, { traceId, pageKey, messageType: message.type });
    sendResponse({
      archive: {
        page_key: pageKey,
        fixes: []
      },
      appliedCount: 0,
      error: normalizeError(error)
    });
  });

  return true;
});
