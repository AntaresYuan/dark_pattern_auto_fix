import { detectDarkPatterns, getActiveProviderName, hasConfiguredDetectionProvider } from "../providers";
import { DARK_PATTERN_FACTS } from "../shared/facts";
import { getPageKeyFromUrl, isSupportedPageUrl } from "../shared/pageKey";
import { buildDarkPatternPrompt } from "../shared/prompt";
import { loadArchive, saveArchive } from "../shared/storage";
import type { ExtensionMessage, ExtensionMessageResponse } from "../shared/messages";
import type { DetectionResult, FixApplicationResult, PageContext } from "../shared/types";

type PopupState = "initial" | "fixing" | "finished";

const bodyCopy = document.getElementById("body-copy") as HTMLParagraphElement;
const factCard = document.getElementById("fact-card") as HTMLElement;
const factCopy = document.getElementById("fact-copy") as HTMLParagraphElement;
const actionButton = document.getElementById("action-button") as HTMLButtonElement;

let activeTabId: number | null = null;
let activeWindowId: number | null = null;
let activePageKey = "";
let factTimer: number | null = null;
let currentFactIndex = 0;

function setState(state: PopupState, errorMessage = ""): void {
  clearFactRotator();

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
    return;
  } catch (error) {
    if (!isMissingReceiverError(error)) {
      throw error;
    }
  }

  await chrome.scripting.executeScript({
    target: { tabId: activeTabId },
    files: ["content.js"]
  });

  await chrome.tabs.sendMessage(activeTabId, { type: "PING" } satisfies ExtensionMessage);
}

async function sendMessage<T extends ExtensionMessageResponse>(message: ExtensionMessage): Promise<T> {
  if (!activeTabId) {
    throw new Error("No active tab is available.");
  }

  await ensureContentScriptReady();
  return chrome.tabs.sendMessage(activeTabId, message) as Promise<T>;
}

async function captureScreenshot(): Promise<string> {
  if (activeWindowId === null) {
    throw new Error("No active window is available.");
  }

  return chrome.tabs.captureVisibleTab(activeWindowId, {
    format: "jpeg",
    quality: 70
  });
}

async function maybeApplySavedArchive(): Promise<boolean> {
  const archive = await loadArchive(activePageKey);
  if (!archive || archive.fixes.length === 0) {
    return false;
  }

  setState("fixing");
  await sendMessage<FixApplicationResult>({
    type: "APPLY_SAVED_FIXES",
    archive
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

  return detectDarkPatterns({
    prompt,
    screenshotDataUrl
  });
}

async function startFixFlow(): Promise<void> {
  try {
    setState("fixing");

    const pageContext = await sendMessage<PageContext>({
      type: "COLLECT_PAGE_CONTEXT"
    });
    const screenshotDataUrl = await captureScreenshot();
    const detectionResult = await runDetection(pageContext, screenshotDataUrl);
    const fixResult = await sendMessage<FixApplicationResult>({
      type: "PLAN_AND_APPLY_FIXES",
      patterns: detectionResult.identified_dark_patterns
    });

    await saveArchive(fixResult.archive);
    setState("finished");
  } catch (error) {
    const prefix = hasConfiguredDetectionProvider()
      ? "Fixing failed."
      : `Configure ${getActiveProviderName()} in src/config.ts/.env first.`;
    const message = error instanceof Error ? error.message : String(error);
    setState("initial", `${prefix} ${message}`);
  }
}

async function bootstrap(): Promise<void> {
  try {
    await getActiveTab();
    const reused = await maybeApplySavedArchive();
    if (!reused) {
      setState("initial");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setState("initial", message);
  }
}

void bootstrap();
