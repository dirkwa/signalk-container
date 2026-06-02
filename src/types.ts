import type {
  ConsumerManifest,
  ContainerManifestEntry,
  HistoryEntry,
} from "./manifest/schema.js";

export type RuntimeName = "podman" | "docker";
export type RuntimePreference = "auto" | RuntimeName;

export interface ContainerRuntimeInfo {
  runtime: RuntimeName;
  version: string;
  isPodmanDockerShim: boolean;
  /**
   * cgroup v2 controllers actually available to this runtime, e.g.
   * `["cpu", "memory", "pids"]` on a typical rootless podman setup
   * where cpuset is not delegated. `null` means "not probed" — treat
   * all controllers as available (used for docker, where we can't
   * easily query the per-runtime view).
   *
   * Used by `resources.ts` to silently drop ContainerResourceLimits
   * fields whose backing controller is missing, instead of letting
   * the runtime fail at container-create time.
   */
  cgroupControllers?: string[] | null;
  /**
   * Whether the runtime is operating in rootless mode.  Probed once
   * at detection time via `podman info --format
   * '{{.Host.Security.Rootless}}'` for Podman; assumed `false` for
   * Docker (rootless Docker accepts the same `--user` flag form as
   * rootful, so the distinction doesn't matter for our flag-emission
   * logic).  `null` means "not probed" — treat as not rootless.
   *
   * Used by `jobs.ts` to pick the right UID-mapping flag form for
   * `runJob` containers: `--userns=keep-id:uid=N,gid=N` is rootless-
   * Podman-only and errors out under rootful, so we have to detect
   * before emitting it.
   */
  isRootless?: boolean | null;
  /**
   * Effective host user (uid/gid) of the Signal K server process.
   * Captured once at detection time from `process.getuid()` /
   * `process.getgid()`.
   *
   * Reserved for the upcoming `ownership` config translator: files
   * created inside a container started with `--user uid:gid` (or
   * `--userns=keep-id` on rootless Podman) end up owned by this same
   * identity on the host, so the plugin doesn't need recursive
   * `chmod` sweeps to make outputs readable by Signal K.
   *
   * `null` on platforms where `process.getuid`/`getgid` are undefined
   * (Windows); callers must not emit `--user` flags in that case.
   */
  hostUser?: { uid: number; gid: number } | null;
  /**
   * Socket URL (e.g. `unix:///var/run/docker.sock`) for podman remote
   * mode. Set when the in-container podman binary can't operate
   * locally — typically because the image lacks the `uidmap` package
   * and rootless user-namespace mapping fails with
   * `exec: "newuidmap": executable file not found in $PATH` — but a
   * host podman socket has been bind-mounted into the container.
   *
   * When set, every podman invocation is prefixed with
   * `--remote --url <socket>` so commands route to the host daemon
   * instead of attempting local execution. The actual runtime is
   * still podman; the in-container binary just acts as a client.
   *
   * `undefined` for docker and for podman running directly.
   */
  remoteSocketUrl?: string;
}

export type ContainerState = "running" | "stopped" | "missing" | "no-runtime";

/**
 * Drop-in shape for a managed container. Pass the same `ContainerConfig`
 * to `ensureRunning` on every plugin start; signalk-container compares
 * the requested config against the live container's effective state and
 * automatically removes + recreates when any of `image`, `tag`, `command`,
 * `networkMode`, `env`, `volumes`, or `ports` differ. `resources` changes
 * are applied live where possible (see `updateResources`); the hash-file
 * pattern from earlier guides is no longer needed.
 *
 * One footgun: if you set `command`, set it consistently across calls.
 * Toggling between an explicit `command` and `undefined` will compare
 * `undefined` against the image's baked `CMD` and look like drift.
 */
export interface ContainerConfig {
  image: string;
  tag: string;
  /**
   * Optional manifest digest (`sha256:<64-hex>`). When set,
   * signalk-container pulls this exact image (`image@digest`) instead
   * of `image:tag`. The tag is retained for display and as the channel
   * default. Invalid digests throw synchronously before any runtime
   * call.
   */
  digest?: string;
  /**
   * Update-detection channel. Read by the update service to decide
   * how to reason about "new versions":
   *   - `"tag:<pattern>"` — semver-aware within a tag pattern, e.g. `"tag:7.x"`
   *   - `"tag:latest"` / `"tag:main"` — floating-tag digest-drift detection
   *   - `"digest:explicit"` — never auto-check; updates flow only via plugin releases
   *
   * If absent, signalk-container defaults to `"tag:<tag>"` so existing
   * plugins keep today's behavior verbatim.
   */
  updateChannel?: string;
  /**
   * When `true` AND `tag` classifies as floating (`latest`, `main`, `edge`,
   * `nightly`, etc.), `ensureRunning` pulls the tag on every call and
   * compares the registry-fresh image-id against the running container's
   * image-id. A mismatch is treated as drift → remove + recreate. This
   * matches what `updates/service.ts` does for floating-tag drift detection.
   *
   * Off by default — opt in per consumer plugin. The standard `image+tag`
   * string comparison is unchanged; this is an additional probe.
   *
   * Behavior on the unhappy paths:
   *   - Pull fails as offline (`ENOTFOUND`, `ENETUNREACH`, …): log debug,
   *     skip the check, leave the container running. Boats at sea are the
   *     primary motivation for this default.
   *   - Pull fails for any other reason: log debug, skip the check.
   *     Update probing must never block plugin startup.
   *   - `tag` is `semver` or `unknown`, or `config.digest` is set: no-op.
   *
   * Reuses `getImageDigest` and the existing `pullImage`; no new primitives.
   */
  autoUpdateOnFloatingTag?: boolean;
  ports?: Record<string, string>;
  /**
   * Explicit volume mounts. Keys are container paths, values are either:
   *   - an absolute host path string (bind mount)
   *   - a Docker/Podman named volume string (no leading `/`)
   *   - a `VolumeSpec` object for per-volume `ifMissing` policy (skip
   *     or abort when the host source is missing)
   *
   * Examples:
   *   `{ "/data": "/host/path" }`                                  // bind, auto-create
   *   `{ "/data": "my-volume" }`                                   // named volume
   *   `{ "/usb": { source: "/media/USB", ifMissing: "skip" } }`    // optional bind
   *   `{ "/certs": { source: "/etc/certs", ifMissing: "abort" } }` // required bind
   *
   * See `VolumeSpec` for the policy semantics and `EnsureRunningOptions.onVolumeIssue`
   * for the event handler that fires when a `'skip'` / `'abort'` policy
   * triggers or when a previously-missing source recovers.
   */
  volumes?: Record<string, string | VolumeSpec>;
  /**
   * Mount the SignalK data directory at this container path, regardless
   * of how SignalK itself is deployed (bare-metal, Docker with a named
   * volume, Docker with a bind mount).
   *
   * signalk-container resolves the appropriate source automatically:
   *   - bare-metal: binds `app.getDataDirPath()` directly
   *   - in Docker:  inspects the current container to find the named
   *     volume or host path backing `app.getDataDirPath()`, then
   *     mounts that same source into the managed container
   *
   * The mounted path in the managed container will correspond to the
   * root of `app.getDataDirPath()`.  Consumer plugins can compute paths
   * inside the mount as:
   *   `path.join(signalkDataMount, path.relative(app.getDataDirPath(), absPath))`
   *
   * Example:
   *   `signalkDataMount: "/signalk-data"` → FFmpeg can write to
   *   `/signalk-data/node_modules/my-plugin/public/out/stream.m3u8`
   */
  signalkDataMount?: string;
  /**
   * Mount the SignalK **server config root** at this container path,
   * regardless of how SignalK itself is deployed.  Use this when the
   * managed container needs to read or write the top-level SignalK
   * config (`settings.json`, `security.json`, `package.json`, the
   * whole `plugin-config-data/` tree, etc.) — for example a backup
   * tool, an audit tool, or a config-sync tool.
   *
   * The difference vs `signalkDataMount`:
   *
   *   - `signalkDataMount` resolves to `app.getDataDirPath()`, which
   *     SignalK rewrites per-plugin to the *plugin-private* subdirectory
   *     `<configRoot>/plugin-config-data/<pluginId>/`.  A consumer
   *     plugin asking for `signalkDataMount` therefore gets only the
   *     *signalk-container* plugin's own state subdirectory — useful
   *     for tools that just need a private writable area inside the
   *     SignalK data tree.
   *   - `signalkConfigRootMount` resolves to `app.config.configPath`,
   *     i.e. the top of the tree (typically `~/.signalk/`) — the entire
   *     SignalK installation config.
   *
   * signalk-container resolves the appropriate source automatically,
   * the same way it does for `signalkDataMount` — it inspects the
   * current container's mounts and finds the bind/volume that backs
   * `app.config.configPath`, falling back to the path itself when
   * SignalK runs bare-metal.
   *
   * `app.config` is provided by the SignalK server runtime; if the
   * caller's `app` object lacks `config.configPath`, an error is thrown.
   *
   * Example (a backup plugin):
   *   `signalkConfigRootMount: "/signalk-data"` → backup engine sees
   *   `settings.json`, `security.json`, etc. at `/signalk-data/*`.
   */
  signalkConfigRootMount?: string;
  /**
   * Container ports that the SignalK process needs to connect back to.
   * signalk-container automatically configures networking and port
   * allocation — no manual `ports` or `networkMode` needed.
   *
   * signalk-container resolves the appropriate strategy automatically:
   *   - bare-metal / host-network SignalK: each port is bound to
   *     127.0.0.1 on the host (first available port ≥ declared value).
   *   - containerized SignalK with a user-defined network: the managed
   *     container is attached to that same network — no host port is
   *     exposed at all.
   *   - containerized SignalK on the default bridge (no DNS): falls back
   *     to sharing the SignalK container's network namespace.
   *
   * Use `resolveContainerAddress()` to get the actual host:port (or
   * container-name:port) to connect to after `ensureRunning()`.
   *
   * Example:
   *   `signalkAccessiblePorts: [8090]` → FFmpeg HTTP server on port 8090
   *   is reachable at the address returned by `resolveContainerAddress()`.
   */
  signalkAccessiblePorts?: number[];
  env?: Record<string, string>;
  /**
   * Container-runtime restart policy. Forwarded as `--restart=<value>`
   * to `podman/docker run`. When omitted, signalk-container defaults
   * to `"unless-stopped"` so the container comes back after a host
   * reboot without the consumer plugin having to remember to opt in.
   * Pass `"no"` explicitly for one-shot containers that shouldn't
   * restart at all.
   */
  restart?: "no" | "unless-stopped" | "always";
  command?: string[];
  networkMode?: string;
  /**
   * Extra hosts to add to the container's `/etc/hosts`. Keys are hostnames,
   * values are IP addresses or special names like `host-gateway`.
   *
   * Example:
   *   `{ "internal-service": "192.168.1.100" }`
   *
   * Note: Podman automatically maps `host.containers.internal` to `host-gateway`,
   * but Docker does not, so this plugin adds that mapping for Docker automatically.
   */
  extraHosts?: Record<string, string>;
  /**
   * Run the container under the Signal K server's host uid/gid so files
   * created inside (on bind-mounted host paths) are owned by the same
   * identity on the host — no recursive `chmod` sweeps needed.
   *
   *   - omitted (default): emit a uid mapping that aligns the in-container
   *     process with the host caller. Rootless Podman uses user-namespace
   *     remapping; Docker and rootful Podman use direct UID/GID translation.
   *     The `inImageUid`/`inImageGid` default to 0 (i.e. the image's root)
   *     unless the consumer sets them to match the image's `USER`.
   *   - `{ inImageUid, inImageGid }`: same logic but with explicit
   *     in-image UID/GID. Use this when the image declares a non-root
   *     `USER` (e.g. `USER 1001`) so the rootless-Podman remap picks the
   *     right starting point for translation.
   *   - `false`: opt out. No uid-mapping flag emitted. The container
   *     runs with whatever the image's `USER` directive specifies.
   *     Use when the image requires root or manages its own user model.
   *
   * Mirrors `ContainerJobConfig.user` so the same translator drives both
   * long-running managed containers and one-shot helper jobs.
   */
  user?: { inImageUid?: number; inImageGid?: number } | false;
  /**
   * Resource limits for the container. The consumer plugin sets a
   * sensible default here; the user can override per-container via
   * signalk-container's plugin config (see `containerOverrides`).
   * The user override is field-level merged on top of the plugin
   * default — set a field to `null` to explicitly remove the limit.
   */
  resources?: ContainerResourceLimits;
  /**
   * Container labels emitted as `--label key=value` flags. Use this to
   * declare static metadata that survives `inspect`. Drift detection
   * does *not* compare labels — they are informational only and not
   * recreate-triggering.
   *
   * Recommended namespace for SignalK-ecosystem labels:
   *   `io.signalk.role`         — one of `server`, `updater`, `plugin-engine`, `one-shot`
   *   `io.signalk.persistent`   — `"true"` for containers external lifecycles own
   *   `io.signalk.managed-by`   — `"updater"`, `"signalk-container"`, or `"external"`
   *   `io.signalk.plugin-id`    — the plugin that registered this container
   *
   * The config panel will treat `io.signalk.persistent=true` as a hint
   * to hide destructive actions (Stop / Remove). See Phase 9b for that UI work.
   */
  labels?: Record<string, string>;
  /**
   * Explicit healthcheck override, for images that ship no `HEALTHCHECK`
   * of their own (or whose baked one is wrong for this deployment).
   *
   * Why this exists: signalk-container already re-emits an image's own
   * `HEALTHCHECK` as explicit `--health-*` run flags, because Podman
   * otherwise leaves the container parked in a perpetual `starting`
   * state (see `getImageHealthcheck`). But that only helps images that
   * *declare* a healthcheck. An image with none (e.g. `questdb/questdb`)
   * still lands in `starting` forever under Podman — `inspect` reports
   * `Health.Status: "starting"` with a null log and no probe to ever run.
   * Supplying an explicit healthcheck here gives the container a real
   * probe so it can reach `healthy`.
   *
   * Precedence: an explicit healthcheck here wins over the image's own
   * `HEALTHCHECK`. When omitted, the image's healthcheck (if any) is used
   * as before.
   *
   * Shape:
   *   - `false` — emit `--no-healthcheck`, forcing Podman to report the
   *     container with no health status instead of a stuck `starting`.
   *     Use when the image has no healthcheck and none is wanted.
   *   - `{ test, ... }` — emit `--health-cmd` and timing flags. `test` is
   *     the Docker `HEALTHCHECK` array form: `["CMD-SHELL", "<shell>"]` or
   *     `["CMD", "arg0", "arg1", ...]`. Durations are human strings the
   *     runtime accepts directly (`"30s"`, `"1m"`); they are NOT parsed.
   *
   * Example (QuestDB — curl is present in the image, only port 9000 is up):
   *   `{ test: ["CMD", "curl", "-f", "http://127.0.0.1:9000/"],
   *      interval: "30s", timeout: "5s", startPeriod: "15s", retries: 3 }`
   *
   * Not part of drift detection — changing it does not recreate a running
   * container; the new probe takes effect on the next recreate for another
   * reason (image/env/volumes/ports change) or a clean start.
   */
  healthcheck?: HealthcheckOverride;
}

/**
 * Explicit healthcheck for a managed container. `false` disables the
 * healthcheck entirely (`--no-healthcheck`); the object form supplies a
 * probe command plus optional timing. Durations are passed to the runtime
 * verbatim, so use the runtime's duration syntax (`"30s"`, `"1m30s"`).
 */
export type HealthcheckOverride =
  | false
  | {
      /**
       * Docker `HEALTHCHECK` array form. `["CMD-SHELL", "<one shell string>"]`
       * runs the string under a shell; `["CMD", "arg0", "arg1", ...]` execs
       * the argv directly without a shell.
       */
      test: string[];
      /** Probe interval, e.g. `"30s"`. Runtime default when omitted. */
      interval?: string;
      /** Per-probe timeout, e.g. `"5s"`. Runtime default when omitted. */
      timeout?: string;
      /** Grace period before failures count, e.g. `"15s"`. */
      startPeriod?: string;
      /** Consecutive failures before `unhealthy`. Runtime default when omitted. */
      retries?: number;
    };

/**
 * Resource limits applied via podman/docker run flags. All fields
 * are optional; omitted means "no limit imposed by us" (the runtime
 * default applies). Use `null` in a user override to explicitly
 * remove a limit set by the plugin default.
 *
 * For semantics see:
 *   https://docs.podman.io/en/latest/markdown/podman-run.1.html#cpu-options
 *   https://docs.podman.io/en/latest/markdown/podman-run.1.html#memory-options
 */
export interface ContainerResourceLimits {
  /** Hard CPU cap (CFS quota). e.g. 1.5 = 1.5 cores. */
  cpus?: number | null;
  /** Soft CPU weight under contention. Default 1024. */
  cpuShares?: number | null;
  /** Pin to specific cores. e.g. "0,1" or "1-3". */
  cpusetCpus?: string | null;
  /** Hard memory cap, e.g. "512m", "2g". */
  memory?: string | null;
  /**
   * Total memory + swap. Set equal to `memory` to disable swap entirely.
   * Recommended for predictable behavior.
   */
  memorySwap?: string | null;
  /** Soft floor — kernel reclaims first from containers above this. */
  memoryReservation?: string | null;
  /** Process/thread cap to bound runaway thread leaks. */
  pidsLimit?: number | null;
  /** OOM score adjustment, -1000..1000. Higher = killed first. */
  oomScoreAdj?: number | null;
}

export interface ContainerInfo {
  name: string;
  image: string;
  state: ContainerState;
  created: string;
  ports: string[];
  managedBy: string;
}

export interface ContainerJobConfig {
  image: string;
  command: string[];
  inputs?: Record<string, string>;
  outputs?: Record<string, string>;
  env?: Record<string, string>;
  timeout?: number;
  /**
   * Called for every line on stdout *or* stderr — the historical single-stream
   * progress callback.  Stays available for callers that don't care about
   * which stream a line came from (image-pull progress, simple logging).
   */
  onProgress?: (msg: string) => void;
  /**
   * Called for every line on the container's stdout.  Use this when stdout
   * carries structured progress (e.g. tools that print `PROGRESS: ...` to
   * stdout while writing diagnostics to stderr).  Fires alongside
   * `onProgress` — both are invoked for the same line.
   */
  onStdoutLine?: (line: string) => void;
  /**
   * Called for every line on the container's stderr.  Use this to capture
   * diagnostics (GDAL/ogr2ogr warnings, tool-internal errors) without
   * mixing them into the stdout progress stream.  Fires alongside
   * `onProgress` — both are invoked for the same line.
   */
  onStderrLine?: (line: string) => void;
  /**
   * Optional cgroup resource limits applied to the helper container —
   * `--cpus`, `--memory`, `--pids-limit`, etc.  Same shape as
   * `ContainerConfig.resources`, same `resourceFlagsForRun` translator.
   *
   * Without this, runJob containers run with no kernel-enforced ceiling,
   * which is fine for most one-shot helpers but lets CPU-bound workloads
   * (tippecanoe, GDAL parallel exports) saturate every core regardless
   * of any in-process thread limit the caller may have configured via
   * env.  Set `cpus` here to keep the helper to a fraction of the host.
   *
   * Fields whose backing controller is not delegated to the runtime
   * (typically `cpuset` on rootless podman) are silently dropped — same
   * behaviour as `ensureRunning`.
   */
  resources?: ContainerResourceLimits;
  label?: string;
  /**
   * Owning plugin's `id` from its package.json (e.g.
   * `"signalk-charts-provider-simple"`).  When set, the job container
   * carries an `sk-job-owner=<id>` label, which is what
   * `cleanupOrphanedJobs({ ownerPluginId })` uses to find and reap
   * containers leaked by a previous server lifecycle (Signal K
   * crashed mid-job, the conversion container kept running, the
   * plugin's listener was lost).
   *
   * Optional but strongly recommended for any long-running job —
   * without it, leaked containers from a prior crash will keep
   * running until the host reboots, and the plugin can't tell which
   * orphans belong to it.
   *
   * Available in signalk-container >= 1.3.0.
   */
  ownerPluginId?: string;
  /**
   * Align the in-container UID/GID with the host caller's UID/GID so
   * files written into bind-mounted output dirs land owned by the
   * host signalk-server process, not by an unrelated container UID.
   *
   * The auto path picks the right mechanism per runtime: Docker (any
   * flavour) and rootful Podman use direct UID/GID translation; rootless
   * Podman uses user-namespace remapping. The two forms achieve the same
   * end via different mechanisms, which is why the runtime detection
   * matters (the rootless-Podman flag errors out under rootful Podman).
   *
   * - Default (`undefined`): auto-align using `process.getuid()` /
   *   `process.getgid()`, assuming the image's USER directive is
   *   root (UID 0).  This matches the behaviour of the helper images
   *   shipped before this field existed (osgeo/gdal, the legacy
   *   tippecanoe image, …).
   * - `{ inImageUid, inImageGid }`: image declares a non-root USER.
   *   Required for rootless-Podman + non-root images so `keep-id`
   *   maps the in-image UID back to the host caller.  The new
   *   `charts-toolbox` image with `USER toolbox` (UID/GID 1001)
   *   passes `{ inImageUid: 1001, inImageGid: 1001 }`.
   * - `false`: opt out entirely.  Container runs as whatever the
   *   image's USER directive specifies, with no host-UID mapping.
   *   Useful only for debugging or for callers that don't need the
   *   container to write into a host-owned bind mount.
   *
   * Earlier signalk-container versions silently ignored the field;
   * newly-enabled flag emission means existing root-default helper
   * images keep working (they're now also UID-aligned, which is
   * strictly an improvement) without any caller change.  Consumer
   * plugins relying on the flag emission should bump their declared
   * `signalk-container` peer-dep to the version that introduced it.
   */
  user?: { inImageUid?: number; inImageGid?: number } | false;
}

export type ContainerJobStatus =
  | "pending"
  | "pulling"
  | "running"
  | "completed"
  | "failed";

export interface ContainerJobResult {
  id: string;
  status: ContainerJobStatus;
  image: string;
  command: string[];
  label?: string;
  exitCode?: number;
  log: string[];
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  runtime?: RuntimeName;
}

export interface PruneResult {
  imagesRemoved: number;
  spaceReclaimed: string;
}

/**
 * Per-orphan record returned by `cleanupOrphanedJobs`.  One entry per
 * stale `sk-job-*` container that was found running and has been
 * stopped + removed.  The plugin uses this to roll back any
 * persistent state it had associated with the job (e.g. a
 * "currently converting" flag, an install record).
 */
export interface OrphanJobInfo {
  /** Container name as the runtime saw it (e.g. `sk-job-7d4839a9`). */
  name: string;
  /** Image the container was running. */
  image: string;
  /** Owning plugin's id, copied from the `sk-job-owner` label. */
  ownerPluginId: string;
  /** Free-form label set on the original `runJob` config. */
  label?: string;
}

export interface CleanupOrphansResult {
  reaped: OrphanJobInfo[];
}

/**
 * Per-entry policy for a `ContainerConfig.volumes` mount when the host
 * source path is missing at container-create time. Use the object form
 * in `volumes` whenever the source is something other than plugin-owned
 * state — user-managed resources (USB drives, NFS mounts) and
 * deployment-required mounts (TLS certs, secrets) all benefit from
 * explicit policy.
 *
 * Named volumes (`source` without a leading `/` or `.`) always pass
 * through regardless of `ifMissing` — the runtime owns their lifecycle.
 */
export interface VolumeSpec {
  /** Host path or named-volume string — same shape as the bare-string form. */
  source: string;
  /**
   * What signalk-container should do when `source` is a host path
   * (absolute, starts with `/`; or relative, starts with `.`) and the
   * path does not exist:
   *
   *   - `'create'` (default, same as a bare string): the volume is
   *     passed through to the runtime, which auto-creates the host
   *     directory as an empty dir. Right for plugin state directories.
   *   - `'skip'`: signalk-container omits the volume from the
   *     requested config; the container starts without the mount.
   *     An `onVolumeIssue` event with `action: 'skipped'` fires so
   *     the plugin can surface status (e.g. `setPluginStatus`).
   *     Right for user-managed resources (USB drives, optional
   *     baseline mounts, NFS shares).
   *   - `'abort'`: signalk-container throws from `ensureRunning`
   *     with a clear error message; the plugin's `await` rejects.
   *     An `onVolumeIssue` event with `action: 'aborted'` fires
   *     before the throw. Right for mounts the container cannot
   *     run without (TLS certificates, persistent state required
   *     for correctness, deployment-specified secrets).
   *
   * Defaults to `'create'` for backwards compatibility.
   */
  ifMissing?: "create" | "skip" | "abort";
}

/**
 * One policy event delivered to `EnsureRunningOptions.onVolumeIssue`.
 * The same callback fires for all three actions; switch on `action`
 * to dispatch.
 */
export interface VolumeIssue {
  /** Container-side mount path — the key in `ContainerConfig.volumes`. */
  containerPath: string;
  /** Host source as declared on the requested config (post magic-field resolution). */
  source: string;
  /**
   * What signalk-container did about this volume:
   *   - `'skipped'`: dropped from the requested config; container
   *     starts without the mount.
   *   - `'aborted'`: signalk-container is about to throw from
   *     `ensureRunning`. Fires synchronously before the throw.
   *   - `'recovered'`: a previously skipped or aborted volume's
   *     source has reappeared. The container has been recreated
   *     to include the mount. Fires AFTER the recreate completes.
   */
  action: "skipped" | "aborted" | "recovered";
  /** Human-readable explanation; safe to surface in `setPluginStatus`. */
  reason: string;
}

export interface HealthCheckOptions {
  healthCheck?: () => Promise<boolean>;
  onUnhealthy?: (name: string, error: string) => void;
}

/**
 * Options for `ensureRunning(name, config, options)`. Superset of
 * `HealthCheckOptions` — existing callers passing a `HealthCheckOptions`
 * object continue to work.
 */
export interface EnsureRunningOptions extends HealthCheckOptions {
  /**
   * Called once per volume that hit a policy event during this
   * `ensureRunning` call. Fires for `'skipped'`, `'aborted'`, and
   * `'recovered'` actions on volumes declared with the `VolumeSpec`
   * object form (no events fire for bare-string or `'create'`-policy
   * volumes — those are today's auto-create behaviour).
   *
   *   - `'skipped'`: an `ifMissing: 'skip'` volume's host source was
   *     missing; signalk-container dropped it and the container
   *     starts without the mount.
   *   - `'aborted'`: an `ifMissing: 'abort'` volume's host source
   *     was missing; signalk-container fires this event synchronously
   *     and then throws. Plugins can `app.setPluginError(...)`
   *     inside the handler before the throw propagates.
   *   - `'recovered'`: a volume previously dropped or aborted is
   *     now present and applied. The container has been recreated
   *     to include the mount. Plugins can clear any
   *     "waiting for resource" status.
   *
   * Synchronous and asynchronous handlers are both supported.
   * `ensureRunning` does not await an async handler — the call fires
   * and forgets, and its eventual return value is ignored. Both
   * synchronous throws and rejected promises are caught and logged
   * at error level; they do not affect container lifecycle.
   *
   * Keep handlers fast and side-effect-only (set plugin status, log,
   * etc.) — they are invoked in the lifecycle hot path.
   */
  onVolumeIssue?: (event: VolumeIssue) => void | Promise<void>;

  /**
   * Called for every line the managed container writes to stdout
   * or stderr (combined, the same shape a human gets from
   * `podman logs sk-<name>` or `docker logs sk-<name>`).
   * signalk-container spawns a `logs -f` child when the container
   * is running and forwards lines to the callback.  The tail is
   * torn down and respawned automatically on auto-recreate,
   * removed on `containers.remove()`, and stopped on plugin
   * `stop()`.
   *
   * Synchronous and asynchronous handlers are both supported.
   * `ensureRunning` does not await the handler — fire-and-forget.
   * Both synchronous throws and rejected promises are caught and
   * logged at error level; handler bugs cannot break container
   * lifecycle.  Keep handlers fast and side-effect-only — they
   * are invoked per line on the runtime log stream.
   *
   * Typical use: wire to `app.debug` so the lines are visible in
   * the Signal K server log whenever the user enables debug for
   * the consumer plugin:
   *
   *   onContainerLog: (line) => app.debug(`[questdb] ${line}`)
   *
   * Multiple subscribers share a single underlying tail process
   * (a per-container broker fans out lines), so wiring this
   * callback never doubles the runtime daemon's work even when
   * a user has the in-panel Logs modal open simultaneously.
   *
   * Combined stdout+stderr only; per-stream separation is not
   * supported in this release.  Available in signalk-container
   * 1.7.0+.
   */
  onContainerLog?: (line: string) => void | Promise<void>;

  /**
   * Number of recent log lines to deliver via `onContainerLog`
   * when the tail attaches.  Defaults to 0 — only live lines
   * (everything after attach) flow.  Set to e.g. 100 to
   * backfill recent history on plugin restart against an
   * already-running container.  Maps to `podman logs --tail=N`
   * / `docker logs --tail=N`.
   *
   * Caveat: if the broker for this container already exists
   * (another subscriber spawned it first), the new subscriber
   * starts from "now" — `startTail` is per-broker, applied at
   * first-subscribe time only.  Use `containers.getLogs(name,
   * { tail })` for an explicit one-shot backfill regardless of
   * broker state.
   *
   * Has no effect when `onContainerLog` is not set.
   */
  onContainerLogStartTail?: number;
  /**
   * Owning consumer plugin's `id` from its `package.json`. When set,
   * the manifest at `${dataDir}/signalk-container-manifests/<pluginId>.json`
   * records this container against the plugin so the UI and REST API
   * can surface "which plugin pinned this".
   *
   * Must be a valid npm package name (e.g. `signalk-questdb`) or a
   * scoped form (e.g. `@signalk/foo`). Anything else is rejected at
   * the manifest-write boundary with a clear error.
   *
   * Optional for backward compatibility — when absent, the manifest is
   * keyed under the synthetic id `container:<name>`, so the
   * per-container history view continues to work. Strongly recommended
   * for any plugin adopting digest pinning.
   */
  pluginId?: string;
  /**
   * Owning consumer plugin's `version` from its `package.json`.
   * Recorded as `triggeredBy` in the manifest's history entries.
   * Optional; defaults to `"unknown"` if omitted.
   */
  pluginVersion?: string;
}

export interface ContainerManagerApi {
  getRuntime(): ContainerRuntimeInfo | null;
  /**
   * Resolves once runtime detection has settled (success OR failure).
   * `getRuntime()` is guaranteed non-null only when this resolves AND
   * runtime detection succeeded — callers should still re-check
   * `getRuntime()` after the await to distinguish "detection failed" from
   * "still in flight". Lets consumers replace the
   * `while (Date.now() < deadline && !getRuntime()) await sleep(1000)`
   * polling pattern with a single `await containers.whenReady()`.
   */
  whenReady(): Promise<void>;
  pullImage(image: string, onProgress?: (msg: string) => void): Promise<void>;
  imageExists(image: string): Promise<boolean>;
  /**
   * Return the local image digest (sha256 ID) for an image reference or
   * container name, or null if not present. Used by the update detection
   * service for floating-tag drift checks.
   */
  getImageDigest(imageOrContainer: string): Promise<string | null>;
  /**
   * Apply new resource limits to a running container. Tries the
   * runtime's live `update` command first (no downtime); falls back
   * to stop+remove+ensureRunning if the runtime can't apply them
   * live (e.g. cpuset on some kernels). The container's effective
   * limits become the field-level merge of `limits` on top of the
   * config last passed to `ensureRunning`.
   */
  updateResources(
    name: string,
    limits: ContainerResourceLimits,
  ): Promise<UpdateResourcesResult>;
  /**
   * Return the currently effective resource limits for a managed
   * container, merging plugin defaults and user overrides. Returns
   * an empty object if the container has no limits or doesn't exist.
   */
  getResources(name: string): ContainerResourceLimits;
  ensureRunning(
    name: string,
    config: ContainerConfig,
    options?: EnsureRunningOptions,
  ): Promise<void>;
  /**
   * Force-recreate a managed container: remove the existing one
   * (running or stopped) if present, then create it fresh from
   * `config`. Unlike `ensureRunning` — which short-circuits on
   * "already running with matching config" — `recreate` always
   * replaces the container, briefly interrupting it.
   *
   * Use this when the caller knows the desired state differs from
   * live and wants to apply it now without depending on drift
   * detection — for example after a consumer plugin bumps the image
   * tag it pins to ("Update now" UX, plugin-startup self-heal when
   * the running container's image disagrees with the just-bumped
   * version constant).
   *
   * Volume policy, `signalkAccessiblePorts`, `signalkConfigRootMount`,
   * and `signalkDataMount` are resolved identically to `ensureRunning`.
   *
   * Available in signalk-container 1.12.0+.
   */
  recreate(
    name: string,
    config: ContainerConfig,
    options?: EnsureRunningOptions,
  ): Promise<void>;
  /**
   * Resolve the source (named volume or host path) that backs
   * `app.getDataDirPath()` in the current deployment.  The return value
   * is what signalk-container uses internally when a ContainerConfig
   * carries `signalkDataMount`; expose it here so consumer plugins can
   * log or inspect the resolved value if needed.
   *
   * Returns null if the runtime is not yet initialised.
   */
  resolveSignalkDataMount(): Promise<string | null>;
  /**
   * Translate an arbitrary absolute path into the `(source, subPath)`
   * pair that lets a managed container reach that path on the host,
   * regardless of how SignalK itself is deployed (bare-metal, Docker
   * with a bind, Docker with a named volume, parent-directory binds,
   * etc.).
   *
   * Use this when a consumer plugin needs to mount a path that is NOT
   * `app.getDataDirPath()` but still lives somewhere reachable from
   * SignalK's host filesystem — for example a chart directory, a
   * download cache, or any user-configured location.
   *
   *     const r = await containers.resolveHostPath("/opt/signalk/charts");
   *     await containers.runJob({
   *       inputs: { "/in": r.source },
   *       command: ["tool", `/in/${r.subPath}/foo`],
   *     });
   *
   * `source` plugs straight into ContainerJobConfig.inputs / outputs;
   * `subPath` is the path INSIDE that mount where the requested abs
   * path lives (empty string when the source already corresponds to
   * absPath).
   *
   * Returns null when running inside a container and no mount covers
   * absPath (i.e. the host runtime physically cannot see it) — the
   * consumer should surface an actionable error rather than passing
   * null through to `runJob`.  Bare-metal callers always get a result.
   */
  resolveHostPath(
    absPath: string,
  ): Promise<{ source: string; subPath: string } | null>;
  /**
   * Returns the `host:port` string to reach `containerPort` on a managed
   * container from the SignalK process. Call after `ensureRunning()` with
   * `signalkAccessiblePorts` set.
   *
   * - bare-metal  → `'127.0.0.1:8091'`  (actual allocated host port)
   * - containerized, user-defined network → `'sk-rtsp-to-fmp4:8090'`
   * - containerized, default bridge fallback → `'127.0.0.1:8090'`
   *
   * Returns `null` if the runtime is not available or the port was never
   * declared in `signalkAccessiblePorts`.
   *
   * @throws if the port was declared via `signalkAccessiblePorts` but
   *   `ensureRunning()` has not yet been called — this indicates a plugin
   *   author bug (calling `resolveContainerAddress` before the container
   *   is started).
   */
  resolveContainerAddress(
    containerName: string,
    containerPort: number,
  ): Promise<string | null>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  getState(name: string): Promise<ContainerState>;
  runJob(config: ContainerJobConfig): Promise<ContainerJobResult>;
  /**
   * One-shot capture of the last `tail` lines of a managed
   * container's combined stdout/stderr log.  Mirrors
   * `podman logs --tail <N> [--since <ts>] sk-<name>`.  Useful
   * for attaching log context to a health-check failure or for
   * explicit backfill that bypasses the streaming broker.
   *
   * `tail` defaults to 200, max 10000.  `since` is unix-epoch
   * seconds (optional, both runtimes support it).  Returns the
   * lines in order; throws on inspect failure.
   *
   * Available in signalk-container 1.7.0+.
   */
  getLogs(
    name: string,
    options?: { tail?: number; since?: number },
  ): Promise<string[]>;
  /**
   * Reap `sk-job-*` containers leaked by a previous server lifecycle
   * (Signal K crashed or restarted mid-job, the helper container kept
   * running, the plugin's job listener was lost).  Stops and removes
   * each matching container with `--force` and returns a record of
   * what was reaped so the plugin can scrub any persistent state it
   * had associated with those jobs (a "currently converting" flag,
   * an install record that was written before the conversion ran,
   * etc.).
   *
   * Filters by the `ownerPluginId` label written by `runJob` when
   * the caller provided `ContainerJobConfig.ownerPluginId`.  Plugins
   * that omit `ownerPluginId` on their job configs cannot be reaped
   * by this API — there's no safe way for one plugin to claim
   * another's containers.
   *
   * Idempotent: if there are no orphans, returns `{ reaped: [] }`.
   * Available in signalk-container >= 1.3.0.
   */
  cleanupOrphanedJobs(filter: {
    ownerPluginId: string;
  }): Promise<CleanupOrphansResult>;
  prune(): Promise<PruneResult>;
  listContainers(): Promise<ContainerInfo[]>;
  ensureNetwork(name: string): Promise<void>;
  removeNetwork(name: string): Promise<void>;
  connectToNetwork(containerName: string, networkName: string): Promise<void>;
  execInContainer(
    name: string,
    command: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  disconnectFromNetwork(
    containerName: string,
    networkName: string,
  ): Promise<void>;
  /**
   * Read-only access to per-plugin image-pinning manifests. Manifest
   * entries are written automatically on successful `ensureRunning`
   * calls; consumers query here to surface pinning state or history.
   */
  manifest: ManifestApi;
  /**
   * Centralized container-image update detection. Consumer plugins
   * register their containers and the service handles version checking,
   * scheduling, caching, and offline-tolerance.
   * See doc/plugin-developer-guide.md "Update detection" for usage.
   */
  updates: import("./updates/types.js").UpdateServiceApi;
  /**
   * Image-compliance probes. Use before adopting an image to confirm
   * it runs cleanly under the host UID mapping signalk-container will
   * emit for managed containers — i.e. that `/tmp` is writable for the
   * host caller and the image doesn't depend on a writable `~/.<x>` or
   * a root-only path.
   */
  doctor: DoctorApi;
}

/**
 * Image-compliance probes exposed to consumer plugins via
 * `manager.doctor.*`. Each method runs a short-lived helper container
 * and reports back without touching the plugin's managed state.
 */
export interface DoctorApi {
  /**
   * Run `image:tag` under the same uid mapping `ensureRunning` would
   * use for this `user` value and verify that the container can
   * `touch /tmp/x` as the host caller.
   *
   * Returns `{ ok: true }` when the probe exits 0 and prints `"ok"`.
   * Never throws — failure modes (non-zero exit, exec error, missing
   * binary) all return `{ ok: false, error }`.
   *
   * Use this before adopting an unfamiliar image to surface UID-
   * compatibility problems early, instead of debugging them after
   * the container is wedged in a restart loop.
   */
  imageRunsAsUser(
    image: string,
    user?: ContainerConfig["user"],
  ): Promise<{ ok: boolean; output: string; error?: string }>;

  /**
   * Diagnose the Signal K deployment itself: whether SK is
   * containerized, whether a container runtime CLI is reachable, and
   * whether the daemon answers (rootless or rootful, podman or docker).
   *
   * Intended as the single "what is wrong with my setup?" entry point
   * for operators running Signal K in a container. Returns the resolved
   * deployment shape plus a copy-pasteable `remediation` list when
   * something is wrong. Never throws.
   *
   * Surfaced over REST at `GET /plugins/signalk-container/api/doctor/deployment`.
   */
  selfDeployment(): Promise<SelfDeploymentResult>;

  /**
   * Generate a ready-to-paste compose fragment or `podman/docker run`
   * command tailored to the detected (or supplied) deployment shape.
   *
   * Pure templating over `SelfDeploymentResult`; runs no probes itself.
   * When `result` is omitted, the latest `selfDeployment()` snapshot is
   * used. Bundles a minimal Dockerfile sidecar showing the image-side
   * prereqs (`RUN apt-get install -y podman` etc) and a `notes` array
   * with operator-facing caveats (SELinux, Windows uid-mapping, etc).
   *
   * Surfaced over REST at
   * `GET /plugins/signalk-container/api/doctor/snippet?format=compose|run`.
   * That endpoint returns `text/plain` by default; `Accept: application/json`
   * yields the full `SetupSnippetResult` structure.
   */
  generateSetupSnippet(
    format?: SetupSnippetFormat,
    result?: SelfDeploymentResult,
  ): Promise<SetupSnippetResult>;
}

/**
 * Verdict from `DoctorApi.selfDeployment()`. Each variant of `status`
 * corresponds to one block of `remediation` lines the operator can
 * paste into their compose / `podman run` invocation.
 */
export type SelfDeploymentStatus =
  | "ok"
  | "no-runtime"
  | "socket-unreachable"
  | "permission-denied"
  | "self-id-unresolved"
  | "cgroup-controllers-incomplete";

export interface SelfDeploymentResult {
  /** True when /.dockerenv, /run/.containerenv, or `$container` is set. */
  isContainerized: boolean;
  /** Which runtime binary was discovered, if any. */
  binary: {
    name: RuntimeName | null;
    /** Resolved `$PATH` location (output of `command -v <name>`); null if not found. */
    path: string | null;
    /** First whitespace-separated token after "version" in `<name> --version`. */
    version: string | null;
  };
  /** Whether the binary can talk to a daemon. */
  daemon: {
    reachable: boolean;
    /** Extracted from `podman info` / `docker info`; null if not determinable. */
    rootless: boolean | null;
    /** Socket path the binary used, if observable from env vars. */
    socketPath: string | null;
    /** Trimmed stderr or exec error message; null on success. */
    error: string | null;
  };
  /** Env vars consulted for socket discovery. Echoed verbatim. */
  env: {
    DOCKER_HOST: string | null;
    CONTAINER_HOST: string | null;
    XDG_RUNTIME_DIR: string | null;
  };
  /**
   * Result of the `findSelfContainerId` cascade. Only attempted when
   * `isContainerized` is true AND `daemon.reachable` is true (the
   * cascade's HOSTNAME and cgroup branches `inspect`-validate, which
   * needs a working daemon).
   */
  selfId: {
    value: string | null;
    source: "env" | "hostname" | "cgroup" | null;
  };
  /**
   * cgroup v2 controller delegation state for the user/cgroup the SK
   * process runs in. Probed by reading `/sys/fs/cgroup/cgroup.controllers`.
   *
   * `available` is null when the file couldn't be read (cgroup v1 host,
   * non-Linux, or unusual mount layout) — in that case `missing` is `[]`
   * and the cgroup component of `status` is left unchanged.
   *
   * `missing` lists the controllers the consumer plugin layer needs but
   * the host hasn't delegated; today that's `["memory", "cpu", "cpuset",
   * "pids"]` minus whatever's in `available`. When `isContainerized` is
   * true AND `missing` is non-empty, `status` escalates to
   * `cgroup-controllers-incomplete` (lower priority than runtime/socket/
   * self-id failures — those block more functionality).
   *
   * `kernelDisabledMemory` is true when `/proc/cmdline` contains
   * `cgroup_disable=memory` without a later overriding
   * `cgroup_enable=memory`. Hit on Raspberry Pi OS Trixie (and other
   * RPi OS variants); the firmware-injected cmdline disables the memory
   * controller before systemd ever sees it, so systemd's
   * `Delegate=memory` has nothing to delegate. The doctor's remediation
   * block surfaces the cmdline.txt fix in that case instead of the
   * systemd-only fix that wouldn't help.
   */
  cgroupControllers: {
    available: string[] | null;
    missing: string[];
    kernelDisabledMemory: boolean;
  };
  /**
   * Storage-driver / backing-filesystem situation for rootless Podman.
   * Populated when the daemon is reachable AND rootless. Advisory
   * only — does not escalate `status` because the host is not in a
   * broken state. `idmapHazard` flags filesystems known to misbehave
   * when `--userns=keep-id` triggers Podman's `storage-chown-by-maps`
   * sweep (ZFS is the canonical case; some encrypted filesystems
   * behave the same way). `advice` carries operator-facing remediation
   * lines pointing at the recommended `fuse-overlayfs` storage driver
   * and the `disableUserNamespaceRemap` config flag.
   *
   * `null` when the probe could not run (non-Linux, mounts file
   * unreadable, no rootless Podman detected).
   */
  containerStorage: {
    /** Mount point covering the rootless storage root, or `null` if unknown. */
    storagePath: string | null;
    /** Filesystem type as reported by `/proc/mounts`, or `null` if unknown. */
    fstype: string | null;
    /** True when `fstype` is in the "may cause `--userns=keep-id` trouble" set. */
    idmapHazard: boolean;
    /** Operator-facing remediation; empty when `idmapHazard` is false. */
    advice: string[];
  } | null;
  status: SelfDeploymentStatus;
  /** Empty when `status === "ok"`. */
  remediation: string[];
}

/**
 * Which form the setup snippet should take. `compose` produces a YAML
 * fragment intended to be pasted into a `docker-compose.yml` `services:`
 * block. `run` produces a single (multi-line, backslash-continued)
 * shell command using `podman run` or `docker run`.
 */
export type SetupSnippetFormat = "compose" | "run";

export interface SetupSnippetResult {
  format: SetupSnippetFormat;
  /** The runtime the snippet targets. Derived from `result.binary.name`
   *  when available, falling back to the recommended default (podman). */
  runtime: RuntimeName;
  /** Whether the snippet uses the rootless invocation shape. */
  rootless: boolean;
  /**
   * The snippet text itself. Compose YAML or full shell command,
   * depending on `format`. No trailing newline.
   */
  snippet: string;
  /**
   * Minimal Dockerfile sidecar showing image-side prereqs (install
   * `podman` / `docker-cli` etc). Empty when not applicable (e.g.
   * Windows where image-baking isn't typically the user's path).
   */
  dockerfile: string;
  /** Operator-facing notes — SELinux, Windows, defensive env vars, etc. */
  notes: string[];
}

export interface PluginConfig {
  runtime: RuntimePreference;
  pruneSchedule: "off" | "weekly" | "monthly";
  maxConcurrentJobs: number;
  updateCheckInterval?: string;
  backgroundUpdateChecks?: boolean;
  /**
   * Per-container user overrides for resource limits, keyed by
   * container name (without `sk-` prefix). Field-level merged on top
   * of the plugin's default. Use `null` to explicitly remove a limit
   * set by the plugin.
   */
  containerOverrides?: Record<string, ContainerResourceLimits>;
  /**
   * Suppress the rootless-Podman `--userns=keep-id` flag for every
   * managed container. Enable on hosts whose backing filesystem
   * cannot be id-mapped by the kernel — ZFS is the common case (the
   * idmapped-mounts feature is filesystem-specific and arrived in
   * recent kernels only). Symptom without this flag:
   * `crun: writing file /proc/<pid>/gid_map: Invalid argument` at
   * container create time.
   *
   * With the flag active, containers run in the default rootless
   * userns. For root-by-default images (most managed containers:
   * questdb, grafana, mayara) bind-mount file ownership still lands
   * on the host caller because in-image UID 0 maps to the host
   * caller's UID under the default rootless mapping. Non-root images
   * (e.g. `charts-toolbox`'s `USER toolbox`) trade host-caller
   * ownership for the ability to start at all.
   *
   * Default: `false` (historical keep-id behaviour preserved).
   */
  disableUserNamespaceRemap?: boolean;
}

/**
 * Result of an updateResources() call. `live` means cgroup limits
 * were applied without restart; `recreated` means we fell back to
 * stop+remove+create because the runtime refused the live update.
 */
export interface UpdateResourcesResult {
  method: "live" | "recreated";
  warnings?: string[];
}

/**
 * Outcome of resolving a `ContainerConfig` to a concrete pull
 * reference. The wrapper uses `pullSpec` to feed the runtime and
 * `resolvedDigest` to record into the consumer manifest.
 */
export interface ResolveResult {
  /** Exact reference handed to `pullImage` / `imageExists`. */
  pullSpec: string;
  /**
   * Manifest digest of the image now satisfying the request, in the
   * form `sha256:<hex>`. For locally-built images that have no
   * RepoDigests, takes the synthetic form `local:<image-id>`.
   */
  resolvedDigest: string;
  /** Where the digest came from. */
  source: "declared" | "resolved-from-tag";
}

/**
 * Read-only access to per-plugin image-pinning manifests exposed to
 * consumer plugins via `manager.manifest.*`. Writes happen only as a
 * side effect of successful `ensureRunning` calls.
 */
export interface ManifestApi {
  /**
   * Return the manifest for a specific consumer plugin, or `null` if
   * no manifest exists yet. Read-only — writes happen automatically
   * after successful `ensureRunning` calls.
   *
   * Throws if `pluginId` is not an npm package name, a `@scope/name`
   * scoped form, or the synthetic `container:<name>` fallback.
   */
  get(pluginId: string): Promise<ConsumerManifest | null>;
  /**
   * Return every persisted manifest in the data directory. Order is
   * unspecified.
   */
  list(): Promise<ConsumerManifest[]>;
  /**
   * Return the bounded history (max 20 entries) of digest changes
   * for a specific container, regardless of which plugin owns it.
   *
   * Throws an "Ambiguous container history" error if more than one
   * manifest contains an entry for the same `containerName` — the
   * caller should disambiguate via `manifest.get(pluginId)`.
   */
  getContainerHistory(containerName: string): Promise<HistoryEntry[]>;
}

// Persistent manifest types are defined as TypeBox schemas in
// src/manifest/schema.ts (single source of truth for the on-disk
// shape); re-exported here so consumer plugins can import every
// manifest type from "signalk-container/types". The import lives at
// the top of the file with the other type imports.
export type { ConsumerManifest, ContainerManifestEntry, HistoryEntry };
