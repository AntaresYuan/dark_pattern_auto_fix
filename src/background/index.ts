chrome.runtime.onInstalled.addListener(() => {
  console.log("Dark Pattern Fixer installed.");
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
