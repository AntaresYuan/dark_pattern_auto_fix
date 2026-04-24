import { detectDarkPatterns, getActiveProviderName, hasConfiguredDetectionProvider } from "../providers";
import { DARK_PATTERN_FACTS } from "../shared/facts";
import {
  createTraceId,
  logEvent,
  safeError,
  safeUrl,
  startStep,
  summarizeArchive,
  summarizeDataUrl,
  summarizeDetectionResult,
  truncateText
} from "../shared/logger";
import { getPageKeyFromUrl, isSupportedPageUrl } from "../shared/pageKey";
import { buildDarkPatternPrompt } from "../shared/prompt";
import { clearArchivedPages, listArchivedPageKeys, loadArchive, saveArchive } from "../shared/storage";
import type { ExtensionMessage, ExtensionMessageResponse, MessageMeta } from "../shared/messages";
import type { CssFix, DetectionResult, FixApplicationResult, PageContext, PageFix } from "../shared/types";
import { deriveUrlShape, extractHtmlSignature } from "../shared/patternMatcher";
import { clearAllPatternArchives, countPatternArchives, findBestPatternMatch, upsertPatternArchive, type UpsertOutcome } from "../shared/patternStorage";
import { normalizeError } from "../shared/utils";

type PopupState = "initial" | "fixing" | "finished";
type TraceEntryStatus = "running" | "done" | "warn" | "error";

const bodyCopy = document.getElementById("body-copy") as HTMLParagraphElement;
const factCard = document.getElementById("fact-card") as HTMLElement;
const factCopy = document.getElementById("fact-copy") as HTMLParagraphElement;
const actionButton = document.getElementById("action-button") as HTMLButtonElement;
const clearButton = document.getElementById("clear-button") as HTMLButtonElement;

let activeTabId: number | null = null;
let activeWindowId: number | null = null;
let activePageKey = "";
let activeTabUrl = "";
let cachedPageContext: PageContext | null = null;
let tabUpdateListenerAttached = false;
let factTimer: number | null = null;
let currentFactIndex = 0;
let currentState: PopupState | null = null;
const popupSessionTraceId = createTraceId("popup");
let traceStepIndex = 0;
let archivedPageKeys: string[] = [];

function updateClearButton(): void {
  if (archivedPageKeys.length === 0) {
    clearButton.classList.add("hidden");
    clearButton.disabled = false;
    clearButton.textContent = "";
    clearButton.onclick = null;
    return;
  }

  clearButton.classList.remove("hidden");
  clearButton.disabled = currentState === "fixing";
  clearButton.textContent = `Clear All Saved Websites (${archivedPageKeys.length})`;
  clearButton.onclick = () => void handleClearSavedFixes();
}

async function refreshArchivedPageKeys(traceId: string): Promise<void> {
  const [l1Keys, l2Count] = await Promise.all([
    listArchivedPageKeys(traceId),
    countPatternArchives()
  ]);
  // Combine L1 page keys and synthetic L2 entries so the button count is accurate.
  archivedPageKeys = [...l1Keys, ...Array.from({ length: l2Count }, (_, i) => `__pattern__${i}`)];
  updateClearButton();
}

function pushTrace(
  label: string,
  detail: string,
  status: TraceEntryStatus = "running",
  traceId = popupSessionTraceId
): void {
  traceStepIndex += 1;
  logEvent("popup", "popup.trace", {
    traceId,
    stepIndex: traceStepIndex,
    label,
    detail,
    status
  });
}

function serializeFixesToCss(fixes: PageFix[]): string {
  return fixes
    .filter((fix): fix is CssFix => fix.patch_type === "css")
    .map((fix) => {
      const declarations = Object.entries(fix.css_rules)
        .filter(([, value]) => Boolean(value))
        .map(([property, value]) => `${property}: ${value} !important;`)
        .join(" ");
      return declarations ? `${fix.css_selector} { ${declarations} }` : "";
    })
    .filter(Boolean)
    .join("\n");
}

async function injectCssViaScripting(fixes: PageFix[], traceId: string): Promise<void> {
  if (!activeTabId) return;
  const css = serializeFixesToCss(fixes);
  if (!css) return;

  try {
    await chrome.scripting.insertCSS({ target: { tabId: activeTabId }, css });
    logEvent("popup", "popup.scripting.css.injected", {
      traceId,
      cssLength: css.length,
      tabId: activeTabId
    });
  } catch (error) {
    logEvent("popup", "popup.scripting.css.failed", {
      traceId,
      tabId: activeTabId,
      ...safeError(error)
    }, "warn");
  }
}

function createMessageMeta(traceId: string): MessageMeta {
  return {
    traceId,
    pageKey: activePageKey || undefined
  };
}

function withMessageMeta(message: ExtensionMessage, traceId: string): ExtensionMessage {
  return {
    ...message,
    meta: {
      ...message.meta,
      ...createMessageMeta(traceId)
    }
  } as ExtensionMessage;
}

function logState(state: PopupState, errorMessage: string, traceId: string, fields: Record<string, unknown> = {}): void {
  if (currentState === state && !errorMessage && Object.keys(fields).length === 0) {
    return;
  }

  logEvent("popup", "state.transition", {
    traceId,
    pageKey: activePageKey || undefined,
    state,
    errorMessage: errorMessage ? truncateText(errorMessage, 220) : undefined,
    ...fields
  });
}

function setState(state: PopupState, errorMessage = "", traceId = popupSessionTraceId, fields: Record<string, unknown> = {}): void {
  clearFactRotator();
  logState(state, errorMessage, traceId, fields);
  currentState = state;

  if (state === "initial") {
    bodyCopy.textContent =
      errorMessage ||
      "This tool detects possible dark patterns on the current webpage and automatically applies visual fixes. Saved fixes will be reused on similar pages next time.";
    factCard.classList.add("hidden");
    actionButton.textContent = "Start";
    actionButton.disabled = Boolean(errorMessage && !activeTabId);
    actionButton.onclick = () => void startFixFlow();
    updateClearButton();
    return;
  }

  if (state === "fixing") {
    bodyCopy.textContent = "Dark pattern fixing in progress";
    factCard.classList.remove("hidden");
    rotateFact();
    factTimer = window.setInterval(rotateFact, 2200);
    actionButton.textContent = "Working...";
    actionButton.disabled = true;
    actionButton.onclick = null;
    updateClearButton();
    return;
  }

  bodyCopy.textContent = "Dark pattern fixing finished";
  factCard.classList.add("hidden");
  actionButton.textContent = "Run Again";
  actionButton.disabled = false;
  actionButton.onclick = () => void startFixFlow();
  updateClearButton();
}

async function handleClearSavedFixes(): Promise<void> {
  const traceId = createTraceId("clear");
  const step = startStep("popup", "popup.clearSavedFixes", {
    traceId,
    existingArchiveCount: archivedPageKeys.length
  });
  pushTrace("Clear saved fixes", "Removing all saved fix records from extension storage", "running", traceId);
  clearButton.disabled = true;
  clearButton.textContent = "Clearing...";

  try {
    const [removedPageKeys, removedPatternCount] = await Promise.all([
      clearArchivedPages(traceId),
      clearAllPatternArchives()
    ]);
    archivedPageKeys = [];
    updateClearButton();
    const totalRemoved = removedPageKeys.length + removedPatternCount;
    pushTrace("Clear saved fixes", `Removed ${removedPageKeys.length} page archives and ${removedPatternCount} pattern archives`, "done", traceId);
    step.finish({
      clearedCount: totalRemoved,
      pageKeys: removedPageKeys,
      patternCount: removedPatternCount
    });
    const clearedMessage = totalRemoved > 0
      ? `Cleared ${totalRemoved} saved fix record(s).`
      : "There were no saved fixes to clear.";
    if (currentState === "finished") {
      bodyCopy.textContent = `${bodyCopy.textContent} ${clearedMessage}`;
    } else {
      setState("initial", "", traceId, {
        clearAction: true,
        clearedCount: removedPageKeys.length
      });
      bodyCopy.textContent = clearedMessage;
    }
  } catch (error) {
    pushTrace("Clear saved fixes", error instanceof Error ? error.message : String(error), "error", traceId);
    step.fail(error);
    updateClearButton();
    if (currentState !== "fixing") {
      setState("initial", `Failed to clear saved fixes. ${normalizeError(error)}`, traceId);
    }
  }
}

function clearFactRotator(): void {
  if (factTimer !== null) {
    window.clearInterval(factTimer);
    factTimer = null;
  }
}

function rotateFact(): void {
  factCopy.textContent = DARK_PATTERN_FACTS[currentFactIndex % DARK_PATTERN_FACTS.length];
  currentFactIndex += 1;
}

async function getActiveTab(traceId: string): Promise<chrome.tabs.Tab> {
  const step = startStep("popup", "popup.getActiveTab", { traceId });
  pushTrace("Read active tab", "Checking the current tab and URL", "running", traceId);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || !isSupportedPageUrl(tab.url)) {
      throw new Error("Open the extension on a normal http or https page.");
    }

    activeTabId = tab.id;
    activeWindowId = tab.windowId ?? chrome.windows.WINDOW_ID_CURRENT;
    activePageKey = getPageKeyFromUrl(tab.url);
    activeTabUrl = tab.url;
    step.finish({
      pageKey: activePageKey,
      pageUrl: safeUrl(tab.url),
      tabId: activeTabId,
      windowId: activeWindowId
    });
    pushTrace("Read active tab", `Attached to ${activePageKey}`, "done", traceId);
    return tab;
  } catch (error) {
    pushTrace("Read active tab", error instanceof Error ? error.message : String(error), "error", traceId);
    step.fail(error, { supported: false });
    throw error;
  }
}

function isMissingReceiverError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes("Receiving end does not exist")
    || error.message.includes("Could not establish connection");
}

function summarizeOutgoingMessage(message: ExtensionMessage): Record<string, unknown> {
  switch (message.type) {
    case "PLAN_AND_APPLY_FIXES":
      return {
        messageType: message.type,
        patternCount: message.patterns.length
      };
    case "APPLY_SAVED_FIXES":
      return {
        messageType: message.type,
        ...summarizeArchive(message.archive)
      };
    default:
      return {
        messageType: message.type
      };
  }
}

function summarizeResponse(message: ExtensionMessage, response: ExtensionMessageResponse): Record<string, unknown> {
  switch (message.type) {
    case "PING":
      return { ok: true };
    case "COLLECT_PAGE_CONTEXT": {
      const pageContext = response as PageContext;
      return {
        htmlLength: pageContext.truncatedHtml.length,
        viewport: pageContext.viewport
      };
    }
    case "PLAN_AND_APPLY_FIXES":
    case "APPLY_SAVED_FIXES": {
      const fixResult = response as FixApplicationResult;
      return {
        ...summarizeArchive(fixResult.archive),
        appliedCount: fixResult.appliedCount
      };
    }
    default:
      return {};
  }
}

async function sendRawMessage<T extends ExtensionMessageResponse>(traceId: string, message: ExtensionMessage): Promise<T> {
  if (!activeTabId) {
    throw new Error("No active tab is available.");
  }

  const enrichedMessage = withMessageMeta(message, traceId);
  const step = startStep("popup", "popup.message", {
    traceId,
    tabId: activeTabId,
    pageKey: activePageKey || undefined,
    ...summarizeOutgoingMessage(enrichedMessage)
  });

  try {
    const response = await chrome.tabs.sendMessage(activeTabId, enrichedMessage) as T;
    step.finish(summarizeResponse(enrichedMessage, response as ExtensionMessageResponse));
    return response;
  } catch (error) {
    step.fail(error, { messageType: enrichedMessage.type });
    throw error;
  }
}

async function ensureContentScriptReady(traceId: string): Promise<void> {
  if (!activeTabId) {
    throw new Error("No active tab is available.");
  }

  const step = startStep("popup", "popup.contentScript.ensureReady", {
    traceId,
    tabId: activeTabId,
    pageKey: activePageKey || undefined
  });
  pushTrace("Prepare page agent", "Checking whether the content script is ready", "running", traceId);

  try {
    await sendRawMessage(traceId, { type: "PING" });
    step.finish({ ping: "ok", injected: false });
    pushTrace("Prepare page agent", "Content script is already connected", "done", traceId);
    return;
  } catch (error) {
    if (!isMissingReceiverError(error)) {
      step.fail(error, { ping: "failed" });
      throw error;
    }

    logEvent("popup", "popup.contentScript.receiverMissing", {
      traceId,
      tabId: activeTabId,
      pageKey: activePageKey || undefined,
      message: error instanceof Error ? truncateText(error.message, 180) : String(error)
    }, "warn");
    pushTrace("Prepare page agent", "Content script missing, injecting it now", "warn", traceId);
  }

  const injectStep = startStep("popup", "popup.contentScript.inject", {
    traceId,
    tabId: activeTabId,
    pageKey: activePageKey || undefined,
    file: "content.js"
  });

  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      files: ["content.js"]
    });
    injectStep.finish({ injected: true });
    pushTrace("Prepare page agent", "Injected content script into the page", "done", traceId);
  } catch (error) {
    pushTrace("Prepare page agent", error instanceof Error ? error.message : String(error), "error", traceId);
    injectStep.fail(error, { injected: false });
    step.fail(error, { injected: false });
    throw error;
  }

  try {
    await sendRawMessage(traceId, { type: "PING" });
    step.finish({ ping: "ok", injected: true });
    pushTrace("Prepare page agent", "Content script responded after injection", "done", traceId);
  } catch (error) {
    pushTrace("Prepare page agent", error instanceof Error ? error.message : String(error), "error", traceId);
    step.fail(error, { injected: true });
    throw error;
  }
}

async function sendMessage<T extends ExtensionMessageResponse>(traceId: string, message: ExtensionMessage): Promise<T> {
  if (message.type !== "PING") {
    await ensureContentScriptReady(traceId);
  }

  return sendRawMessage<T>(traceId, message);
}

async function captureScreenshot(traceId: string): Promise<string> {
  if (activeWindowId === null) {
    throw new Error("No active window is available.");
  }

  const step = startStep("popup", "popup.captureScreenshot", {
    traceId,
    windowId: activeWindowId
  });
  pushTrace("Capture screenshot", "Capturing the current visible tab", "running", traceId);

  try {
    const screenshot = await chrome.tabs.captureVisibleTab(activeWindowId, {
      format: "jpeg",
      quality: 70
    });

    step.finish({
      ...summarizeDataUrl(screenshot)
    });
    pushTrace("Capture screenshot", `Captured ${Math.round(screenshot.length / 1024)} KB of image data`, "done", traceId);
    return screenshot;
  } catch (error) {
    pushTrace("Capture screenshot", error instanceof Error ? error.message : String(error), "error", traceId);
    step.fail(error);
    throw error;
  }
}

async function maybeApplySavedArchive(traceId: string): Promise<boolean> {
  const step = startStep("popup", "popup.savedArchive.check", {
    traceId,
    pageKey: activePageKey || undefined
  });
  pushTrace("Check cache", "Looking for saved fixes for this page", "running", traceId);

  const archive = await loadArchive(activePageKey, traceId);
  if (!archive || archive.fixes.length === 0) {
    step.finish({ cacheHit: false, fixCount: 0 });
    pushTrace("Check cache", "No saved fixes found, running a fresh analysis", "done", traceId);
    return false;
  }

  step.finish({
    cacheHit: true,
    ...summarizeArchive(archive)
  });
  pushTrace("Check cache", `Found ${archive.fixes.length} saved fixes`, "done", traceId);

  setState("fixing", "", traceId, { flow: "cache-reuse" });

  const result = await sendMessage<FixApplicationResult>(traceId, {
    type: "APPLY_SAVED_FIXES",
    archive
  });
  await injectCssViaScripting(result.archive.fixes, traceId);

  logEvent("popup", "popup.savedArchive.applied", {
    traceId,
    pageKey: activePageKey || undefined,
    ...summarizeArchive(result.archive),
    appliedCount: result.appliedCount
  });
  pushTrace("Replay saved fixes", `Applied ${result.appliedCount} cached fixes`, "done", traceId);

  setState("finished", "", traceId, {
    flow: "cache-reuse",
    appliedCount: result.appliedCount
  });
  return true;
}

async function maybeApplyPatternArchive(traceId: string, pageContext: PageContext): Promise<boolean> {
  const urlShape = deriveUrlShape(activePageKey);
  const sig = extractHtmlSignature(pageContext.truncatedHtml);

  const step = startStep("popup", "popup.patternArchive.check", {
    traceId,
    pageKey: activePageKey || undefined,
    urlShape
  });
  pushTrace("Check pattern cache", `Looking for pattern matches for ${urlShape}`, "running", traceId);

  let match;
  try {
    match = await findBestPatternMatch(urlShape, sig);
  } catch (error) {
    pushTrace("Check pattern cache", error instanceof Error ? error.message : String(error), "warn", traceId);
    step.fail(error);
    return false;
  }

  if (!match) {
    step.finish({ cacheHit: false });
    pushTrace("Check pattern cache", "No pattern match found, running a fresh analysis", "done", traceId);
    return false;
  }

  const fixCount = match.archive.fixes.length;
  step.finish({
    cacheHit: true,
    urlShape: match.archive.urlShape,
    score: match.score,
    fixCount,
    candidateCount: match.candidateCount
  });

  if (fixCount === 0) {
    pushTrace("Check pattern cache", "Pattern matched but no fixes stored (negative cache)", "done", traceId);
    setState("initial", "Cached: no fixable patterns were found on similar pages previously.", traceId);
    return true;
  }

  pushTrace("Check pattern cache", `Found ${fixCount} pattern-matched fixes`, "done", traceId);
  setState("fixing", "", traceId, { flow: "pattern-reuse" });

  const result = await sendMessage<FixApplicationResult>(traceId, {
    type: "APPLY_SAVED_FIXES",
    archive: {
      page_key: activePageKey,
      fixes: match.archive.fixes
    }
  });
  await injectCssViaScripting(result.archive.fixes, traceId);

  pushTrace("Replay pattern fixes", `Applied ${result.appliedCount} pattern-matched fixes`, "done", traceId);
  setState("finished", "", traceId, {
    flow: "pattern-reuse",
    appliedCount: result.appliedCount
  });
  return true;
}

function truncateScreenshotString(dataUrl: string): string {
  return dataUrl.length > 60000 ? `${dataUrl.slice(0, 60000)}...[truncated]` : dataUrl;
}

async function runDetection(traceId: string, pageContext: PageContext, screenshotDataUrl: string): Promise<DetectionResult> {
  pushTrace("Build model input", `Preparing prompt from ${pageContext.truncatedHtml.length} HTML chars and the screenshot`, "running", traceId);
  const prompt = buildDarkPatternPrompt({
    truncatedHtml: pageContext.truncatedHtml,
    screenshotString: truncateScreenshotString(screenshotDataUrl),
    pageUrl: activeTabUrl,
    pageKey: activePageKey || undefined,
    traceId
  });
  pushTrace("Build model input", `Prompt ready (${prompt.length} chars)`, "done", traceId);

  const step = startStep("popup", "popup.detection", {
    traceId,
    pageKey: activePageKey || undefined,
    promptLength: prompt.length,
    screenshotLength: screenshotDataUrl.length,
    htmlLength: pageContext.truncatedHtml.length,
    viewport: pageContext.viewport
  });

  try {
    pushTrace("Run model detection", `Sending the page to ${getActiveProviderName()} for dark pattern detection`, "running", traceId);
    const result = await detectDarkPatterns({
      pageKey: activePageKey || undefined,
      prompt,
      screenshotDataUrl,
      traceId
    });
    step.finish({
      ...summarizeDetectionResult(result)
    });
    pushTrace("Run model detection", `Model returned ${result.identified_dark_patterns.length} suspected dark patterns`, "done", traceId);
    return result;
  } catch (error) {
    pushTrace("Run model detection", error instanceof Error ? error.message : String(error), "error", traceId);
    step.fail(error);
    throw error;
  }
}

async function startFixFlow(): Promise<void> {
  const flowTraceId = createTraceId("flow");
  traceStepIndex = 0;
  const flowStep = startStep("popup", "popup.fixFlow", {
    traceId: flowTraceId,
    pageKey: activePageKey || undefined,
    provider: getActiveProviderName(),
    providerConfigured: hasConfiguredDetectionProvider()
  });

  try {
    setState("fixing", "", flowTraceId, { flow: "manual" });

    pushTrace("Collect page context", "Requesting visible HTML and viewport information from the page", "running", flowTraceId);
    const pageContext = await sendMessage<PageContext>(flowTraceId, {
      type: "COLLECT_PAGE_CONTEXT"
    });
    pushTrace("Collect page context", `Collected ${pageContext.truncatedHtml.length} HTML chars from the page`, "done", flowTraceId);

    // Re-check caches so repeated "Start" clicks reuse Layer 1/2 instead of re-running the LLM.
    const exactReused = await maybeApplySavedArchive(flowTraceId);
    if (exactReused) {
      flowStep.finish({ reused: true, cacheType: "exact" });
      return;
    }

    const patternReused = await maybeApplyPatternArchive(flowTraceId, pageContext);
    if (patternReused) {
      flowStep.finish({ reused: true, cacheType: "pattern" });
      return;
    }

    const screenshotDataUrl = await captureScreenshot(flowTraceId);
    const detectionResult = await runDetection(flowTraceId, pageContext, screenshotDataUrl);

    pushTrace("Plan fixes", `Turning ${detectionResult.identified_dark_patterns.length} detected patterns into concrete fixes`, "running", flowTraceId);
    const fixResult = await sendMessage<FixApplicationResult>(flowTraceId, {
      type: "PLAN_AND_APPLY_FIXES",
      patterns: detectionResult.identified_dark_patterns
    });
    await injectCssViaScripting(fixResult.archive.fixes, flowTraceId);
    pushTrace("Plan fixes", `Prepared ${fixResult.archive.fixes.length} fixes and applied ${fixResult.appliedCount}`, "done", flowTraceId);

    const saveStep = startStep("popup", "popup.archive.save", {
      traceId: flowTraceId,
      pageKey: activePageKey || undefined,
      ...summarizeArchive(fixResult.archive)
    });
    try {
      pushTrace("Save result", "Saving generated fixes for future visits", "running", flowTraceId);
      await saveArchive(fixResult.archive, flowTraceId);
      await refreshArchivedPageKeys(flowTraceId);
      saveStep.finish({
        ...summarizeArchive(fixResult.archive)
      });
      pushTrace("Save result", `Saved ${fixResult.archive.fixes.length} fixes for future visits`, "done", flowTraceId);
    } catch (error) {
      pushTrace("Save result", error instanceof Error ? error.message : String(error), "error", flowTraceId);
      saveStep.fail(error, {
        ...summarizeArchive(fixResult.archive)
      });
      throw error;
    }

    setState("finished", "", flowTraceId, {
      flow: "manual",
      appliedCount: fixResult.appliedCount
    });
    flowStep.finish({
      ...summarizeArchive(fixResult.archive),
      appliedCount: fixResult.appliedCount
    });

    // Persist pattern archive (fire-and-forget — must not block or break main flow)
    const sig = extractHtmlSignature(pageContext.truncatedHtml);
    void upsertPatternArchive(activePageKey, sig, fixResult.archive.fixes, detectionResult).then((outcome: UpsertOutcome) => {
      const urlShape = deriveUrlShape(activePageKey);
      if (outcome.wrote) {
        logEvent("popup", "popup.patternArchive.upserted", {
          urlShape,
          action: outcome.action,
          fixCount: outcome.fixCount,
          traceId: flowTraceId
        });
      } else {
        logEvent("popup", "popup.patternArchive.skipped", {
          urlShape,
          reason: outcome.reason,
          traceId: flowTraceId
        });
      }
    }).catch((error: unknown) => {
      logEvent("popup", "popup.patternArchive.upsertFailed", {
        traceId: flowTraceId,
        ...safeError(error)
      }, "error");
    });

  } catch (error) {
    const prefix = hasConfiguredDetectionProvider()
      ? "Fixing failed."
      : `Configure ${getActiveProviderName()} in src/config.ts/.env first.`;
    const message = error instanceof Error ? error.message : String(error);
    flowStep.fail(error, {
      pageKey: activePageKey || undefined
    });
    pushTrace("Flow failed", message, "error", flowTraceId);
    setState("initial", `${prefix} ${message}`, flowTraceId, {
      flow: "manual",
      error: safeError(error)
    });
  }
}

function attachTabUpdateListener(): void {
  if (tabUpdateListenerAttached) return;
  tabUpdateListenerAttached = true;
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId !== activeTabId || changeInfo.status !== "complete") return;
    cachedPageContext = null;
    void bootstrap();
  });
}

async function bootstrap(): Promise<void> {
  const bootstrapTraceId = popupSessionTraceId;
  traceStepIndex = 0;
  const bootstrapStep = startStep("popup", "popup.bootstrap", {
    traceId: bootstrapTraceId,
    provider: getActiveProviderName(),
    providerConfigured: hasConfiguredDetectionProvider()
  });

  try {
    await refreshArchivedPageKeys(bootstrapTraceId);
    const tab = await getActiveTab(bootstrapTraceId);
    attachTabUpdateListener();
    logEvent("popup", "popup.bootstrap.activeTab", {
      traceId: bootstrapTraceId,
      pageKey: activePageKey,
      pageUrl: safeUrl(tab.url ?? "")
    });

    const reused = await maybeApplySavedArchive(bootstrapTraceId);
    if (!reused) {
      setState("initial", "", bootstrapTraceId, {
        flow: "bootstrap"
      });
    }
    bootstrapStep.finish({
      pageKey: activePageKey || undefined,
      reused
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    bootstrapStep.fail(error, {
      pageKey: activePageKey || undefined
    });
    setState("initial", message, bootstrapTraceId, {
      flow: "bootstrap",
      error: safeError(error)
    });
  }
}

logEvent("popup", "popup.session.start", {
  traceId: popupSessionTraceId,
  provider: getActiveProviderName(),
  providerConfigured: hasConfiguredDetectionProvider()
});

void bootstrap();
