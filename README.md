# Dark Pattern Fixer

A Chrome Extension (Manifest V3) that automatically detects dark patterns on web pages and applies CSS-based visual fixes. Built with TypeScript.

---

## What it does

When you open the extension on a web page, it:

1. Checks whether it has seen this page (or a structurally similar page) before.
2. If yes, replays the saved fixes instantly — no LLM call needed.
3. If no, captures a screenshot and the page's HTML, sends both to an LLM (Gemini or GPT), receives a structured list of detected dark patterns, generates DOM-targeted CSS fixes, and saves them for future visits.

---

## Supported dark pattern types

| Type | What it looks like |
|---|---|
| **Disguised ad** | Ad content styled to look like editorial content |
| **False hierarchy** | A preferred action made visually dominant to suppress the other choice |
| **Preselection** | A checkbox or option pre-checked without the user's intent |
| **Pop-up ad** | An interstitial overlay blocking page content |
| **Trick wording** | Ambiguous or double-negative language to confuse the user's choice |
| **Confirm shaming** | A decline option written to make the user feel guilty for saying no |
| **Fake social proof** | Unverified urgency signals ("Only 2 left!", "14 people viewing") |
| **Forced Action** | Requiring unrelated action (e.g. account creation) to access content |
| **Hidden information** | Key terms buried in fine print or collapsed UI |

---

## Fix strategies

The extension applies one of these strategies per detected pattern:

| Issue flag | Fix applied |
|---|---|
| `color` | Infer a visible text color from surrounding elements |
| `font_size` | Match font size to nearby peer elements |
| `background_color` | Infer a non-deceptive background from sibling surfaces |
| `add_advertisement_title` | Insert a bold "ADVERTISEMENT" label above the element |
| `enhance_advertisement_title` | Darken an existing low-contrast "Ad" label to `#000000` |
| No issue flags — popup | Hide the element (`display: none`) |
| No issue flags — text-based | Dim the element (`opacity: 0.5`) |
| No issue flags — visual | Lightly dim the element (`opacity: 0.7`) |

All CSS fixes are injected via a single `<style>` element with `!important` rules, keyed by a stable CSS selector derived from the element's `id`, class tokens, or structural position.

---

## How the caching system works

Running the LLM on every page visit would be slow and expensive. The extension uses a **three-layer cache** to avoid redundant LLM calls:

```
Layer 1 — Exact URL match
  │  Key: hostname + pathname (e.g. "amazon.com/dp/B08N5WRWNW")
  │  Hit: apply saved fixes immediately, skip everything below
  ↓ Miss
Layer 2 — Pattern (structural) match
  │  Key: URL shape (e.g. "amazon.com/dp/{id}") + HTML signature
  │  Scores each stored archive by HTML structure similarity and URL shape consistency
  │  Hit: apply fixes from the best-scoring archive, skip LLM
  ↓ Miss
Layer 3 — LLM detection
     Send screenshot + cleaned HTML to the LLM
     Receive dark pattern list → plan fixes → apply → save to Layer 1 + Layer 2
```

**Layer 2 scoring** combines three signals:
- **HTML signature similarity** — Jaccard similarity over tag histogram tokens, CSS class tokens, and HTML attribute tokens (weights: 20% / 40% / 40%)
- **LLM match features** — Required/optional attributes and fingerprint class tokens extracted by the LLM to describe the site template
- **URL shape consistency** — Jaccard similarity over normalized URL path segments

Scores below a threshold (0.72 for LLM-feature path, 0.60 for signature-only fallback) are rejected and fall through to Layer 3.

---

## Source code structure

```
src/
├── background/
│   └── index.ts          Chrome service worker. Handles privileged APIs only —
│                         specifically the Chrome Debugger API for full-page screenshots.
│                         Runs independently of the popup lifecycle.
│
├── content/
│   ├── index.ts          Entry point injected into the target web page. Listens for
│   │                     messages from the popup and dispatches to the modules below.
│   ├── htmlExtractor.ts  Two exports: extractRawHtml() for debug downloads, and
│   │                     extractCleanedHtml() which strips invisible elements, prunes
│   │                     CSS to active rules only, and collapses whitespace — reducing
│   │                     token count before sending to the LLM.
│   ├── domSelector.ts    Derives a CSS selector from an LLM-provided HTML evidence
│   │                     string, finds the matching element in the live DOM, and builds
│   │                     a stable selector for the fix archive.
│   ├── styleInference.ts Infers safe CSS values (color, background-color, font-size)
│   │                     by inspecting sibling and parent elements. Also resolves which
│   │                     element should actually receive the fix (e.g. a clickable
│   │                     ancestor instead of an inner text node).
│   ├── fixPlanner.ts     Orchestrates fix generation. For each detected dark pattern,
│   │                     uses domSelector + styleInference to build a PageFix object,
│   │                     then calls patchInjector to apply it.
│   └── patchInjector.ts  Applies a list of PageFix objects to the live DOM: CSS fixes
│                         via a single injected <style> element, advertisement label
│                         fixes by inserting a DOM node.
│
├── popup/
│   └── main.ts           The side panel UI. Manages the three UI states (initial /
│                         fixing / finished), orchestrates the full fix flow (cache
│                         check → screenshot → LLM → fix → save), and handles debug
│                         downloads.
│
├── providers/
│   ├── types.ts          Shared provider interface.
│   ├── gemini.ts         Gemini API adapter (multimodal: text + image).
│   ├── openai.ts         OpenAI API adapter (structured outputs with JSON schema).
│   └── index.ts          Exports the active provider based on AI_CONFIG.
│
├── shared/
│   ├── types.ts          All TypeScript types shared across contexts (dark pattern
│   │                     types, fix types, archive types, cache types).
│   ├── messages.ts       Message types for popup ↔ content script communication.
│   ├── schema.ts         JSON schema sent to the LLM to enforce structured output.
│                         Defines the 9 dark pattern types and the issue flag vocabulary.
│   ├── prompt.ts         Builds the LLM prompt from page HTML and URL. Contains the
│   │                     detection instructions and chain-of-thought guidance.
│   ├── patternMatcher.ts Scoring algorithms for Layer 2 cache: HTML signature
│   │                     extraction, Jaccard similarity, LLM feature scoring,
│   │                     and URL shape normalization.
│   ├── patternStorage.ts Layer 2 cache CRUD: load/save/find/upsert pattern archives
│   │                     in chrome.storage.local. Evicts oldest archives per host
│   │                     when the per-host cap (10) is reached.
│   ├── storage.ts        Layer 1 cache: exact-URL archive load/save.
│   ├── pageKey.ts        Derives the page key (hostname + pathname) from a URL.
│   ├── logger.ts         Structured logging utilities used across all contexts.
│   ├── verificationTelemetry.ts  Records cache hit/miss events for debugging.
│   ├── facts.ts          Dark pattern facts displayed in the popup while fixing.
│   └── utils.ts          Shared utility functions.
│
└── config.ts             LLM provider selection and API configuration. Edit this
                          file (or .env) to switch between Gemini and GPT.
```

---

## Configuration

Edit `src/config.ts` to choose a provider and set model names:

```ts
activeProvider: "gemini"  // or "gpt"

providers: {
  gemini: { model: "gemini-2.5-pro", apiKey: "__GEMINI_API_KEY__" },
  gpt:    { model: "gpt-5",          apiKey: "__GPT_API_KEY__",   proxyUrl: "" }
}
```

Set API keys in `.env` (they are injected into the bundle at build time — never hardcode them):

```
GEMINI_API_KEY=your_key_here
GPT_API_KEY=your_key_here
```

For production, use `proxyUrl` for GPT so your API key does not ship inside the extension bundle.

---

## Running locally

```bash
# Install dependencies
npm install

# Build the extension
npm run build
```

Then in Chrome:
1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `dist/` folder

---

## Fix archive format

Fixes are stored in `chrome.storage.local`. Each key is shaped as `page_fix::<page_key>`.

```json
{
  "page_key": "www.example.com/home",
  "fixes": [
    {
      "css_selector": ".promo-card > div:nth-of-type(1)",
      "patch_type": "css",
      "css_rules": { "color": "#222222", "font-size": "16px" },
      "source_dark_pattern_type": "Disguised ad",
      "applied_issues": ["color", "font_size"]
    },
    {
      "css_selector": ".promo-card > div:nth-of-type(1)",
      "patch_type": "advertisement_label",
      "label_text": "ADVERTISEMENT",
      "source_dark_pattern_type": "Disguised ad",
      "applied_issues": ["add_advertisement_title"]
    }
  ]
}
```

---

## Benchmark / eval harness

The benchmark fixture suite (ground-truth labels, scoring harness, fake-site fixtures) lives in a separate repository:

→ [`AntaresYuan/dark-pattern-benchmark`](https://github.com/AntaresYuan/dark-pattern-benchmark)

It contains 6 fake-site fixtures (Amazon PDP, Booking checkout, NYTimes paywall, Netflix cancel flow, Facebook deactivation, PayPal close), a Tranco-sourced candidate site list, per-fixture `ground-truth.json` answer keys, and a Google Sheets sync workflow.

The canonical 9-type dark pattern taxonomy is defined in `src/shared/schema.ts` and mirrored at `schema/dp-types.json` in the benchmark repo. If you rename a type here, update it there too.
