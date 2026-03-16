# Dark Pattern Fixer

Dark Pattern Fixer is a Chrome Extension Manifest V3 prototype built with TypeScript. It detects a few obvious dark patterns on the active page, applies default CSS-based visual fixes, saves those fixes by `hostname + pathname`, and reuses them on future visits.

## What is included

- MV3 extension scaffold with popup, background worker, and content script
- Popup UI with exactly 3 states: initial, fixing in progress, finished
- OpenAI detection scaffold with structured outputs
- HTML extraction module based on the referenced `htmlExtraction.js` approach
- Automatic CSS fix planning for `color` and `font_size`
- Local storage archive keyed by `page_key`

## First-time flow

1. Open the popup on an `http` or `https` page.
2. The popup computes `page_key` as `hostname + pathname`.
3. If there is no saved archive for that key, the popup shows the initial state.
4. Click `Start`.
5. The extension:
   - captures the current visible tab as a screenshot data URL
   - extracts optimized truncated HTML from the current page
   - sends both to OpenAI with the predefined prompt and JSON schema
   - receives up to 3 dark pattern candidates
   - plans default CSS fixes for supported visual issues
   - injects those fixes into the page
   - saves the resulting fix archive into `chrome.storage.local`

## Returning visit flow

1. Open the popup on the same `hostname + pathname`.
2. If an archive already exists, the popup skips the LLM pipeline.
3. It immediately shows the fixing state, applies the saved CSS fixes, and then shows the finished state.

## How fixes are stored

Each page is stored under a storage key shaped like `page_fix::<page_key>`.

Example archive:

```json
{
  "page_key": "www.example.com/home",
  "fixes": [
    {
      "css_selector": ".promo-card",
      "patch_type": "css",
      "css_rules": {
        "color": "#222222",
        "font-size": "16px"
      },
      "source_dark_pattern_type": "Disguised ad",
      "applied_issues": ["color", "font_size"]
    }
  ]
}
```

## OpenAI configuration

Edit [src/config.ts](/Users/antaresyuan/Downloads/dark_pattern_fix/src/config.ts) or set keys in `.env`.

- Choose the active provider by changing `AI_CONFIG.activeProvider` to `"gpt"` or `"gemini"`.
- For GPT/OpenAI: set `providers.gpt.model` and either `providers.gpt.proxyUrl` or `GPT_API_KEY` in `.env`.
- For Gemini: set `providers.gemini.model` and `GEMINI_API_KEY` in `.env`.
- The build script injects `.env` keys into the extension bundle at build time.

The OpenAI request uses:

- `chat/completions`
- image input via `image_url`
- structured outputs with `response_format.type = "json_schema"`

## Run locally

1. Install dependencies:

```bash
npm install
```

2. Build the extension:

```bash
npm run build
```

3. Open Chrome and go to `chrome://extensions`.
4. Enable `Developer mode`.
5. Click `Load unpacked`.
6. Select the `dist` folder.

## Notes

- The screenshot capture is intentionally best-effort in v1 and uses the visible tab capture path.
- Automatic fixes are only applied for visually fixable cases, mainly disguised ads and false hierarchy.
- Unsupported or uncertain dark patterns can still be detected but may be skipped during fix planning.
- The referenced extractor source was `/Users/antaresyuan/Downloads/SusFix-main/web-compressor/utils/htmlExtraction.js`.
