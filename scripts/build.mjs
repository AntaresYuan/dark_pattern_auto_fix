import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const sourceDir = path.join(rootDir, "src");
const envFilePath = path.join(rootDir, ".env");

const entries = {
  popup: path.join(sourceDir, "popup/main.ts"),
  content: path.join(sourceDir, "content/index.ts"),
  background: path.join(sourceDir, "background/index.ts")
};

function parseDotenv(sourceText) {
  const values = {};

  sourceText.split(/\r?\n/).forEach((line) => {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) {
      return;
    }

    const separatorIndex = trimmedLine.indexOf("=");
    if (separatorIndex === -1) {
      return;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    let value = trimmedLine.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  });

  return values;
}

function loadBuildEnv() {
  const fileValues = existsSync(envFilePath)
    ? parseDotenv(readFileSync(envFilePath, "utf8"))
    : {};

  return {
    GPT_API_KEY: process.env.GPT_API_KEY ?? fileValues.GPT_API_KEY ?? "",
    GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? fileValues.GEMINI_API_KEY ?? ""
  };
}

const buildEnv = loadBuildEnv();

function normalizeModuleId(filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) {
    throw new Error(`Only relative imports are supported in this prototype build. Found "${specifier}" in ${fromFile}`);
  }

  const basePath = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    `${basePath}.ts`,
    `${basePath}.js`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.js")
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Could not resolve "${specifier}" from ${fromFile}`);
}

function transpileModule(filePath, sourceText) {
  return ts.transpileModule(sourceText, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022
    },
    fileName: filePath
  }).outputText;
}

function bundleEntry(entryFile) {
  const visited = new Map();

  function visit(filePath) {
    const normalizedPath = path.resolve(filePath);
    if (visited.has(normalizedPath)) {
      return;
    }

    let sourceText = readFileSync(normalizedPath, "utf8");
    if (normalizedPath === path.join(sourceDir, "config.ts")) {
      sourceText = sourceText.replace(/"__GPT_API_KEY__"/g, JSON.stringify(buildEnv.GPT_API_KEY));
      sourceText = sourceText.replace(/"__GEMINI_API_KEY__"/g, JSON.stringify(buildEnv.GEMINI_API_KEY));
    }
    const transpiled = transpileModule(normalizedPath, sourceText);
    const dependencies = [];

    const rewrittenCode = transpiled.replace(/require\("([^"]+)"\)/g, (_match, specifier) => {
      if (!specifier.startsWith(".")) {
        return `require("${specifier}")`;
      }

      const resolved = resolveImport(normalizedPath, specifier);
      dependencies.push(resolved);
      return `require("${normalizeModuleId(resolved)}")`;
    });

    visited.set(normalizedPath, rewrittenCode);
    dependencies.forEach(visit);
  }

  visit(entryFile);

  const moduleDefinitions = Array.from(visited.entries())
    .map(([filePath, code]) => {
      const moduleId = normalizeModuleId(filePath);
      return `"${moduleId}": function(module, exports, require) {\n${code}\n}`;
    })
    .join(",\n");

  return `(function() {
const modules = {
${moduleDefinitions}
};
const cache = {};
function require(moduleId) {
  const cached = cache[moduleId];
  if (cached) {
    return cached.exports;
  }
  const module = { exports: {} };
  cache[moduleId] = module;
  const factory = modules[moduleId];
  if (!factory) {
    throw new Error("Missing bundled module: " + moduleId);
  }
  factory(module, module.exports, require);
  return module.exports;
}
require("${normalizeModuleId(entryFile)}");
})();\n`;
}

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

writeFileSync(path.join(distDir, "popup.js"), bundleEntry(entries.popup), "utf8");
writeFileSync(path.join(distDir, "content.js"), bundleEntry(entries.content), "utf8");
writeFileSync(path.join(distDir, "background.js"), bundleEntry(entries.background), "utf8");

cpSync(path.join(rootDir, "src/popup/index.html"), path.join(distDir, "popup.html"));
cpSync(path.join(rootDir, "src/popup/styles.css"), path.join(distDir, "styles.css"));

const manifest = {
  manifest_version: 3,
  name: "Dark Pattern Fixer",
  version: "0.1.0",
  description: "Detect obvious dark patterns, apply default visual fixes, and reuse them on future visits.",
  permissions: ["activeTab", "scripting", "storage", "tabs", "sidePanel"],
  host_permissions: [
    "<all_urls>",
    "https://api.openai.com/*",
    "https://generativelanguage.googleapis.com/*"
  ],
  action: {
    default_title: "Dark Pattern Fixer"
  },
  side_panel: {
    default_path: "popup.html"
  },
  background: {
    service_worker: "background.js"
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["content.js"],
      run_at: "document_idle"
    }
  ]
};

writeFileSync(path.join(distDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
