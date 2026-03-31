import type { ExtensionMessage } from "./messages";
import type { DetectionResult, PageFix, PageFixArchive } from "./types";

export type LogScope = "background" | "content" | "popup" | "provider" | "storage" | "prompt";
export type LogLevel = "debug" | "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

interface StepTimer {
  fail: (error: unknown, fields?: LogFields, level?: LogLevel) => void;
  finish: (fields?: LogFields, level?: LogLevel) => void;
}

function getNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function getDurationMs(startedAt: number): number {
  return Math.round(getNow() - startedAt);
}

function getConsoleMethod(level: LogLevel): (...args: unknown[]) => void {
  switch (level) {
    case "debug":
      return console.debug.bind(console);
    case "warn":
      return console.warn.bind(console);
    case "error":
      return console.error.bind(console);
    default:
      return console.log.bind(console);
  }
}

function formatCount(value: unknown): string {
  return typeof value === "number" ? value.toLocaleString() : String(value ?? "0");
}

function formatPage(fields: LogFields): string {
  return fields.pageKey ? ` on ${String(fields.pageKey)}` : "";
}

function formatProvider(fields: LogFields): string {
  if (typeof fields.provider === "string") {
    return fields.provider;
  }

  if (typeof fields.activeProvider === "string") {
    return fields.activeProvider;
  }

  return "provider";
}

function getHumanSummary(scope: LogScope, event: string, fields: LogFields): string {
  switch (event) {
    case "popup.fixFlow.start":
      return `Started fix flow${formatPage(fields)} using ${formatProvider(fields)}`;
    case "popup.fixFlow.finish":
      return `Finished fix flow${formatPage(fields)}: applied ${formatCount(fields.appliedCount)} fixes`;
    case "popup.fixFlow.error":
      return `Fix flow failed${formatPage(fields)}: ${String(fields.errorMessage ?? "unknown error")}`;
    case "popup.savedArchive.check.finish":
      return fields.cacheHit
        ? `Found saved fixes${formatPage(fields)}: ${formatCount(fields.fixCount)} fixes`
        : `No saved fixes found${formatPage(fields)}`;
    case "popup.savedArchive.applied":
      return `Reused saved fixes${formatPage(fields)}: applied ${formatCount(fields.appliedCount)} fixes`;
    case "popup.bootstrap.finish":
      return fields.reused
        ? `Popup ready${formatPage(fields)} with saved fixes reused`
        : `Popup ready${formatPage(fields)}`;
    case "popup.bootstrap.error":
      return `Popup bootstrap failed: ${String(fields.errorMessage ?? "unknown error")}`;
    case "popup.state.transition":
      return `Popup state changed to ${String(fields.state)}`;
    case "popup.popup.trace":
      return `Step ${formatCount(fields.stepIndex)} ${String(fields.status ?? "info").toUpperCase()} | ${String(fields.label ?? "Trace")} | ${String(fields.detail ?? "")}`;
    case "prompt.build.finish":
      return `Built detection prompt${formatPage(fields)} (${formatCount(fields.promptLength)} chars)`;
    case "provider.detectDarkPatterns.start":
      return `Running ${formatProvider(fields)} detection${formatPage(fields)}`;
    case "provider.detectDarkPatterns.finish":
      return `${formatProvider(fields)} detection finished${formatPage(fields)}: ${formatCount(fields.patternCount)} patterns`;
    case "provider.detectDarkPatterns.error":
      return `${formatProvider(fields)} detection failed${formatPage(fields)}: ${String(fields.errorMessage ?? "unknown error")}`;
    case "provider.openai.detect.finish":
      return `OpenAI request finished${formatPage(fields)}: ${formatCount(fields.patternCount)} patterns`;
    case "provider.openai.detect.error":
      return `OpenAI request failed${formatPage(fields)}: ${String(fields.errorMessage ?? "unknown error")}`;
    case "provider.gemini.detect.finish":
      return `Gemini request finished${formatPage(fields)}: ${formatCount(fields.patternCount)} patterns`;
    case "provider.gemini.detect.error":
      return `Gemini request failed${formatPage(fields)}: ${String(fields.errorMessage ?? "unknown error")}`;
    case "content.fix.plan.start":
      return `Planning fixes${formatPage(fields)} for ${formatCount(fields.patternCount)} patterns`;
    case "content.fix.plan.finish":
      return `Finished planning${formatPage(fields)}: ${formatCount(fields.fixCount)} fixes, ${formatCount(fields.appliedCount)} applied`;
    case "content.fix.pattern.generate":
      return `${String(fields.darkPatternType)}: generated fix for ${String(fields.sourceSelector ?? "target")}`;
    case "content.fix.pattern.skip":
      return `${String(fields.darkPatternType)}: skipped (${String(fields.outcome ?? "no reason")})`;
    case "content.fix.pattern.ad_label.create":
      return `Created advertisement label fix for ${String(fields.sourceSelector ?? "target")}`;
    case "content.fix.pattern.ad_label.enhance":
      return `Enhanced advertisement label for ${String(fields.sourceSelector ?? "target")}`;
    case "content.patch.apply.start":
      return `Applying ${formatCount(fields.totalFixes)} fixes${formatPage(fields)}`;
    case "content.patch.apply.finish":
      return `Applied fixes${formatPage(fields)}: ${formatCount(fields.appliedCount)} total (${formatCount(fields.appliedCssCount)} CSS, ${formatCount(fields.appliedAdLabelCount)} labels)`;
    case "content.patch.apply.label":
      return `Advertisement label ${String(fields.outcome ?? "processed")} for ${String(fields.selector ?? "target")}`;
    case "content.context.collect.finish":
      return `Collected page context${formatPage(fields)} (${formatCount(fields.truncatedHtmlLength)} HTML chars)`;
    case "content.html.extract.finish":
      return `Extracted HTML${formatPage(fields)} with mode ${String(fields.mode)} (${formatCount(fields.finalHtmlLength ?? fields.fallbackLength ?? fields.compressedHtmlLength)} chars)`;
    case "storage.archive.load.finish":
      return fields.hit
        ? `Loaded saved archive${formatPage(fields)} with ${formatCount(fields.fixCount)} fixes`
        : `No saved archive${formatPage(fields)}`;
    case "storage.archive.save.finish":
      return `Saved archive${formatPage(fields)} with ${formatCount(fields.fixCount)} fixes`;
    case "background.background.runtime.installed":
      return `Extension installed/updated to ${String(fields.version ?? "unknown version")}`;
    case "background.background.runtime.startup":
      return `Background service worker started`;
    case "background.background.session.start":
      return `Background session started`;
    default:
      return `${scope}.${event}`;
  }
}

function getEffectiveLevel(event: string, level: LogLevel, fields: LogFields): LogLevel {
  if (level !== "info") {
    return level;
  }

  const importantStarts = new Set([
    "popup.fixFlow.start",
    "provider.detectDarkPatterns.start",
    "content.fix.plan.start",
    "content.patch.apply.start"
  ]);
  const quietEvents = new Set([
    "content.message.handle.start",
    "content.message.handle.finish",
    "content.context.collect.start",
    "content.context.collect.finish",
    "content.html.extract.start",
    "content.html.extract.finish",
    "popup.message.start",
    "popup.message.finish",
    "popup.getActiveTab.start",
    "popup.getActiveTab.finish",
    "popup.contentScript.ensureReady.start",
    "popup.contentScript.ensureReady.finish",
    "popup.contentScript.inject.start",
    "popup.contentScript.inject.finish",
    "popup.captureScreenshot.start",
    "popup.captureScreenshot.finish",
    "provider.config.check",
    "provider.gemini.parseScreenshot.start",
    "provider.gemini.parseScreenshot.finish"
  ]);

  if (quietEvents.has(event)) {
    return "debug";
  }

  if (fields.messageType === "PING") {
    return "debug";
  }

  if (event.endsWith(".start") && !importantStarts.has(event)) {
    return "debug";
  }

  return level;
}

export function createTraceId(prefix = "run"): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function truncateText(value: string, maxLength = 240): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...[truncated]`;
}

export function safeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return truncateText(rawUrl);
  }
}

export function summarizeDataUrl(dataUrl: string): {
  hasDataUrl: boolean;
  mimeType: string | null;
  dataLength: number;
  totalLength: number;
} {
  const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);

  return {
    hasDataUrl: Boolean(match),
    mimeType: match?.[1] ?? null,
    dataLength: match?.[2]?.length ?? 0,
    totalLength: dataUrl.length
  };
}

export function safeError(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: truncateText(error.stack ?? "", 400)
    };
  }

  return {
    errorMessage: typeof error === "string" ? error : safeStringify(error)
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function summarizeFix(fix: PageFix): LogFields {
  return {
    selector: truncateText(fix.css_selector, 120),
    patchType: fix.patch_type,
    sourceType: fix.source_dark_pattern_type,
    issues: fix.applied_issues
  };
}

export function summarizeFixes(fixes: PageFix[]): LogFields {
  return {
    fixCount: fixes.length,
    cssFixCount: fixes.filter((fix) => fix.patch_type === "css").length,
    adLabelFixCount: fixes.filter((fix) => fix.patch_type === "advertisement_label").length,
    fixes: fixes.slice(0, 5).map(summarizeFix)
  };
}

export function summarizeArchive(archive: PageFixArchive): LogFields {
  return {
    pageKey: archive.page_key,
    ...summarizeFixes(archive.fixes)
  };
}

export function summarizeDetectionResult(result: DetectionResult): LogFields {
  return {
    patternCount: result.identified_dark_patterns.length,
    patterns: result.identified_dark_patterns.slice(0, 5).map((pattern) => ({
      type: pattern.dark_pattern_type,
      selector: truncateText(pattern.css_selector, 120),
      issues: pattern.issues
    }))
  };
}

export function summarizeMessage(message: ExtensionMessage): LogFields {
  switch (message.type) {
    case "PLAN_AND_APPLY_FIXES":
      return {
        messageType: message.type,
        traceId: message.meta?.traceId,
        pageKey: message.meta?.pageKey,
        patternCount: message.patterns.length
      };
    case "APPLY_SAVED_FIXES":
      return {
        messageType: message.type,
        traceId: message.meta?.traceId,
        pageKey: message.meta?.pageKey,
        ...summarizeArchive(message.archive)
      };
    default:
      return {
        messageType: message.type,
        traceId: message.meta?.traceId,
        pageKey: message.meta?.pageKey
      };
  }
}

export function logEvent(scope: LogScope, event: string, fields: LogFields = {}, level: LogLevel = "info"): void {
  const effectiveLevel = getEffectiveLevel(`${scope}.${event}`, level, fields);
  const method = getConsoleMethod(effectiveLevel);
  method(`[DarkPatternFixer][${scope}] ${getHumanSummary(scope, `${scope}.${event}`, fields)}`, {
    event,
    timestamp: new Date().toISOString(),
    ...fields
  });
}

export function startStep(scope: LogScope, event: string, fields: LogFields = {}, level: LogLevel = "info"): StepTimer {
  const startedAt = getNow();
  logEvent(scope, `${event}.start`, fields, level);

  return {
    finish(extraFields: LogFields = {}, finishLevel = level) {
      logEvent(scope, `${event}.finish`, {
        ...fields,
        ...extraFields,
        durationMs: getDurationMs(startedAt),
        ok: true
      }, finishLevel);
    },
    fail(error: unknown, extraFields: LogFields = {}, finishLevel: LogLevel = "error") {
      logEvent(scope, `${event}.error`, {
        ...fields,
        ...extraFields,
        durationMs: getDurationMs(startedAt),
        ok: false,
        ...safeError(error)
      }, finishLevel);
    }
  };
}
