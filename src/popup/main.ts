import { detectDarkPatterns, getActiveProviderName, hasConfiguredDetectionProvider } from "../providers";
import { DARK_PATTERN_FACTS } from "../shared/facts";
import { getPageKeyFromUrl, isSupportedPageUrl } from "../shared/pageKey";
import { buildDarkPatternPrompt } from "../shared/prompt";
import { loadArchive, saveArchive } from "../shared/storage";
import type { ExtensionMessage, ExtensionMessageResponse } from "../shared/messages";
import type { DetectionResult, FixApplicationResult, PageContext } from "../shared/types";

type PopupState = "initial" | "fixing" | "finished";
type TimedRunnerResult<T> = Promise<{ value: T; durationMs: number }>;

const bodyCopy = document.getElementById("body-copy") as HTMLParagraphElement;
const factCard = document.getElementById("fact-card") as HTMLElement;
const factCopy = document.getElementById("fact-copy") as HTMLParagraphElement;
const resetButton = document.getElementById("reset-button") as HTMLButtonElement;
const actionButton = document.getElementById("action-button") as HTMLButtonElement;

let activeTabId: number | null = null;
let activeWindowId: number | null = null;
let activePageKey = "";
let factTimer: number | null = null;
let currentFactIndex = 0;
const POPUP_LOG_PREFIX = "[DarkPatternFixer:popup]";

function logInfo(step: string, details?: Record<string, unknown>): void {
  if (details) {
    console.info(`${POPUP_LOG_PREFIX} ${step}`, details);
    return;
  }
  console.info(`${POPUP_LOG_PREFIX} ${step}`);
}

function logError(step: string, error: unknown, details?: Record<string, unknown>): void {
  const normalizedMessage = error instanceof Error ? error.message : String(error);
  console.error(`${POPUP_LOG_PREFIX} ${step}`, { ...details, error: normalizedMessage });
}

async function withTiming<T>(run: () => Promise<T>): TimedRunnerResult<T> {
  const startedAt = performance.now();
  const value = await run();
  return {
    value,
    durationMs: Math.round(performance.now() - startedAt)
  };
}

function setState(state: PopupState, errorMessage = ""): void {
  clearFactRotator();
  resetButton.disabled = state === "fixing";

  if (state === "initial") {
    bodyCopy.textContent =
      errorMessage ||
      "This tool detects possible dark patterns on the current webpage and automatically applies visual fixes. Saved fixes will be reused on similar pages next time.";
    factCard.classList.add("hidden");
    actionButton.textContent = "Start";
    actionButton.disabled = Boolean(errorMessage && !activeTabId);
    actionButton.onclick = () => void startFixFlow();
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
    return;
  }

  bodyCopy.textContent = "Dark pattern fixing finished";
  factCard.classList.add("hidden");
  actionButton.textContent = "Close";
  actionButton.disabled = false;
  actionButton.onclick = () => window.close();
}

async function resetCache(): Promise<void> {
  resetButton.disabled = true;
  logInfo("reset-cache:start");
  try {
    await chrome.storage.local.clear();
    logInfo("reset-cache:done");
    setState("initial", "Cache cleared. Start to run a fresh detection on this page.");
  } catch (error) {
    logError("reset-cache:failed", error);
    const message = error instanceof Error ? error.message : String(error);
    setState("initial", `Could not clear cache. ${message}`);
  } finally {
    resetButton.disabled = false;
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

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !isSupportedPageUrl(tab.url)) {
    throw new Error("Open the extension on a normal http or https page.");
  }

  activeTabId = tab.id;
  activeWindowId = tab.windowId ?? chrome.windows.WINDOW_ID_CURRENT;
  activePageKey = getPageKeyFromUrl(tab.url);
  logInfo("active-tab:resolved", {
    tabId: activeTabId,
    windowId: activeWindowId,
    pageKey: activePageKey
  });
  return tab;
}

function isMissingReceiverError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes("Receiving end does not exist")
    || error.message.includes("Could not establish connection");
}

async function ensureContentScriptReady(): Promise<void> {
  if (!activeTabId) {
    throw new Error("No active tab is available.");
  }

  try {
    await chrome.tabs.sendMessage(activeTabId, { type: "PING" } satisfies ExtensionMessage);
    logInfo("content-script:ping-ok", { tabId: activeTabId });
    return;
  } catch (error) {
    if (!isMissingReceiverError(error)) {
      throw error;
    }
    logInfo("content-script:not-ready-injecting", { tabId: activeTabId });
  }

  await chrome.scripting.executeScript({
    target: { tabId: activeTabId },
    files: ["content.js"]
  });

  await chrome.tabs.sendMessage(activeTabId, { type: "PING" } satisfies ExtensionMessage);
  logInfo("content-script:injected-and-ready", { tabId: activeTabId });
}

async function sendMessage<T extends ExtensionMessageResponse>(message: ExtensionMessage): Promise<T> {
  if (!activeTabId) {
    throw new Error("No active tab is available.");
  }

  await ensureContentScriptReady();
  const startedAt = performance.now();
  const response = await (chrome.tabs.sendMessage(activeTabId, message) as Promise<T>);
  const durationMs = Math.round(performance.now() - startedAt);
  logInfo("message:response", { type: message.type, durationMs });
  return response;
}

async function captureScreenshot(): Promise<string> {
  if (activeWindowId === null) {
    throw new Error("No active window is available.");
  }

  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(activeWindowId, {
    format: "jpeg",
    quality: 70
  });
  logInfo("screenshot:captured", {
    length: screenshotDataUrl.length
  });
  return screenshotDataUrl;
}

async function maybeApplySavedArchive(): Promise<boolean> {
  const archive = await loadArchive(activePageKey);
  if (!archive || archive.fixes.length === 0) {
    logInfo("archive:miss", { pageKey: activePageKey });
    return false;
  }

  logInfo("archive:hit", { pageKey: activePageKey, fixes: archive.fixes.length });
  setState("fixing");
  const applied = await sendMessage<FixApplicationResult>({
    type: "APPLY_SAVED_FIXES",
    archive
  });
  logInfo("archive:applied", {
    appliedCount: applied.appliedCount
  });
  setState("finished");
  return true;
}

function truncateScreenshotString(dataUrl: string): string {
  return dataUrl.length > 60000 ? `${dataUrl.slice(0, 60000)}...[truncated]` : dataUrl;
}

async function runDetection(pageContext: PageContext, screenshotDataUrl: string): Promise<DetectionResult> {
  const prompt = buildDarkPatternPrompt({
    screenshotString: truncateScreenshotString(screenshotDataUrl),
    truncatedHtml: pageContext.truncatedHtml
  });
  logInfo("detection:request", {
    provider: getActiveProviderName(),
    truncatedHtmlLength: pageContext.truncatedHtml.length,
    promptLength: prompt.length
  });

  const result = await detectDarkPatterns({
    prompt,
    screenshotDataUrl
  });
  logInfo("detection:response", {
    patterns: result.identified_dark_patterns.length
  });
  return result;
}

async function startFixFlow(): Promise<void> {
  logInfo("flow:start");
  try {
    setState("fixing");

    const pageContextResult = await withTiming(() => sendMessage<PageContext>({
      type: "COLLECT_PAGE_CONTEXT"
    }));
    const pageContext = pageContextResult.value;
    logInfo("flow:page-context-collected", {
      durationMs: pageContextResult.durationMs,
      truncatedHtmlLength: pageContext.truncatedHtml.length,
      viewport: pageContext.viewport
    });

    const screenshotResult = await withTiming(captureScreenshot);
    const screenshotDataUrl = screenshotResult.value;
    logInfo("flow:screenshot-captured", { durationMs: screenshotResult.durationMs });

    const detectionStepResult = await withTiming(() => runDetection(pageContext, screenshotDataUrl));
    const detectionResult = detectionStepResult.value;
    logInfo("flow:detection-finished", {
      durationMs: detectionStepResult.durationMs,
      patterns: detectionResult.identified_dark_patterns
    });

    const fixStepResult = await withTiming(() => sendMessage<FixApplicationResult>({
      type: "PLAN_AND_APPLY_FIXES",
      patterns: detectionResult.identified_dark_patterns
    }));
    const fixResult = fixStepResult.value;
    logInfo("flow:fixes-applied", {
      durationMs: fixStepResult.durationMs,
      appliedCount: fixResult.appliedCount,
      fixes: fixResult.archive.fixes.length
    });

    const saveStepResult = await withTiming(() => saveArchive(fixResult.archive));
    logInfo("flow:archive-saved", { durationMs: saveStepResult.durationMs, pageKey: fixResult.archive.page_key });
    setState("finished");
    logInfo("flow:finished");
  } catch (error) {
    logError("flow:failed", error);
    const prefix = hasConfiguredDetectionProvider()
      ? "Fixing failed."
      : `Configure ${getActiveProviderName()} in src/config.ts/.env first.`;
    const message = error instanceof Error ? error.message : String(error);
    setState("initial", `${prefix} ${message}`);
  }
}

async function bootstrap(): Promise<void> {
  logInfo("bootstrap:start");
  try {
    const tabResult = await withTiming(getActiveTab);
    logInfo("bootstrap:active-tab-ready", { durationMs: tabResult.durationMs });
    const reused = await maybeApplySavedArchive();
    if (!reused) {
      setState("initial");
      logInfo("bootstrap:ready-for-start");
    }
  } catch (error) {
    logError("bootstrap:failed", error);
    const message = error instanceof Error ? error.message : String(error);
    setState("initial", message);
  }
}

void bootstrap();
resetButton.onclick = () => void resetCache();
