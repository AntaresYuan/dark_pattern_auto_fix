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
import { findBestPatternMatch, upsertPatternArchive, type UpsertOutcome } from "../shared/patternStorage";
import { normalizeError } from "../shared/utils";
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
  HtmlDebugPayload,
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
const downloadHtmlButton = document.getElementById(
  "download-html-button",
) as HTMLButtonElement;
const downloadScreenshotButton = document.getElementById(
  "download-screenshot-button",
) as HTMLButtonElement;
const downloadLlmInputButton = document.getElementById(
  "download-llm-input-button",
) as HTMLButtonElement;
const actionButton = document.getElementById(
  "action-button",
) as HTMLButtonElement;

let activeTabId: number | null = null;
let activeWindowId: number | null = null;
let activePageKey = "";
let activeTabUrl = "";
/** Cached page context from bootstrap's pattern-matching probe — reused in startFixFlow */
let cachedPageContext: PageContext | null = null;
let lastRawScreenshotDataUrl: string | null = null;
let lastScreenshotDataUrl: string | null = null;
let tabUpdateListenerAttached = false;
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

function logError(
  step: string,
  error: unknown,
  details?: Record<string, unknown>,
): void {
  const normalizedMessage = normalizeError(error);
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
    setState("initial", `Could not clear cache. ${normalizeError(error)}`);
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
  activeTabUrl = tab.url;
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

function resizeDataUrl(dataUrl: string, scale: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("Failed to get canvas context"));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.9));
    };
    img.onerror = () => reject(new Error("Failed to load image for resize"));
    img.src = dataUrl;
  });
}

async function captureScreenshot(): Promise<{ raw: string; resized: string }> {
  if (activeTabId === null) {
    throw new Error("No active tab is available.");
  }

  const tabId = activeTabId;
  const [{ result: dims }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    }),
  });

  const response = await chrome.runtime.sendMessage({
    type: "CAPTURE_FULL_PAGE",
    tabId,
    dims,
  }) as { data?: string; error?: string };
  if (response.error) throw new Error(response.error);

  const raw = `data:image/jpeg;base64,${response.data}`;
  const resized = await resizeDataUrl(raw, Math.sqrt(1 / 8));
  logInfo("screenshot:captured", {
    rawLength: raw.length,
    resizedLength: resized.length,
    scaleFactor: Number(Math.sqrt(1 / 8).toFixed(4)),
  });
  return { raw, resized };
}

async function maybeApplySavedArchive(): Promise<boolean> {
  logInfo("layer-1:checking", { pageKey: activePageKey });
  console.info(`${POPUP_LOG_PREFIX} Layer 1 (exact URL cache) — looking up "${activePageKey}"`);
  const archive = await loadArchive(activePageKey);
  if (!archive) {
    recordExactLayer("MISS");
    console.info(`${POPUP_LOG_PREFIX} Layer 1 → MISS — no exact match stored, proceeding to Layer 2`);
    logInfo("archive:miss", { pageKey: activePageKey });
    return false;
  }

  if (archive.fixes.length === 0) {
    // Negative cache: we previously ran on this exact URL but produced no actionable fixes.
    // Treat as a HIT to avoid repeatedly calling the LLM on the same page.
    recordExactLayer("HIT", 0);
    console.info(
      `${POPUP_LOG_PREFIX} Layer 1 → HIT (negative cache) — 0 fix(es) stored for this exact URL, skipping LLM`,
    );
    logInfo("archive:hit", { pageKey: activePageKey, fixes: 0, negative: true });
    setState("initial", "Cached: no fixable patterns were found on this exact page previously.");
    flushVerification("initial");
    return true;
  }

  recordExactLayer("HIT", archive.fixes.length);
  console.info(`${POPUP_LOG_PREFIX} Layer 1 → HIT — found ${archive.fixes.length} fix(es) for this exact URL, skipping LLM`);
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

  console.info(`${POPUP_LOG_PREFIX} Layer 2 (pattern cache) — URL shape: "${urlShape}"`);
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
    console.info(`${POPUP_LOG_PREFIX} Layer 2 → MISS — no pattern matched, will run LLM detection`);
    logInfo("pattern:miss", { urlShape });
    return false;
  }

  const fixCount = match.archive.fixes.length;
  recordPatternLayerHit({
    urlShape,
    candidateCount: match.candidateCount,
    fixes: fixCount,
    scoreBreakdown: match.scoreBreakdown,
  });
  logInfo("pattern:hit", {
    urlShape,
    score: Number(match.score.toFixed(3)),
    matchPath: match.scoreBreakdown.matchPath,
    urlConsistencyScore: match.scoreBreakdown.urlConsistencyScore != null
      ? Number(match.scoreBreakdown.urlConsistencyScore.toFixed(3))
      : undefined,
    fixes: fixCount,
    hitCount: match.archive.hitCount,
  });

  if (fixCount === 0) {
    console.info(`${POPUP_LOG_PREFIX} Layer 2 → HIT (negative cache) — 0 fix(es) stored for this pattern, skipping LLM`);
    setState("initial", "Cached: no fixable patterns were found on similar pages previously.");
    flushVerification("initial");
    return true;
  }

  console.info(`${POPUP_LOG_PREFIX} Layer 2 → HIT — applying ${fixCount} fix(es), skipping LLM`);
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

async function runDetection(
  pageContext: PageContext,
  screenshotDataUrl: string,
): Promise<DetectionResult> {
  const prompt = buildDarkPatternPrompt({
    truncatedHtml: pageContext.truncatedHtml,
    pageUrl: activeTabUrl,
  });

  const htmlChars = pageContext.truncatedHtml.length;
  const screenshotChars = screenshotDataUrl.length;
  const totalPromptChars = prompt.length + screenshotChars;
  const screenshotPct = ((screenshotChars / totalPromptChars) * 100).toFixed(1);
  const htmlPct = ((htmlChars / totalPromptChars) * 100).toFixed(1);
  // Rough token estimate: ~4 chars per token
  const estimatedTotalTokens = Math.round(totalPromptChars / 4);
  const estimatedHtmlTokens = Math.round(htmlChars / 4);
  const estimatedScreenshotTokens = Math.round(screenshotChars / 4);
  console.info(`${POPUP_LOG_PREFIX} detection:input-token-breakdown`, {
    totalPromptChars,
    estimatedTotalTokens,
    html: {
      chars: htmlChars,
      estimatedTokens: estimatedHtmlTokens,
      pct: `${htmlPct}%`,
    },
    screenshot: {
      chars: screenshotChars,
      estimatedTokens: estimatedScreenshotTokens,
      pct: `${screenshotPct}%`,
    },
  });

  const result = await detectDarkPatterns({ prompt, screenshotDataUrl });
  logInfo("detection:response", {
    patterns: result.identified_dark_patterns.length,
  });
  return result;
}

async function startFixFlow(): Promise<void> {
  logInfo("flow:start");
  try {
    setState("fixing");

    // Re-check caches on every run (not only during bootstrap).
    // This makes repeated "Start" clicks reuse Layer 1/2 instead of re-running the LLM.
    // Layer 1: exact page-key cache (fast, no content script needed)
    const exactReused = await maybeApplySavedArchive();
    if (exactReused) return;

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

    // Layer 2: pattern-level cache (requires page context from content script)
    const patternReused = await maybeApplyPatternArchive(pageContext);
    if (patternReused) return;

    const screenshotResult = await withTiming(captureScreenshot);
    const { raw: rawScreenshot, resized: screenshotDataUrl } = screenshotResult.value;
    lastRawScreenshotDataUrl = rawScreenshot;
    lastScreenshotDataUrl = screenshotDataUrl;
    downloadScreenshotButton.disabled = false;
    downloadLlmInputButton.disabled = false;
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
    void upsertPatternArchive(activePageKey, sig, fixResult.archive.fixes, detectionResult).then((outcome: UpsertOutcome) => {
      const urlShape = deriveUrlShape(activePageKey);
      if (outcome.wrote) {
        recordPatternUpsertSuccess(`Pattern archive ${outcome.action} for ${urlShape} (${outcome.fixCount} fix(es))`);
        logInfo("flow:pattern-archive-upserted", { urlShape, action: outcome.action, fixCount: outcome.fixCount });
      } else {
        logInfo("flow:pattern-archive-skipped", { urlShape, reason: outcome.reason });
      }
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
    setState("initial", `${prefix} ${normalizeError(error)}`);
    flushVerification("initial");
  }
}

function attachTabUpdateListener(): void {
  if (tabUpdateListenerAttached) return;
  tabUpdateListenerAttached = true;

  // Full page navigations
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId !== activeTabId || changeInfo.status !== "complete") return;
    logInfo("tab:navigated", { tabId, url: changeInfo.url });
    cachedPageContext = null;
    void bootstrap();
  });

  // SPA navigations (pushState / replaceState)
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.tabId !== activeTabId || details.frameId !== 0) return;
    logInfo("tab:spa-navigated", { tabId: details.tabId, url: details.url });
    cachedPageContext = null;
    void bootstrap();
  });
}

async function bootstrap(): Promise<void> {
  logInfo("bootstrap:start");
  try {
    const tabResult = await withTiming(getActiveTab);
    logInfo("bootstrap:active-tab-ready", { durationMs: tabResult.durationMs });
    attachTabUpdateListener();
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
      recordPatternLayerSkipped(normalizeError(error));
      logInfo("bootstrap:pattern-match-skipped", {
        reason: normalizeError(error),
      });
    }

    setState("initial");
    flushVerification("initial");
    logInfo("bootstrap:ready-for-start");
  } catch (error) {
    logError("bootstrap:failed", error);
    setState("initial", normalizeError(error));
    flushVerification("initial");
  }
}

function downloadHtmlFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function downloadHtmlDebug(): Promise<void> {
  downloadHtmlButton.disabled = true;
  logInfo("download-html:start");
  try {
    const payload = await sendMessage<HtmlDebugPayload>({ type: "COLLECT_HTML_DEBUG" });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    console.log(
      `[html-debug] original: ${payload.rawHtml.length} chars` +
      ` | truncated_new: ${payload.truncatedHtml.length} chars (${(payload.truncatedHtml.length / payload.rawHtml.length * 100).toFixed(1)}% of original)` +
      ` | truncated_old: ${payload.truncatedHtmlOld.length} chars (${(payload.truncatedHtmlOld.length / payload.rawHtml.length * 100).toFixed(1)}% of original)`
    );
    downloadHtmlFile(`raw_${timestamp}.html`, payload.rawHtml);
    downloadHtmlFile(`truncated_new_${timestamp}.html`, payload.truncatedHtml);
    downloadHtmlFile(`truncated_old_${timestamp}.html`, payload.truncatedHtmlOld);
    logInfo("download-html:done");
  } catch (error) {
    logError("download-html:failed", error);
  } finally {
    downloadHtmlButton.disabled = false;
  }
}

function downloadImageFile(filename: string, dataUrl: string): void {
  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = filename;
  anchor.click();
}

function downloadScreenshot(dataUrl: string | null, label: string): void {
  if (!dataUrl) return;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadImageFile(`${label}_${timestamp}.jpg`, dataUrl);
  logInfo(`download-${label}:done`);
}

void bootstrap();
resetButton.onclick = () => void resetCache();
downloadHtmlButton.onclick = () => void downloadHtmlDebug();
downloadScreenshotButton.onclick = () => downloadScreenshot(lastRawScreenshotDataUrl, "raw_screenshot");
downloadLlmInputButton.onclick = () => downloadScreenshot(lastScreenshotDataUrl, "llm_input");
