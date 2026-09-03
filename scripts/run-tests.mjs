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
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const JUNIT_DIR = "test-results";
const JUNIT_FILE = `${JUNIT_DIR}/junit.xml`;

function junitWritable() {
  try {
    mkdirSync(JUNIT_DIR, { recursive: true });
    return true;
  } catch (err) {
    // A read-only checkout is a legitimate way to run the suite, so this is
    // reported and stepped over rather than failing the run.
    console.error(
      `[test] JUnit report disabled: cannot create ${JUNIT_DIR}/ (${err.code ?? err.message})`,
    );
    return false;
  }
}

const args = [
  "--test",
  "--test-concurrency=1",
  "--test-reporter=spec",
  "--test-reporter-destination=stdout",
];

if (junitWritable()) {
  args.push(
    "--test-reporter=junit",
    `--test-reporter-destination=${JUNIT_FILE}`,
  );
}

args.push("dist/test/*.test.js");

const { status, signal } = spawnSync(process.execPath, args, {
  stdio: "inherit",
});

if (signal) process.kill(process.pid, signal);
process.exit(status ?? 1);
