import { createTraceId, logEvent } from "../shared/logger";

const backgroundTraceId = createTraceId("background");

logEvent("background", "background.session.start", {
  traceId: backgroundTraceId,
  version: chrome.runtime.getManifest().version
});

chrome.runtime.onInstalled.addListener((details) => {
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
