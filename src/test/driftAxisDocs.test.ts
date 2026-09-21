import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The drift axes are enumerated in prose in several docs, by hand. A
 * field that recreates a container but goes unlisted reads as a promise
 * that changing it leaves the container alone, so every axis
 * `diffContainerConfig` can report must appear in each list.
 *
 * The axis names are read out of the source rather than restated here:
 * a copy would be one more list to fall behind.
 */
const repoRoot = new URL("../../", import.meta.url);

function read(relative: string): string {
  // Resolved as a URL throughout. Converting to a path first and back
  // would make a Windows drive letter ("C:\repo\") look like a URL
  // scheme to the URL constructor.
  return readFileSync(new URL(relative, repoRoot), "utf8");
}

/** Every `drifted.push("<axis>")` in the diff, as written. */
function declaredAxes(): string[] {
  const source = read("src/containers.ts");
  const axes = [...source.matchAll(/drifted\.push\("([^"]+)"\)/g)].map(
    (m) => m[1],
  );
  assert.ok(
    axes.length > 0,
    "found no drift axes — did the call shape change?",
  );
  return [...new Set(axes)];
}

/**
 * `image+tag` is pushed as one axis but documented as the two fields a
 * consumer actually sets, and `user` is conditional (rootless podman's
 * keep-id mapping does not surface in `Config.User`, which suppresses it
 * by design), so it is only required where that nuance is explained.
 */
const AXIS_ALIASES: Record<string, string[]> = {
  "image+tag": ["image", "tag"],
};
const CONDITIONAL_AXES = new Set(["user"]);

/**
 * Each entry is the ONE sentence that enumerates the axes, located by a
 * stable anchor. Searching the whole file would pass on any stray
 * mention of a field name elsewhere — `capAdd` has its own section in
 * the README — which is exactly the false pass this test exists to
 * avoid.
 */
const DOC_LISTS: { file: string; anchor: string }[] = [
  { file: "README.md", anchor: "**Automatic config-drift recreation**" },
  { file: "README.md", anchor: "auto-recreates on config drift across" },
  { file: "AGENTS.md", anchor: "On drift across" },
  {
    file: "doc/plugin-developer-guide.md",
    anchor: "automatically removes + recreates when any of",
  },
  {
    file: "doc/plugin-developer-guide.md",
    anchor: "stopped with **drifted config**",
  },
];

/** The sentence starting at `anchor`, up to the end of that line. */
function listSentence(file: string, anchor: string): string {
  const text = read(file);
  const at = text.indexOf(anchor);
  assert.notEqual(at, -1, `anchor not found in ${file}: ${anchor}`);
  const end = text.indexOf("\n", at);
  return text.slice(at, end === -1 ? undefined : end);
}

describe("drift axis documentation", () => {
  for (const { file, anchor } of DOC_LISTS) {
    it(`${file} (${anchor.slice(0, 32)}…) lists every drift axis`, () => {
      const sentence = listSentence(file, anchor);
      const missing = declaredAxes()
        .filter((axis) => !CONDITIONAL_AXES.has(axis))
        .filter((axis) =>
          (AXIS_ALIASES[axis] ?? [axis]).some(
            (name) => !sentence.includes(name),
          ),
        );
      assert.deepEqual(
        missing,
        [],
        `${file}: the drift list omits ${missing.join(", ")}`,
      );
    });
  }
});
