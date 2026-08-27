#!/usr/bin/env node
/**
 * Reject hardcoded home-directory literals before CI does.
 *
 * The SignalK plugin CI runs this exact check and fails the build on any
 * match, across every platform at once. Catching it locally costs a second;
 * catching it in CI costs a red run on eight matrix legs.
 *
 * The regex is copied verbatim from the upstream workflow. Note it matches a
 * quote or BACKTICK followed by the path, so a doc comment is not exempt --
 * write such an example with the segment assembled, or use a neutral path.
 *
 * Scans sources, not build output: `dist/` is compiled from `src/` and would
 * only ever duplicate a finding, while the CI validator reads the published
 * tree.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const HARDCODED_PATH_RE = /["'`]\/home\/[a-zA-Z][a-zA-Z0-9_-]*\//g;
const SKIP = new Set(["node_modules", ".git", "dist", "public", "coverage"]);
const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (EXTENSIONS.some((e) => entry.endsWith(e))) yield full;
  }
}

export function findHardcodedHomePaths(root: string): string[] {
  const errors: string[] = [];
  for (const file of walk(root)) {
    const matches = readFileSync(file, "utf8").match(HARDCODED_PATH_RE);
    if (matches) {
      errors.push(`${relative(root, file)}: ${[...new Set(matches)].join(", ")}`);
    }
  }
  return errors;
}

const errors = findHardcodedHomePaths(process.cwd());
if (errors.length > 0) {
  console.error("Hardcoded home directory paths (plugin CI rejects these):");
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
