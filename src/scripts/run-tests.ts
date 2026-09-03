/**
 * Runs the unit suite, adding the JUnit reporter only when its output
 * directory can actually be created.
 *
 * The plugin registry clones into /home and sandboxes the run with firejail
 * `--read-only=/home`, so `mkdir test-results` fails with EACCES/EROFS before
 * a single test executes. `npm test` then exits non-zero and the registry
 * records `own_tests_pass: false` — a scoring failure caused by the reporter,
 * not by any test.
 *
 * CI still needs the file: plugin-ci uploads `test-results/` as an artifact,
 * and it is how the intermittent Windows whole-file failure gets diagnosed
 * (see AGENTS.md). So this degrades rather than dropping it — spec output on
 * stdout is unchanged either way, and the process exit code continues to
 * reflect the tests alone.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const JUNIT_DIR = "test-results";
const JUNIT_FILE = `${JUNIT_DIR}/junit.xml`;

/**
 * Whether the JUnit reporter can be attached, i.e. whether `dir` accepts a
 * write. Exported for tests; `dir` defaults to the real output directory.
 */
export function junitWritable(dir: string = JUNIT_DIR): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    // `mkdirSync` on an existing directory succeeds even where the filesystem
    // is read-only, so writing is what has to be proven — otherwise the
    // reporter itself fails later with EACCES and takes the whole run with it.
    const probe = `${dir}/.writable-probe`;
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return true;
  } catch (err) {
    // A read-only checkout is a legitimate way to run the suite, so this is
    // reported and stepped over rather than failing the run.
    const code = (err as NodeJS.ErrnoException).code ?? String(err);
    console.error(
      `[test] JUnit report disabled: ${dir}/ is not writable (${code})`,
    );
    return false;
  }
}

/**
 * The `node --test` argv, with the JUnit reporter appended only when its
 * destination is writable. Exported for tests.
 */
export function testArgs(withJunit: boolean): string[] {
  const args = [
    "--test",
    "--test-concurrency=1",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
  ];
  if (withJunit) {
    args.push(
      "--test-reporter=junit",
      `--test-reporter-destination=${JUNIT_FILE}`,
    );
  }
  args.push("dist/test/*.test.js");
  return args;
}

/** True when this module is the entry point, not an import from a test. */
const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  const { status, signal } = spawnSync(
    process.execPath,
    testArgs(junitWritable()),
    { stdio: "inherit" },
  );

  // A child killed by a signal must not be reported as a clean exit, so the
  // signal is re-raised rather than collapsed into a status code.
  if (signal) process.kill(process.pid, signal);
  process.exit(status ?? 1);
}
