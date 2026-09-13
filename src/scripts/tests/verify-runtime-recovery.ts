/**
 * Manual verification for the runtime-socket detection behaviour: that a
 * plugin started before its runtime socket exists recovers on its own, and
 * that a misconfigured endpoint does not send it into an endless retry.
 *
 * Not part of `npm test`. It spends ~15s of wall clock waiting for a real
 * backoff interval to elapse, and it needs a live rootless podman socket to
 * make appear — neither belongs in a suite that must run on every commit and
 * in CI's Windows runner. The automated coverage of these paths asserts the
 * decision rules; this asserts that a real plugin, on a real host, behaves
 * the way those rules intend.
 *
 * Usage, from the repo root after `npm run build`:
 *
 *   node dist/scripts/tests/verify-runtime-recovery.js
 *   node dist/scripts/tests/verify-runtime-recovery.js bootrace
 *
 * Exits non-zero if the boot-race scenario fails to recover.
 */
import { mkdtempSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerManagerApi, PluginConfig } from "../../types.js";

const REAL_SOCK = `/run/user/${String(process.getuid?.() ?? 1000)}/podman/podman.sock`;

/** How long to wait for the re-probe after the socket appears. The ladder
 *  starts at 5s and doubles, so the first probe past a 3s delay lands by
 *  ~10s; 11s leaves margin without dragging the run out. */
const RECOVERY_WAIT_MS = 11_000;
const SOCKET_APPEARS_AFTER_MS = 3_000;

function clearEnv(): void {
  delete process.env.DOCKER_HOST;
  delete process.env.CONTAINER_HOST;
}

/**
 * Re-import with a cache-busting query so each scenario picks up the
 * `process.env` it just set: the socket candidates are read at call time, but
 * the resolved client is cached per module instance.
 */
async function fresh<T>(mod: string): Promise<T> {
  const bust = `${String(Date.now())}-${String(Math.random())}`;
  return (await import(`../../${mod}?t=${bust}`)) as T;
}

/** A malformed endpoint is an operator mistake: terminal, and never a throw
 *  out of the doctor, which is documented as never throwing. */
async function malformed(): Promise<boolean> {
  clearEnv();
  process.env.DOCKER_HOST = "tcp://192.0.2.10:2375";
  const { selfDeployment } =
    await fresh<typeof import("../../doctor.js")>("doctor.js");
  const r = await selfDeployment("auto");
  const text = r.remediation.join("\n");
  console.log(`  status           : ${r.status}`);
  console.log(`  daemon.error     : ${r.daemon.error ?? "(none)"}`);
  console.log(`  says "not usable": ${String(text.includes("not usable"))}`);
  console.log(
    `  suggests waiting : ${String(text.includes("retries on its own"))} (want false)`,
  );
  return text.includes("not usable") && !text.includes("retries on its own");
}

/** An endpoint that is merely absent is transient: null, so detection retries. */
async function unreachable(): Promise<boolean> {
  clearEnv();
  process.env.CONTAINER_HOST = "/run/user/1000/podman/does-not-exist.sock";
  const client = await fresh<typeof import("../../client.js")>("client.js");
  client.resetClient();
  const resolved = await client
    .resolveClient("auto")
    .then((v) => (v === null ? "null (retryable)" : `resolved ${v.socketPath}`))
    .catch((e: unknown) => `THREW: ${e instanceof Error ? e.message : "?"}`);
  console.log(`  resolveClient    : ${resolved}`);

  const { selfDeployment } =
    await fresh<typeof import("../../doctor.js")>("doctor.js");
  const d = await selfDeployment("auto");
  const retryable = ["no-runtime", "socket-unreachable"].includes(d.status);
  console.log(
    `  doctor status    : ${d.status} (retryable: ${String(retryable)})`,
  );
  console.log(
    `  quoted command   : ${d.remediation.find((l) => l.includes("ls -l"))?.trim() ?? "(none)"}`,
  );
  return resolved.startsWith("null") && retryable;
}

/**
 * The scenario the retry exists for: Signal K starts before the socket is
 * there, the socket appears, and the plugin picks it up unaided. Without the
 * retry the final line reads "still null" no matter how long you wait.
 */
async function bootrace(): Promise<boolean> {
  clearEnv();
  if (!existsSync(REAL_SOCK)) {
    console.log(`  SKIP: no podman socket at ${REAL_SOCK}`);
    return true;
  }
  const dir = mkdtempSync(join(tmpdir(), "verify-bootrace-"));
  const sock = join(dir, "podman.sock");
  process.env.CONTAINER_HOST = sock;

  const t0 = Date.now();
  const log = (m: string): void =>
    console.log(`  [+${String(Date.now() - t0).padStart(5)}ms] ${m}`);
  const app = {
    debug: () => {},
    error: () => {},
    setPluginStatus: (m: string) => log(`STATUS: ${m}`),
    setPluginError: (m: string) =>
      log(m ? `ERROR : ${m.slice(0, 58)}` : "ERROR : (cleared)"),
    getDataDirPath: () => dir,
    config: { configPath: dir },
  };

  const mod = await fresh<typeof import("../../index.js")>("index.js");
  const plugin = mod.default(app);
  plugin.start({ disableUserNamespaceRemap: true } as PluginConfig);
  const api = (
    globalThis as { __signalk_containerManager?: ContainerManagerApi }
  ).__signalk_containerManager;
  if (!api) throw new Error("plugin did not expose containerManager API");
  await api.whenReady();
  log(`whenReady settled, runtime = ${api.getRuntime() ? "FOUND" : "null"}`);

  await new Promise((r) => setTimeout(r, SOCKET_APPEARS_AFTER_MS));
  symlinkSync(REAL_SOCK, sock);
  log(">>> socket appeared (stands in for user@<uid>.service coming up)");

  await new Promise((r) => setTimeout(r, RECOVERY_WAIT_MS));
  const rt = api.getRuntime();
  log(
    `FINAL : ${rt ? `${rt.runtime} ${rt.version}` : "still null — REGRESSION"}`,
  );

  if (plugin.stop) await plugin.stop();
  rmSync(dir, { recursive: true, force: true });
  return rt !== null;
}

const SCENARIOS: Record<string, () => Promise<boolean>> = {
  malformed,
  unreachable,
  bootrace,
};

const only = process.argv[2];
let ok = true;
for (const [name, fn] of Object.entries(SCENARIOS)) {
  if (only && only !== name) continue;
  console.log(`\n=== ${name} ===`);
  if (!(await fn())) ok = false;
}
clearEnv();
console.log(ok ? "\nall scenarios passed" : "\nREGRESSION detected");
process.exit(ok ? 0 : 1);
