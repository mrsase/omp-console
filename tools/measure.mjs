#!/usr/bin/env node
/**
 * Collect the numbers `docs/evaluation.md` must report. Read-only, cheap, and
 * safe to run repeatedly:
 *
 *   node tools/measure.mjs            # human summary
 *   node tools/measure.mjs --json     # machine-readable
 *
 * It does not run tests or the app; it reads the built artifacts and source.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, predicate, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (["node_modules", "target", "dist", ".git"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, predicate, out);
    else if (predicate(full)) out.push(full);
  }
  return out;
}

const countLines = (files) =>
  files.reduce((sum, file) => {
    const text = fs.readFileSync(file, "utf8");
    return sum + text.split("\n").filter((line) => line.trim() !== "").length;
  }, 0);

const rust = walk(path.join(ROOT, "crates"), (file) => file.endsWith(".rs"));
const web = walk(path.join(ROOT, "web", "src"), (file) => /\.(ts|tsx|css)$/.test(file));
const tools = walk(path.join(ROOT, "tools"), (file) => file.endsWith(".mjs"));
const rustProd = rust.filter((file) => !file.includes(`${path.sep}tests${path.sep}`));
const webProd = web.filter((file) => !/\.test\.(ts|tsx)$/.test(file));
const webTests = web.filter((file) => /\.test\.(ts|tsx)$/.test(file));

const size = (file) => {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
};
const gzip = (file) => {
  try {
    return zlib.gzipSync(fs.readFileSync(file), { level: 9 }).length;
  } catch {
    return null;
  }
};

const dist = path.join(ROOT, "web", "dist");
const assets = fs.existsSync(dist)
  ? fs.readdirSync(path.join(dist, "assets")).filter((name) => fs.statSync(path.join(dist, "assets", name)).isFile())
  : [];
const assetSizes = assets.map((name) => ({
  name,
  bytes: size(path.join(dist, "assets", name)),
  gzip: gzip(path.join(dist, "assets", name)),
}));
const js = assetSizes.filter((asset) => asset.name.endsWith(".js"));
const css = assetSizes.filter((asset) => asset.name.endsWith(".css"));
const fonts = assetSizes.filter((asset) => asset.name.endsWith(".woff2"));

const binary = ["release", "debug"]
  .map((profile) => path.join(ROOT, "target", profile, "omp-console"))
  .find((candidate) => fs.existsSync(candidate));

const result = {
  generatedAt: new Date().toISOString(),
  rust: {
    files: rust.length,
    productionFiles: rustProd.length,
    lines: countLines(rust),
    productionLines: countLines(rustProd),
  },
  web: {
    files: web.length,
    productionFiles: webProd.length,
    lines: countLines(web),
    productionLines: countLines(webProd),
    testFiles: webTests.length,
    testLines: countLines(webTests),
  },
  tools: { files: tools.length, lines: countLines(tools) },
  bundle: {
    jsBytes: js.reduce((sum, asset) => sum + (asset.bytes ?? 0), 0),
    jsGzipBytes: js.reduce((sum, asset) => sum + (asset.gzip ?? 0), 0),
    cssBytes: css.reduce((sum, asset) => sum + (asset.bytes ?? 0), 0),
    cssGzipBytes: css.reduce((sum, asset) => sum + (asset.gzip ?? 0), 0),
    fontBytes: fonts.reduce((sum, asset) => sum + (asset.bytes ?? 0), 0),
    assets: assetSizes,
  },
  binary: binary ? { path: path.relative(ROOT, binary), bytes: size(binary) } : null,
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  const kb = (bytes) => (bytes === null ? "?" : `${(bytes / 1024).toFixed(1)} KB`);
  console.log(`rust: ${result.rust.lines} lines (${result.rust.productionLines} production, ${result.rust.files} files)`);
  console.log(`web:  ${result.web.lines} lines (${result.web.productionLines} production, ${result.web.files} files, ${result.web.testFiles} test files)`);
  console.log(`tools: ${result.tools.lines} lines (${result.tools.files} files)`);
  console.log(`js:   ${kb(result.bundle.jsBytes)} raw / ${kb(result.bundle.jsGzipBytes)} gzip`);
  console.log(`css:  ${kb(result.bundle.cssBytes)} raw / ${kb(result.bundle.cssGzipBytes)} gzip`);
  console.log(`fonts: ${kb(result.bundle.fontBytes)}`);
  console.log(`binary: ${result.binary ? `${result.binary.path} ${kb(result.binary.bytes)}` : "not built"}`);
}
