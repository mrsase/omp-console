#!/usr/bin/env node
/**
 * Cycle gates — a gate is a command, not an opinion (docs/CYCLE.md).
 *
 *   node tools/check-cycle.mjs design     required docs, accepted ADRs, A1..A12 proofs, owner approval
 *   node tools/check-cycle.mjs evaluate   docs/evaluation.md with measured numbers and an explicit GO
 *   node tools/check-cycle.mjs ship       release docs, v1.0.0 tag, published GitHub release
 *
 * Prints every missing item and exits 1 if any exist.
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODES = ["design", "evaluate", "ship"];
const ADRS = [
  "docs/adr/0001-protocol-contract.md",
  "docs/adr/0002-architecture.md",
  "docs/adr/0003-ui-identity.md",
];
const FIXTURES = ["handshake", "stream", "dialogs", "resume", "unknown", "commands"].map(
  (name) => `docs/fixtures/${name}.jsonl`,
);
const DESIGN_DOCS = [
  "docs/CYCLE.md",
  "docs/poc-findings.md",
  ...ADRS,
  "docs/DESIGN.md",
  "docs/v1-design.md",
  "docs/fixtures/README.md",
  ...FIXTURES,
];
const APPROVAL_RE = /^Approved by .+ on \d{4}-\d{2}-\d{2}/;

const read = (rel) => {
  try {
    return fs.readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    return null;
  }
};
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

function design() {
  const failures = [];

  for (const rel of DESIGN_DOCS) {
    if (!exists(rel)) failures.push(`missing ${rel}`);
  }

  for (const rel of ADRS) {
    const text = read(rel);
    if (text !== null && !/Status:\*{0,2}\s*Accepted/.test(text)) {
      failures.push(`${rel}: no \`Status: Accepted\` line`);
    }
  }

  const designText = read("docs/v1-design.md");
  if (designText !== null) {
    const lines = designText.split("\n");
    for (let n = 1; n <= 12; n += 1) {
      const id = `A${n}`;
      const idRe = new RegExp(`\\b${id}\\b`);
      const nextHeadingRe = /^\s*(?:#{1,6}\s+|\*\*)?A\d{1,2}\b/;
      let found = false;
      for (let i = 0; i < lines.length && !found; i += 1) {
        if (!idRe.test(lines[i])) continue;
        // A table row must carry its own proof; otherwise the claim's block follows it.
        if (lines[i].trim().startsWith("|")) {
          found = /proof/i.test(lines[i]);
          continue;
        }
        const block = [lines[i]];
        for (let j = i + 1; j < lines.length; j += 1) {
          if (nextHeadingRe.test(lines[j]) || APPROVAL_RE.test(lines[j])) break;
          block.push(lines[j]);
        }
        found = block.some((line) => /proof/i.test(line));
      }
      if (!found) failures.push(`docs/v1-design.md: ${id} has no \`Proof\``);
    }

    const approval = lines.find((line) => APPROVAL_RE.test(line) && !/pending/i.test(line));
    if (!approval) {
      failures.push(
        "docs/v1-design.md: no owner approval line matching " +
          "`Approved by <name> on YYYY-MM-DD` (and not `pending`)",
      );
    }
  }

  return failures;
}

function evaluate() {
  const rel = "docs/evaluation.md";
  const text = read(rel);
  if (text === null) return [`missing ${rel}`];

  const failures = [];
  if (!/Decision:\s*GO\b/.test(text)) failures.push(`${rel}: no \`Decision: GO\` line`);
  const required = [
    ["LOC", /\bLOC\b/],
    ["tests", /\btests?\b/i],
    ["binary size", /binary size/i],
    ["time-to-first-token", /time[- ]to[- ]first[- ]token|\bTTFT\b/i],
    ["10k", /\b10k\b/i],
  ];
  for (const [label, re] of required) {
    if (!re.test(text)) failures.push(`${rel}: no measurement for ${label}`);
  }
  return failures;
}

function ship() {
  const failures = [];
  for (const rel of ["README.md", "LICENSE", "SECURITY.md", "CHANGELOG.md", "docs/release.md"]) {
    if (!exists(rel)) failures.push(`missing ${rel}`);
  }

  const tag = spawnSync("git", ["tag", "--list", "v1.0.0"], { cwd: ROOT, encoding: "utf8" });
  if (tag.status !== 0) {
    failures.push(`git tag --list v1.0.0 failed: ${(tag.stderr || "").trim() || tag.status}`);
  } else if (tag.stdout.trim() === "") {
    failures.push("git tag v1.0.0 does not exist");
  }

  const release = spawnSync("gh", ["release", "view", "v1.0.0"], { cwd: ROOT, encoding: "utf8" });
  if (release.error || release.status !== 0) {
    const detail = release.error
      ? release.error.message
      : (release.stderr || "").trim().split("\n")[0] || `exit ${release.status}`;
    failures.push(`gh release view v1.0.0 failed: ${detail}`);
  }

  return failures;
}

const mode = process.argv[2];
if (!MODES.includes(mode)) {
  process.stderr.write(`usage: node tools/check-cycle.mjs <${MODES.join("|")}>\n`);
  process.exit(2);
}

const check = { design, evaluate, ship }[mode];
const failures = check();

if (failures.length > 0) {
  process.stdout.write(`${mode} gate: FAIL — ${failures.length} missing item(s)\n`);
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
  if (mode === "design") {
    process.stdout.write(
      "  (design is the only gate that needs a human signature; " +
        "scribble the approval line in docs/v1-design.md)\n",
    );
  }
  process.exit(1);
}

process.stdout.write(`${mode} gate: PASS\n`);
