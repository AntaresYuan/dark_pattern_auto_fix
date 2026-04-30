import { createTraceId, logEvent } from "../shared/logger";

const backgroundTraceId = createTraceId("background");

logEvent("background", "background.session.start", {
  traceId: backgroundTraceId,
  version: chrome.runtime.getManifest().version
});

chrome.runtime.onInstalled.addListener((details) => {
  console.log("Dark Pattern Fixer installed.");
  logEvent("background", "background.runtime.installed", {
    traceId: backgroundTraceId,
    reason: details.reason,
    previousVersion: details.previousVersion ?? null,
    version: chrome.runtime.getManifest().version
  });
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(() => {
  logEvent("background", "background.runtime.startup", {
    traceId: backgroundTraceId,
    version: chrome.runtime.getManifest().version
  });
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "CAPTURE_FULL_PAGE") return false;

  const tabId = message.tabId as number;
  const dims = message.dims as {
    scrollWidth: number; scrollHeight: number;
    viewportWidth: number; viewportHeight: number;
    devicePixelRatio: number;
  };
  (async () => {
    await chrome.debugger.attach({ tabId }, "1.3");
    try {
      const captureHeight = Math.min(dims.scrollHeight, 16000);
      // Only override width to keep consistent rendering; do NOT change height
      // since changing viewport height causes pages with vh/% units to reflow,
      // resulting in repeated viewport content filling the extended height.
      await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
        width: dims.viewportWidth,
        height: dims.viewportHeight,
        deviceScaleFactor: dims.devicePixelRatio,
        mobile: false,
      });
      await new Promise(r => setTimeout(r, 300));
      const result = await chrome.debugger.sendCommand(
        { tabId },
        "Page.captureScreenshot",
        {
          format: "jpeg",
          quality: 90,
          captureBeyondViewport: true,
          clip: {
            x: 0,
            y: 0,
            width: dims.scrollWidth,
            height: captureHeight,
            scale: 1,
          },
        }
      ) as { data: string };
      sendResponse({ data: result.data });
    } finally {
      await chrome.debugger.sendCommand({ tabId }, "Emulation.clearDeviceMetricsOverride", {})
        .catch(() => undefined);
      await chrome.debugger.detach({ tabId });
    }
  })().catch((error) => {
    sendResponse({ error: error instanceof Error ? error.message : String(error) });
  });

  return true;
});
