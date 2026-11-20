#!/usr/bin/env node
/**
 * Line budget gate: no source file may exceed 600 physical lines.
 *
 * Scope: crates/**\/*.rs, web/src/**\/*.{ts,tsx,css}, tools/*.mjs.
 * Skips any path segment named target, node_modules or dist.
 * Prints `path: N lines (limit 600)` per violation and exits 1 if any exist.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIMIT = 600;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["target", "node_modules", "dist", ".git"]);

function walk(dir, accept, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // missing directory (e.g. web/src before the app exists)
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, accept, out);
    } else if (entry.isFile() && accept(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function physicalLines(file) {
  const text = fs.readFileSync(file, "utf8");
  if (text === "") return 0;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

const files = [];
walk(path.join(ROOT, "crates"), (name) => name.endsWith(".rs"), files);
walk(
  path.join(ROOT, "web", "src"),
  (name) => [".ts", ".tsx", ".css"].some((ext) => name.endsWith(ext)),
  files,
);
const toolsDir = path.join(ROOT, "tools");
let toolNames = [];
try {
  toolNames = fs
    .readdirSync(toolsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .map((entry) => entry.name)
    .sort();
} catch {
  toolNames = [];
}
for (const name of toolNames) files.push(path.join(toolsDir, name));

const violations = [];
for (const file of files) {
  const count = physicalLines(file);
  if (count > LIMIT) violations.push({ file, count });
}

if (violations.length > 0) {
  for (const { file, count } of violations) {
    process.stdout.write(`${path.relative(ROOT, file)}: ${count} lines (limit ${LIMIT})\n`);
  }
  process.stdout.write(
    `\nline budget: ${violations.length} file(s) over ${LIMIT} lines; split them (no exemptions).\n`,
  );
  process.exit(1);
}

process.stdout.write(`line budget: ${files.length} file(s) checked, all within ${LIMIT} lines.\n`);
