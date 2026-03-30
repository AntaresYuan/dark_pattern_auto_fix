import {
  detectDarkPatterns,
  getActiveProviderName,
  hasConfiguredDetectionProvider,
} from "../providers";
import { DARK_PATTERN_FACTS } from "../shared/facts";
import { getPageKeyFromUrl, isSupportedPageUrl } from "../shared/pageKey";
import { buildDarkPatternPrompt } from "../shared/prompt";
import { loadArchive, saveArchive } from "../shared/storage";
import { deriveUrlShape, extractHtmlSignature } from "../shared/patternMatcher";
import { findBestPatternMatch, upsertPatternArchive } from "../shared/patternStorage";
import {
  beginVerification,
  flushVerification,
  recordContextReuse,
  recordExactLayer,
  recordPatternLayerAttempt,
  recordPatternLayerHit,
  recordPatternLayerMiss,
  recordPatternLayerSkipped,
  recordPatternUpsertSuccess,
  recordResetCacheSuccess,
} from "../shared/verificationTelemetry";
import type {
  ExtensionMessage,
  ExtensionMessageResponse,
} from "../shared/messages";
import type {
  DetectionResult,
  FixApplicationResult,
  PageContext,
} from "../shared/types";

type PopupState = "initial" | "fixing" | "finished";
type TimedRunnerResult<T> = Promise<{ value: T; durationMs: number }>;

const bodyCopy = document.getElementById("body-copy") as HTMLParagraphElement;
const factCard = document.getElementById("fact-card") as HTMLElement;
const factCopy = document.getElementById("fact-copy") as HTMLParagraphElement;
const resetButton = document.getElementById(
  "reset-button",
) as HTMLButtonElement;
const actionButton = document.getElementById(
  "action-button",
) as HTMLButtonElement;

let activeTabId: number | null = null;
let activeWindowId: number | null = null;
let activePageKey = "";
/** Cached page context from bootstrap's pattern-matching probe — reused in startFixFlow */
let cachedPageContext: PageContext | null = null;
let factTimer: number | null = null;
let currentFactIndex = 0;
const POPUP_LOG_PREFIX = "[DarkPatternFixer:popup]";
const SCREENSHOT_OUTPUT_QUALITY = 0.7;
const SCREENSHOT_TARGET_PIXEL_COUNT = 945000;
const SCREENSHOT_MIN_WIDTH = 640;
const SCREENSHOT_MIN_HEIGHT = 360;

function logInfo(step: string, details?: Record<string, unknown>): void {
  if (details) {
    console.info(`${POPUP_LOG_PREFIX} ${step}`, details);
    return;
  }
  console.info(`${POPUP_LOG_PREFIX} ${step}`);
}

function logError(
  step: string,
  error: unknown,
  details?: Record<string, unknown>,
): void {
  const normalizedMessage =
    error instanceof Error ? error.message : String(error);
  console.error(`${POPUP_LOG_PREFIX} ${step}`, {
    ...details,
    error: normalizedMessage,
  });
}

async function withTiming<T>(run: () => Promise<T>): TimedRunnerResult<T> {
  const startedAt = performance.now();
  const value = await run();
  return {
    value,
    durationMs: Math.round(performance.now() - startedAt),
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
    recordResetCacheSuccess();
    logInfo("reset-cache:done");
    setState(
      "initial",
      "Cache cleared. Start to run a fresh detection on this page.",
    );
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
  factCopy.textContent =
    DARK_PATTERN_FACTS[currentFactIndex % DARK_PATTERN_FACTS.length];
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
    pageKey: activePageKey,
  });
  return tab;
}

function isMissingReceiverError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("Receiving end does not exist") ||
    error.message.includes("Could not establish connection")
  );
}

async function ensureContentScriptReady(): Promise<void> {
  if (!activeTabId) {
    throw new Error("No active tab is available.");
  }

  try {
    await chrome.tabs.sendMessage(activeTabId, {
      type: "PING",
    } satisfies ExtensionMessage);
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
    files: ["content.js"],
  });

  await chrome.tabs.sendMessage(activeTabId, {
    type: "PING",
  } satisfies ExtensionMessage);
  logInfo("content-script:injected-and-ready", { tabId: activeTabId });
}

async function sendMessage<T extends ExtensionMessageResponse>(
  message: ExtensionMessage,
): Promise<T> {
  if (!activeTabId) {
    throw new Error("No active tab is available.");
  }

  await ensureContentScriptReady();
  const startedAt = performance.now();
  const response = await (chrome.tabs.sendMessage(
    activeTabId,
    message,
  ) as Promise<T>);
  const durationMs = Math.round(performance.now() - startedAt);
  logInfo("message:response", { type: message.type, durationMs });
  return response;
}

function loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not decode screenshot data URL."));
    image.src = dataUrl;
  });
}

async function downscaleScreenshotDataUrl(
  dataUrl: string,
  quality: number,
): Promise<{
  dataUrl: string;
  width: number;
  height: number;
  scaleFactor: number;
  sourceWidth: number;
  sourceHeight: number;
}> {
  const image = await loadImageFromDataUrl(dataUrl);
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  const sourcePixelCount = sourceWidth * sourceHeight;
  const areaScale =
    sourcePixelCount > SCREENSHOT_TARGET_PIXEL_COUNT
      ? Math.sqrt(SCREENSHOT_TARGET_PIXEL_COUNT / sourcePixelCount)
      : 1;
  const minScaleByWidth = SCREENSHOT_MIN_WIDTH / sourceWidth;
  const minScaleByHeight = SCREENSHOT_MIN_HEIGHT / sourceHeight;
  const minRequiredScale = Math.max(minScaleByWidth, minScaleByHeight);
  const scaleFactor = Math.min(1, Math.max(areaScale, minRequiredScale));
  const width = Math.max(1, Math.round(sourceWidth * scaleFactor));
  const height = Math.max(1, Math.round(sourceHeight * scaleFactor));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not initialize canvas 2D context for screenshot downscale.");
  }

  context.drawImage(image, 0, 0, width, height);
  return {
    dataUrl: canvas.toDataURL("image/jpeg", quality),
    width,
    height,
    scaleFactor,
    sourceWidth,
    sourceHeight,
  };
}

async function captureScreenshot(): Promise<string> {
  if (activeWindowId === null) {
    throw new Error("No active window is available.");
  }

  const rawScreenshotDataUrl = await chrome.tabs.captureVisibleTab(activeWindowId, {
    format: "png",
  });
  const downscaled = await downscaleScreenshotDataUrl(
    rawScreenshotDataUrl,
    SCREENSHOT_OUTPUT_QUALITY,
  );
  const screenshotDataUrl = downscaled.dataUrl;
  logInfo("screenshot:captured", {
    sourceWidth: downscaled.sourceWidth,
    sourceHeight: downscaled.sourceHeight,
    width: downscaled.width,
    height: downscaled.height,
    downscaleFactor: Number(downscaled.scaleFactor.toFixed(4)),
    outputQuality: SCREENSHOT_OUTPUT_QUALITY,
    length: screenshotDataUrl.length,
  });
  return screenshotDataUrl;
}

async function maybeApplySavedArchive(): Promise<boolean> {
  const archive = await loadArchive(activePageKey);
  if (!archive || archive.fixes.length === 0) {
    recordExactLayer("MISS");
    logInfo("archive:miss", { pageKey: activePageKey });
    return false;
  }

  recordExactLayer("HIT", archive.fixes.length);
  logInfo("archive:hit", {
    pageKey: activePageKey,
    fixes: archive.fixes.length,
  });
  setState("fixing");
  const applied = await sendMessage<FixApplicationResult>({
    type: "APPLY_SAVED_FIXES",
    archive,
  });
  logInfo("archive:applied", {
    appliedCount: applied.appliedCount,
  });
  setState("finished");
  flushVerification("finished");
  return true;
}

async function maybeApplyPatternArchive(pageContext: PageContext): Promise<boolean> {
  const urlShape = deriveUrlShape(activePageKey);
  const sig = extractHtmlSignature(pageContext.truncatedHtml);
  recordPatternLayerAttempt(urlShape);

  logInfo("pattern:matching", { urlShape });

  let match;
  try {
    match = await findBestPatternMatch(urlShape, sig);
  } catch (error) {
    recordPatternLayerMiss();
    logError("pattern:lookup-failed", error, { urlShape });
    return false;
  }

  if (!match) {
    recordPatternLayerMiss();
    logInfo("pattern:miss", { urlShape });
    return false;
  }

  recordPatternLayerHit({
    urlShape,
    candidateCount: match.candidateCount,
    fixes: match.archive.fixes.length,
    scoreBreakdown: match.scoreBreakdown,
  });
  logInfo("pattern:hit", {
    urlShape,
    score: Number(match.score.toFixed(3)),
    matchPath: match.scoreBreakdown.matchPath,
    urlConsistencyScore: match.scoreBreakdown.urlConsistencyScore != null
      ? Number(match.scoreBreakdown.urlConsistencyScore.toFixed(3))
      : undefined,
    fixes: match.archive.fixes.length,
    hitCount: match.archive.hitCount,
  });

  setState("fixing");
  const applied = await sendMessage<FixApplicationResult>({
    type: "APPLY_SAVED_FIXES",
    archive: {
      page_key: activePageKey,
      fixes: match.archive.fixes,
    },
  });
  logInfo("pattern:applied", { appliedCount: applied.appliedCount });
  setState("finished");
  flushVerification("finished");
  return true;
}

function truncateScreenshotString(dataUrl: string): string {
  return dataUrl.length > 60000
    ? `${dataUrl.slice(0, 60000)}...[truncated]`
    : dataUrl;
}

async function runDetection(
  pageContext: PageContext,
  screenshotDataUrl: string,
): Promise<DetectionResult> {
  const prompt = buildDarkPatternPrompt({
    screenshotString: truncateScreenshotString(screenshotDataUrl),
    truncatedHtml: pageContext.truncatedHtml,
  });
  logInfo("detection:request", {
    provider: getActiveProviderName(),
    truncatedHtmlLength: pageContext.truncatedHtml.length,
    promptLength: prompt.length,
  });

  const result = await detectDarkPatterns({
    prompt,
    screenshotDataUrl,
  });
  logInfo("detection:response", {
    patterns: result.identified_dark_patterns.length,
  });
  return result;
}

async function startFixFlow(): Promise<void> {
  logInfo("flow:start");
  try {
    setState("fixing");

    const pageContextResult = await withTiming(async () => {
      if (cachedPageContext) {
        logInfo("flow:page-context-reused-from-cache");
        recordContextReuse();
        return cachedPageContext;
      }
      return sendMessage<PageContext>({ type: "COLLECT_PAGE_CONTEXT" });
    });
    const pageContext = pageContextResult.value;
    logInfo("flow:page-context-collected", {
      durationMs: pageContextResult.durationMs,
      truncatedHtmlLength: pageContext.truncatedHtml.length,
      viewport: pageContext.viewport,
    });

    const screenshotResult = await withTiming(captureScreenshot);
    const screenshotDataUrl = screenshotResult.value;
    logInfo("flow:screenshot-captured", {
      durationMs: screenshotResult.durationMs,
    });

    const detectionStepResult = await withTiming(() =>
      runDetection(pageContext, screenshotDataUrl),
    );
    const detectionResult = detectionStepResult.value;
    logInfo("flow:detection-finished", {
      durationMs: detectionStepResult.durationMs,
      patterns: detectionResult.identified_dark_patterns,
    });

    const fixStepResult = await withTiming(() =>
      sendMessage<FixApplicationResult>({
        type: "PLAN_AND_APPLY_FIXES",
        patterns: detectionResult.identified_dark_patterns,
      }),
    );
    const fixResult = fixStepResult.value;
    logInfo("flow:fixes-applied", {
      durationMs: fixStepResult.durationMs,
      appliedCount: fixResult.appliedCount,
      fixes: fixResult.archive.fixes.length,
    });

    const saveStepResult = await withTiming(() =>
      saveArchive(fixResult.archive),
    );
    logInfo("flow:archive-saved", {
      durationMs: saveStepResult.durationMs,
      pageKey: fixResult.archive.page_key,
    });

    // Persist pattern archive (fire-and-forget — must not block or break main flow)
    const sig = extractHtmlSignature(pageContext.truncatedHtml);
    void upsertPatternArchive(activePageKey, sig, fixResult.archive.fixes, detectionResult).then(() => {
      const urlShape = deriveUrlShape(activePageKey);
      recordPatternUpsertSuccess(`Pattern archive stored for ${urlShape}`);
      logInfo("flow:pattern-archive-upserted", { urlShape });
    }).catch((error: unknown) => {
      logError("flow:pattern-archive-upsert-failed", error);
    });

    setState("finished");
    flushVerification("finished");
    logInfo("flow:finished");
  } catch (error) {
    logError("flow:failed", error);
    const prefix = hasConfiguredDetectionProvider()
      ? "Fixing failed."
      : `Configure ${getActiveProviderName()} in src/config.ts/.env first.`;
    const message = error instanceof Error ? error.message : String(error);
    setState("initial", `${prefix} ${message}`);
    flushVerification("initial");
  }
}

async function bootstrap(): Promise<void> {
  logInfo("bootstrap:start");
  try {
    const tabResult = await withTiming(getActiveTab);
    logInfo("bootstrap:active-tab-ready", { durationMs: tabResult.durationMs });
    beginVerification(activePageKey);

    // Layer 1: exact page-key cache (fast, no content script needed)
    const exactReused = await maybeApplySavedArchive();
    if (exactReused) return;

    // Layer 2: pattern-level cache (requires page context from content script)
    try {
      const ctxResult = await withTiming(() =>
        sendMessage<PageContext>({ type: "COLLECT_PAGE_CONTEXT" }),
      );
      cachedPageContext = ctxResult.value;
      logInfo("bootstrap:page-context-cached", {
        durationMs: ctxResult.durationMs,
        truncatedHtmlLength: cachedPageContext.truncatedHtml.length,
      });

      const patternReused = await maybeApplyPatternArchive(cachedPageContext);
      if (patternReused) return;
    } catch (error) {
      // Pattern matching is non-critical — log and fall through to manual start
      recordPatternLayerSkipped(error instanceof Error ? error.message : String(error));
      logInfo("bootstrap:pattern-match-skipped", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    setState("initial");
    flushVerification("initial");
    logInfo("bootstrap:ready-for-start");
  } catch (error) {
    logError("bootstrap:failed", error);
    const message = error instanceof Error ? error.message : String(error);
    setState("initial", message);
    flushVerification("initial");
  }
}

void bootstrap();
resetButton.onclick = () => void resetCache();
