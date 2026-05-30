import { detectDarkPatterns } from "../providers";
import { BUILD_ID } from "../shared/buildInfo";
import { buildDarkPatternPrompt } from "../shared/prompt";
import { normalizeError } from "../shared/utils";
import type { F1Result } from "../shared/f1";
import type { ExtensionMessage } from "../shared/messages";
import type { DetectionResult, PageContext } from "../shared/types";

const LOG_PREFIX = "[DarkPatternFixer:runner]";

const baseUrlInput = document.getElementById("base-url") as HTMLInputElement;
const startButton = document.getElementById("start-button") as HTMLButtonElement;
const stopButton = document.getElementById("stop-button") as HTMLButtonElement;
const downloadJsonButton = document.getElementById("download-json-button") as HTMLButtonElement;
const downloadCsvButton = document.getElementById("download-csv-button") as HTMLButtonElement;
const buildEl = document.getElementById("runner-build") as HTMLParagraphElement;
const statusEl = document.getElementById("runner-status") as HTMLParagraphElement;
const summaryEl = document.getElementById("runner-summary") as HTMLDivElement;
const resultsEl = document.getElementById("runner-results") as HTMLDivElement;

interface FixtureOutcome {
  slug: string;
  url: string;
  result?: F1Result;
  error?: string;
}

interface BatchReport {
  generatedAt: string;
  base: string;
  fixtureCount: number;
  fixtures: FixtureOutcome[];
  aggregate: {
    scored: number;
    failed: number;
    micro: { tp: number; fp: number; fn: number; precision: number; recall: number; f1: number };
    macro: { precision: number; recall: number; f1: number };
  };
}

let cancelRequested = false;
let lastReport: BatchReport | null = null;

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function fixtureSlugFromUrl(url: string): string {
  const match = url.match(/fixtures\/([a-z0-9-]+)\//i);
  return match ? match[1] : url;
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

function isMissingReceiverError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("Receiving end does not exist") ||
      error.message.includes("Could not establish connection"))
  );
}

async function ensureContentReady(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" } satisfies ExtensionMessage);
    return;
  } catch (error) {
    if (!isMissingReceiverError(error)) throw error;
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  await chrome.tabs.sendMessage(tabId, { type: "PING" } satisfies ExtensionMessage);
}

async function tabMessage<T>(tabId: number, message: ExtensionMessage): Promise<T> {
  await ensureContentReady(tabId);
  return chrome.tabs.sendMessage(tabId, message) as Promise<T>;
}

function navigateAndWait(tabId: number, url: string, timeoutMs = 45000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    function listener(updatedTabId: number, info: chrome.tabs.TabChangeInfo): void {
      if (updatedTabId === tabId && info.status === "complete") finish();
    }
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.update(tabId, { url });
  });
}

async function captureScreenshot(tabId: number): Promise<string> {
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
  const response = (await chrome.runtime.sendMessage({
    type: "CAPTURE_FULL_PAGE",
    tabId,
    dims,
  })) as { data?: string; error?: string };
  if (response.error) throw new Error(response.error);
  const raw = `data:image/jpeg;base64,${response.data}`;
  return resizeDataUrl(raw, Math.sqrt(1 / 8));
}

async function identify(pageContext: PageContext, screenshotDataUrl: string, pageUrl: string): Promise<DetectionResult> {
  const prompt = buildDarkPatternPrompt({ truncatedHtml: pageContext.truncatedHtml, pageUrl });
  return detectDarkPatterns({ prompt, screenshotDataUrl });
}

async function scoreOneFixture(tabId: number, url: string): Promise<F1Result> {
  await navigateAndWait(tabId, url);
  // Settle: let late layout + the auto-injected content script come up.
  await new Promise((r) => setTimeout(r, 900));
  const pageContext = await tabMessage<PageContext>(tabId, { type: "COLLECT_PAGE_CONTEXT" });
  const screenshotDataUrl = await captureScreenshot(tabId);
  const detection = await identify(pageContext, screenshotDataUrl, url);
  const response = await tabMessage<F1Result>(tabId, {
    type: "SCORE_F1",
    patterns: detection.identified_dark_patterns,
  });
  const errorField = (response as unknown as { error?: string }).error;
  if (errorField) throw new Error(errorField);
  return response;
}

async function fetchFixtureUrls(base: string): Promise<string[]> {
  const normalizedBase = base.replace(/\/+$/, "");
  const hubUrl = `${normalizedBase}/hub.html`;
  const response = await fetch(hubUrl);
  if (!response.ok) {
    throw new Error(`Could not fetch ${hubUrl} (HTTP ${response.status}). Is the benchmark being served at this base URL?`);
  }
  const html = await response.text();
  const paths = Array.from(html.matchAll(/fixtures\/[a-z0-9-]+\/[a-z0-9-]+\.html/gi)).map((m) => m[0]);
  const unique = Array.from(new Set(paths));
  if (unique.length === 0) {
    throw new Error(`No fixture links found in ${hubUrl}.`);
  }
  return unique.map((p) => `${normalizedBase}/${p}`);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function buildReport(base: string, outcomes: FixtureOutcome[]): BatchReport {
  const scored = outcomes.filter((o) => o.result);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const o of scored) {
    tp += o.result!.counts.tp;
    fp += o.result!.counts.fp;
    fn += o.result!.counts.fn;
  }
  const microPrecision = safeRatio(tp, tp + fp);
  const microRecall = safeRatio(tp, tp + fn);
  const microF1 = safeRatio(2 * microPrecision * microRecall, microPrecision + microRecall);
  const macroPrecision = safeRatio(scored.reduce((s, o) => s + o.result!.precision, 0), scored.length);
  const macroRecall = safeRatio(scored.reduce((s, o) => s + o.result!.recall, 0), scored.length);
  const macroF1 = safeRatio(scored.reduce((s, o) => s + o.result!.f1, 0), scored.length);
  return {
    generatedAt: new Date().toISOString(),
    base,
    fixtureCount: outcomes.length,
    fixtures: outcomes,
    aggregate: {
      scored: scored.length,
      failed: outcomes.length - scored.length,
      micro: { tp, fp, fn, precision: microPrecision, recall: microRecall, f1: microF1 },
      macro: { precision: macroPrecision, recall: macroRecall, f1: macroF1 },
    },
  };
}

function renderSummary(report: BatchReport): void {
  const { aggregate: a } = report;
  summaryEl.classList.remove("hidden");
  summaryEl.textContent =
    `Scored ${a.scored}/${report.fixtureCount}` +
    (a.failed ? ` (${a.failed} failed)` : "") +
    `\nMICRO  F1 ${a.micro.f1.toFixed(3)}   P ${pct(a.micro.precision)}   R ${pct(a.micro.recall)}   (TP ${a.micro.tp}  FP ${a.micro.fp}  FN ${a.micro.fn})` +
    `\nMACRO  F1 ${a.macro.f1.toFixed(3)}   P ${pct(a.macro.precision)}   R ${pct(a.macro.recall)}   (mean of per-fixture)`;
}

const F1_VERDICT_LABEL: Record<string, string> = {
  tp: "✅ TP",
  wrong_type: "🟡 wrong type",
  fp_counterexample: "❌ FP · counterexample",
  fp_extraneous: "❌ FP · no gt element",
  unlocatable: "⚠️ FP · unlocatable",
  duplicate: "➖ duplicate",
};

function renderResultsTable(outcomes: FixtureOutcome[]): void {
  resultsEl.textContent = "";
  const table = document.createElement("table");
  table.className = "runner-table";
  table.innerHTML =
    "<thead><tr><th>#</th><th>fixture</th><th>TP</th><th>FP</th><th>FN</th><th>wrong</th><th>P</th><th>R</th><th>F1</th><th>status</th></tr></thead>";
  const tbody = document.createElement("tbody");

  outcomes.forEach((o, index) => {
    const tr = document.createElement("tr");
    const cells: string[] = [String(index + 1), o.slug];
    if (o.result) {
      const c = o.result.counts;
      cells.push(
        String(c.tp),
        String(c.fp),
        String(c.fn),
        String(c.wrongType),
        pct(o.result.precision),
        pct(o.result.recall),
        o.result.f1.toFixed(3),
        "ok",
      );
    } else {
      cells.push("–", "–", "–", "–", "–", "–", "–", o.error ? "ERROR" : "…");
    }
    cells.forEach((text, columnIndex) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (columnIndex === 1) td.className = "runner-cell-fixture";
      tr.appendChild(td);
    });
    if (o.error) tr.title = o.error;
    tbody.appendChild(tr);

    // Collapsible per-fixture prediction detail.
    if (o.result) {
      const detailTr = document.createElement("tr");
      const detailTd = document.createElement("td");
      detailTd.colSpan = 10;
      const details = document.createElement("details");
      details.className = "runner-detail";
      const sum = document.createElement("summary");
      sum.textContent = `▸ ${o.slug} — ${o.result.predictions.length} prediction(s), ${o.result.missed.length} missed`;
      details.appendChild(sum);
      o.result.predictions.forEach((p, predictionIndex) => {
        const line = document.createElement("div");
        line.className = "runner-detail-line";
        const verdict = F1_VERDICT_LABEL[p.verdict] ?? p.verdict;
        line.textContent =
          `${predictionIndex + 1}. ${verdict} — "${p.predictedType}"` +
          (p.matchedGtId ? ` → ${p.matchedGtId}` : " → (no gt anchor)") +
          `  |  ${p.htmlEvidence.slice(0, 100)}`;
        details.appendChild(line);
      });
      o.result.missed.forEach((m) => {
        const line = document.createElement("div");
        line.className = "runner-detail-line runner-detail-missed";
        line.textContent = `FN missed: ${m.gt_id} [${m.type}]`;
        details.appendChild(line);
      });
      detailTd.appendChild(details);
      detailTr.appendChild(detailTd);
      tbody.appendChild(detailTr);
    }
  });

  table.appendChild(tbody);
  resultsEl.appendChild(table);
}

function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function toCsv(report: BatchReport): string {
  const header = "fixture,tp,fp,fn,wrong_type,duplicate,unlocatable,precision,recall,f1,status";
  const rows = report.fixtures.map((o) => {
    if (!o.result) return `${o.slug},,,,,,,,,,${o.error ? "ERROR" : "skipped"}`;
    const c = o.result.counts;
    return [
      o.slug,
      c.tp,
      c.fp,
      c.fn,
      c.wrongType,
      c.duplicate,
      c.unlocatable,
      o.result.precision.toFixed(4),
      o.result.recall.toFixed(4),
      o.result.f1.toFixed(4),
      "ok",
    ].join(",");
  });
  return [header, ...rows].join("\n");
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function runBatch(): Promise<void> {
  cancelRequested = false;
  startButton.disabled = true;
  stopButton.disabled = false;
  downloadJsonButton.disabled = true;
  downloadCsvButton.disabled = true;
  summaryEl.classList.add("hidden");
  resultsEl.textContent = "";

  const base = baseUrlInput.value.trim();
  let targetWindowId: number | undefined;

  try {
    setStatus("Fetching fixture list from hub.html…");
    const urls = await fetchFixtureUrls(base);
    setStatus(`Found ${urls.length} fixtures. Opening runner window…`);

    const win = await chrome.windows.create({ url: urls[0], focused: false, width: 1280, height: 900 });
    targetWindowId = win.id;
    const targetTabId = win.tabs?.[0]?.id;
    if (targetTabId == null) throw new Error("Could not open a target tab.");

    const outcomes: FixtureOutcome[] = urls.map((url) => ({ slug: fixtureSlugFromUrl(url), url }));
    renderResultsTable(outcomes);

    for (let i = 0; i < urls.length; i += 1) {
      if (cancelRequested) {
        setStatus(`Stopped after ${i}/${urls.length}.`);
        break;
      }
      const outcome = outcomes[i];
      setStatus(`Running ${i + 1}/${urls.length}: ${outcome.slug}…`);
      try {
        outcome.result = await scoreOneFixture(targetTabId, outcome.url);
        // Stale-code detector: the content script that scored must be this same build.
        if (outcome.result.contentBuildId !== BUILD_ID) {
          buildEl.textContent =
            `⚠️ STALE CONTENT SCRIPT — runner build ${BUILD_ID} but the page is running ${outcome.result.contentBuildId}. ` +
            `Reload the extension at chrome://extensions and close old tabs, then re-run. These numbers are from OLD code.`;
          buildEl.classList.add("runner-build-stale");
        }
        console.info(`${LOG_PREFIX} scored`, outcome.slug, outcome.result.counts, "contentBuild", outcome.result.contentBuildId);
      } catch (error) {
        outcome.error = normalizeError(error);
        console.error(`${LOG_PREFIX} failed`, outcome.slug, outcome.error);
      }
      const report = buildReport(base, outcomes);
      lastReport = report;
      renderResultsTable(outcomes);
      renderSummary(report);
    }

    lastReport = buildReport(base, outcomes);
    renderSummary(lastReport);
    const done = cancelRequested ? "Stopped" : "Done";
    setStatus(`${done}. Scored ${lastReport.aggregate.scored}/${urls.length}, ${lastReport.aggregate.failed} failed.`);
    downloadJsonButton.disabled = false;
    downloadCsvButton.disabled = false;
  } catch (error) {
    setStatus(`Batch failed: ${normalizeError(error)}`);
    console.error(`${LOG_PREFIX} batch failed`, error);
  } finally {
    if (targetWindowId != null) {
      void chrome.windows.remove(targetWindowId).catch(() => undefined);
    }
    startButton.disabled = false;
    stopButton.disabled = true;
  }
}

buildEl.textContent = `runner build: ${BUILD_ID}`;
startButton.onclick = () => void runBatch();
stopButton.onclick = () => {
  cancelRequested = true;
  setStatus("Stopping after the current fixture…");
};
downloadJsonButton.onclick = () => {
  if (lastReport) download(`f1-batch-${timestamp()}.json`, JSON.stringify(lastReport, null, 2), "application/json");
};
downloadCsvButton.onclick = () => {
  if (lastReport) download(`f1-batch-${timestamp()}.csv`, toCsv(lastReport), "text/csv");
};
