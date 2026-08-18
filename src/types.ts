import type {
  DockerHubTagsSourceOptions,
  GithubReleasesSourceOptions,
  TagKind,
  UpdateCheckResult,
  UpdateReason,
  UpdateRegistration,
  UpdateServiceApi,
  VersionSource,
  VersionSourceResult,
} from "./updates/types.js";

export type RuntimeName = "podman" | "docker";

/**
 * Named CPU priority tiers, highest first. Each maps to a `--cpu-shares`
 * value in `CPU_PRIORITY_SHARES` (configNormalize.ts); `normal` is no
 * request at all.
 */
export type CpuPriority = "high" | "normal" | "low" | "lowest";
export type RuntimePreference = "auto" | RuntimeName;

export interface ContainerRuntimeInfo {
  runtime: RuntimeName;
  version: string;
  /**
   * @deprecated Always `false` since the move to the dockerode socket
   * client. The "docker CLI is really a podman shim" distinction only
   * mattered when we spawned a CLI that client-validated flags; over
   * the API socket there is one wire protocol and no client-side
   * validation to route around. Retained for one release to avoid a
   * breaking type change for any consumer reading it; will be removed.
   */
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
   * CPU count as the daemon reports it (`NCPU` from `/info`). This is the
   * daemon's own view — the podman-machine VM or a remote Docker host, not
   * necessarily the machine signalk-server runs on — which is the number
   * that matters: Docker rejects a container create/update whose `cpus`
   * exceeds it (`range of CPUs is from 0.01 to N.00`). `undefined`/`null`
   * means "not reported" — no clamping is done.
   *
   * Used by `resources.ts` to cap `ContainerResourceLimits.cpus`.
   */
  hostCpus?: number | null;
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
   * Drives the userns/`User` decision in `userMappingFlags`: files
   * created inside a container whose create payload carried
   * `User: "uid:gid"` (docker / rootful podman) or
   * `HostConfig.UsernsMode: "keep-id:uid=N,gid=N"` (rootless podman)
   * end up owned by this same identity on the host, so the plugin
   * doesn't need recursive `chmod` sweeps to make outputs readable by
   * Signal K.
   *
   * `null` on platforms where `process.getuid`/`getgid` are undefined
   * (Windows); callers must not emit a `User` field in that case.
   */
  hostUser?: { uid: number; gid: number } | null;
  /**
   * Path of the unix socket the dockerode client resolved to (e.g.
   * `/var/run/docker.sock` or `/run/user/<uid>/podman/podman.sock`).
   * Diagnostic only — surfaced by the doctor so a "no runtime" report
   * can name which socket paths were tried. The live client itself is
   * the `client.ts` singleton, not stored here, so this struct stays
   * plain and serializable.
   */
  socketPath?: string;
  /**
   * Whether the Signal K server process itself runs inside a container
   * (same detection as the doctor's `isContainerized`). Captured at
   * runtime-detection time because device emission needs it: a
   * containerized manager's filesystem is not the filesystem the runtime
   * resolves device paths against, so `resolveDeviceRequests` treats
   * "path missing locally" differently there (see the optimistic branch
   * in `devices.ts`). `undefined` (older callers, tests) means
   * bare-metal semantics.
   */
  isContainerized?: boolean;
  /**
   * @deprecated Superseded by `socketPath`. Never populated since the
   * dockerode socket port (the `--remote --url` CLI fallback it described
   * no longer exists). Kept as an optional field for one release so
   * consumer plugins reading `ContainerRuntimeInfo` don't break on a
   * removed property; will be removed in the next major.
   */
  remoteSocketUrl?: string;
}

export type ContainerState = "running" | "stopped" | "missing" | "no-runtime";

/**
 * Create-payload fragment that carries the UID-mapping decision from
 * `userMappingFlags` into a dockerode `createContainer` call. Exactly one of
 * the shapes applies per runtime (see `userMappingFlags` for the matrix):
 *   - rootless podman → `{ HostConfig: { UsernsMode: "keep-id:uid=N,gid=N" } }`
 *   - docker / rootful podman → `{ User: "N:N" }`
 *   - opt-out / Windows / disableUserNamespaceRemap → `{}`
 * The fragment is merged into the create options; `HostConfig` here is shallow
 * and the caller deep-merges it with the rest of the container's `HostConfig`.
 */
export interface UserMappingPayload {
  User?: string;
  HostConfig?: { UsernsMode?: string };
}

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
  /**
   * Environment variables for the container. When the host timezone is
   * known and not UTC, `TZ=<zone>` is injected automatically so
   * wall-clock behaviour inside the container matches the host. Set
   * `TZ` yourself (any value, including `""`) to override or opt out.
   */
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
   * The automatic mapping is skipped under a `container:<id>` networkMode —
   * Docker rejects ExtraHosts combined with container netns sharing.
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
   * Host devices to expose to the container. Two entry forms:
   *
   *   - A device NODE path, docker `--device` syntax
   *     `hostPath[:containerPath[:permissions]]` (defaults: containerPath
   *     = hostPath, permissions `rwm`), e.g. `"/dev/ttyUSB0"` or
   *     `"/dev/ttyUSB0:/dev/gps0:rw"`. The node is attached statically at
   *     create time — a node that disappears and reappears (USB replug)
   *     is only picked up on the next recreate.
   *   - A device DIRECTORY path, e.g. `"/dev/snd"` → hot-plug mode: the
   *     directory is bind-mounted at the same in-container path (so nodes
   *     appearing after a replug are visible) and the directory's
   *     device-class cgroup rules are opened (`c <major>:* rwm`, derived
   *     from the nodes currently inside it plus a built-in map of
   *     well-known class majors — `/dev/snd`, `/dev/input`, `/dev/dri` —
   *     so an EMPTY directory still works when the device is unplugged at
   *     container start). Use this for devices that may be replugged
   *     while the container runs: USB audio, input devices, GPUs.
   *
   * An entry whose host path does not exist is skipped and reported
   * through `EnsureRunningOptions.onDeviceIssue` (and logged at warning
   * level by the plugin) — an unplugged device never prevents container
   * start (same philosophy as `ifMissing: "skip"` volumes).
   *
   * On rootless runtimes device-cgroup rules cannot be applied (the
   * device cgroup controller is not delegated to unprivileged users);
   * access to the bound nodes is then governed by plain file
   * permissions — combine with `groupAdd` to hold the device group
   * (e.g. `groupAdd: ["audio"]` for `/dev/snd`).
   *
   * Part of drift detection: adding, removing, or changing entries
   * recreates the container. (Podman does not report device nodes back
   * through inspect, so node-entry changes there are detected against
   * the prior config within a server lifetime; directory entries are
   * always detected via their bind mounts.)
   *
   * Available in signalk-container 1.24.0+ — silently ignored by older
   * versions.
   */
  devices?: string[];
  /**
   * Supplementary groups for the container process (`--group-add`),
   * mapped to `HostConfig.GroupAdd`. Entries are group names or numeric
   * GIDs. Names are resolved to numeric GIDs against the HOST's
   * `/etc/group` at create time: the runtimes resolve a bare name
   * against the container image's `/etc/group`, whose GIDs need not
   * match the host's (or contain the name at all), and it is the host
   * GID the kernel checks when the process opens a host device node.
   * A name unknown to the host is skipped and reported through
   * `EnsureRunningOptions.onDeviceIssue` as a `group-skipped` event (and
   * logged at warning level by the plugin); numeric entries pass through.
   *
   * On rootless Podman the resolved GIDs alone can't grant host device
   * access (they map into the user namespace's subordinate range), so
   * signalk-container additionally emits the
   * `run.oci.keep_original_groups` annotation — the container process
   * then keeps the host user's own supplementary groups. This makes
   * `groupAdd: ["audio"]` + `devices: ["/dev/snd"]` work across docker,
   * rootful podman, and rootless podman alike, provided the user running
   * the runtime is in the group. Docker never receives the annotation.
   *
   * Part of drift detection: changes (including unsetting) recreate the
   * container.
   *
   * Available in signalk-container 1.24.0+ — silently ignored by older
   * versions.
   */
  groupAdd?: (string | number)[];
  /**
   * Resource limits for the container. The consumer plugin sets a
   * sensible default here; the user can override per-container via
   * signalk-container's plugin config (see `containerOverrides`).
   * The user override is field-level merged on top of the plugin
   * default — set a field to `null` to explicitly remove the limit.
   */
  resources?: ContainerResourceLimits;
  /**
   * Per-process resource limits (`ulimit`) for the container, mapped to
   * `HostConfig.Ulimits`. Keys are ulimit names (`nofile`, `nproc`,
   * `memlock`, …); values set the soft and hard limit.
   *
   * The motivating case is `nofile`: a process inside a rootless-Podman
   * container inherits its open-files limit from the container runtime,
   * NOT from the host's `fs.file-max` sysctl. QuestDB needs a high
   * `nofile` (it recommends 1048576) and otherwise logs an open-files
   * warning and risks WAL corruption under heavy ingestion — raising the
   * host `fs.file-max` alone does not fix it. Setting it here pins the
   * limit on the container regardless of the host login configuration.
   *
   * A number sets soft = hard. `{ soft, hard }` sets them independently.
   *
   * Example:
   *   `ulimits: { nofile: 1048576 }`
   *   `ulimits: { nofile: { soft: 1048576, hard: 1048576 } }`
   *
   * `nofile` is automatically clamped to what the host can actually grant
   * (a rootless container cannot exceed the calling user's hard limit, and
   * a higher request makes the runtime refuse to start the container); the
   * clamp is logged. Values must be non-negative integers with `hard >=
   * soft` — an invalid limit throws at `ensureRunning` time.
   *
   * Known runtime gap: rootless podman < 5.5.0 silently DROPS the ulimit
   * request sent over the docker-compat API (containers/podman#25881,
   * fixed by #25908) — the container instead inherits the podman
   * service's own limits. On such hosts the effective lever is the limit
   * of the systemd user manager that parents the podman service; the
   * `nofile` regrant in `ensureRunning` still converges the container
   * onto whatever that allows.
   *
   * Not part of drift detection — like `labels`/`healthcheck`, changing a
   * ulimit does not recreate a running container; it takes effect on the
   * next recreate for another reason or a clean start. One targeted
   * exception: `nofile` is live-probed on every `ensureRunning`, and when
   * the host ceiling has been RAISED since the container was created (so
   * more of the request has become grantable than the container runs
   * with), the container is recreated to apply it — that is an operator
   * completing the documented "raise the host limit" fix, not a config
   * edit, and without the recreate the raise could never take effect.
   */
  ulimits?: Record<string, number | { soft: number; hard: number }>;
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
  /**
   * Soft CPU weight under contention (`--cpu-shares`). Ranks the
   * container against its cgroup siblings only. The OCI runtime maps
   * shares to cgroup v2 `cpu.weight` and the mapping differs (crun and
   * runc < 1.3.2: 1024 → 39; runc ≥ 1.3.2: 1024 → 100); unset is 100
   * everywhere. Prefer the named tiers in `CPU_PRIORITY_SHARES`
   * (configNormalize.ts) over raw numbers.
   */
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
  /** Full container name as the runtime sees it, e.g. `sk-questdb`. */
  name: string;
  /**
   * `name` with the active namespace prefix removed, e.g. `questdb`. This is
   * the form consumer plugins pass to `ensureRunning`/`getResources` and the
   * key `containerOverrides` uses. Supplied by the server so callers never
   * have to know the prefix (which varies with `SIGNALK_CONTAINER_NAMESPACE`).
   */
  unprefixedName: string;
  image: string;
  state: ContainerState;
  created: string;
  ports: string[];
  managedBy: string;
}

export interface ContainerJobConfig {
  image: string;
  command: string[];
  /**
   * Override the image's baked `ENTRYPOINT`. When omitted, `command` runs as
   * arguments to whatever entrypoint the image declares. Set this when reusing
   * an application image as a generic helper — e.g. `["sh", "-c"]` so a shell
   * `command` runs directly instead of being passed to the app's entrypoint.
   */
  entrypoint?: string[];
  inputs?: Record<string, string>;
  outputs?: Record<string, string>;
  /**
   * Environment variables for the job container. `TZ` defaults to the
   * host timezone the same way it does for `ContainerConfig.env`.
   */
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
  /**
   * Cancel a job that is already running. When the signal aborts, runJob
   * force-removes the job container, which unblocks the in-flight wait;
   * the job then resolves with `status: "cancelled"`. A signal that is
   * already aborted when runJob is called returns `cancelled` without
   * creating a container. A job that finishes on its own is unaffected —
   * a later abort is a harmless no-op.
   *
   * The boundary-level alternative (the caller stops dispatching new jobs)
   * cannot interrupt a long single step such as a tile-join; this is the
   * mechanism that can.
   */
  signal?: AbortSignal;
}

export type ContainerJobStatus =
  "pending" | "pulling" | "running" | "completed" | "failed" | "cancelled";

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
 * A managed image repo and the image-ID the container is currently
 * running, fed to the reaper so it can keep the live version and only
 * remove superseded ones. `runningImageId` is null when the container
 * is missing or its image can't be resolved — the reaper then keeps
 * every version of that repo (it has no anchor to reap safely against).
 */
export interface ManagedImageRef {
  /** Registered image repo without a tag, e.g. "ghcr.io/dirkwa/foo". */
  image: string;
  /** Immutable image-ID of the running container, or null if unknown. */
  runningImageId: string | null;
}

/**
 * The subset of a dockerode image summary the reaper reasons over.
 * Flat by design so the pure selection function is testable without
 * dockerode types — the boundary maps `ImageInfo` into this shape.
 */
export interface LocalImageSummary {
  id: string;
  /** Fully-qualified `repo:tag` strings; empty for dangling/local builds. */
  repoTags: string[];
  /** Unix seconds; tie-breaker and fallback ordering for non-semver tags. */
  created: number;
  size: number;
  /**
   * >0 when some container (running or stopped) references this image.
   * Derived by the executor from the container list — not the unreliable
   * `Containers` field of a listImages summary, which Docker leaves as -1.
   */
  inUseCount: number;
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

/**
 * One device-passthrough event delivered to
 * `EnsureRunningOptions.onDeviceIssue`. Same callback contract as
 * `VolumeIssue`; switch on `action` to dispatch.
 */
export interface DeviceIssue {
  /**
   * The original entry string: a `ContainerConfig.devices` entry for the
   * device actions, or the `ContainerConfig.groupAdd` group name for
   * `'group-skipped'`.
   */
  entry: string;
  /**
   * Canonical host path the entry parsed to. Empty string for
   * `'group-skipped'`, which concerns a supplementary group, not a path.
   */
  hostPath: string;
  /**
   * What signalk-container did about this entry:
   *   - `'skipped'`: the host path was missing (probe-visible) at create
   *     time; the entry was dropped and the container starts without it.
   *   - `'optimistic'`: the manager runs containerized and could not see
   *     the path locally; the entry was emitted unverified for the
   *     runtime to resolve against the real host.
   *   - `'unresolved'`: an optimistic entry was rejected by the runtime —
   *     the path is missing on the real host too. The container was
   *     recreated without it and carries `DEVICES_UNRESOLVED_LABEL`; the
   *     entry is retried on the next recreate (or as soon as the manager
   *     can see the path). Fires at create time and again on every
   *     reconcile of a container still carrying the label, so state
   *     survives Signal K restarts.
   *   - `'group-skipped'`: a `groupAdd` group name did not resolve against
   *     the host's `/etc/group`; it was dropped from the emitted
   *     supplementary groups and the container starts without it.
   */
  action: "skipped" | "optimistic" | "unresolved" | "group-skipped";
  /** Human-readable explanation; safe to surface in `setPluginStatus`. */
  reason: string;
}

/**
 * Event delivered to `EnsureRunningOptions.onUlimitClamped` when a
 * requested ulimit could not be granted as asked. Currently only `nofile`
 * is affected: a create-time clamp lowers an over-request to the host
 * ceiling, and a start-time rejection makes `ensureRunning` retry once
 * without the ask, leaving the container on the runtime's default limits
 * (`granted` reports what it ended up with; `0` = unknown). The container
 * is running either way — this is an advisory, not a failure.
 */
export interface UlimitClamp {
  /** The ulimit that was clamped, e.g. `"nofile"`. */
  ulimit: string;
  /** The value the consumer requested. */
  requested: number;
  /**
   * The observed effective hard limit the container runs with. A
   * create-time clamp reports the host ceiling; the rejected-`nofile`
   * fallback reports the runtime default it landed on, which can be lower
   * still. `0` means the effective limit could not be read (e.g. podman
   * machine on macOS, where the limits live inside the VM): treat it as
   * unknown rather than a grant of zero, and surface `reason`, which
   * always carries the full story.
   */
  granted: number;
  /** Human-readable explanation; safe to surface in `setPluginStatus`. */
  reason: string;
}

/**
 * Event delivered to `EnsureRunningOptions.onResourceClamped` when a
 * requested resource limit was lowered to what the daemon can grant.
 * Currently only `cpus`: a request above the daemon's CPU count is capped
 * to that count, because Docker refuses to create or update a container
 * whose `cpus` exceeds it (podman accepts the value, but a cap above the
 * core count is meaningless there too). The container runs with `granted`
 * — this is an advisory, not a failure.
 */
export interface ResourceClamp {
  /** The `ContainerResourceLimits` field that was clamped, e.g. `"cpus"`. */
  resource: "cpus";
  /** The value the consumer (or a user override) requested. */
  requested: number;
  /** The value the container was actually given. */
  granted: number;
  /** Human-readable explanation; safe to surface in `setPluginStatus`. */
  reason: string;
}

/**
 * Event delivered to `EnsureRunningOptions.onContainerWedged` when a recreate
 * is needed — for config drift, floating-tag digest drift, or a nofile
 * regrant — but the runtime cannot stop or remove the live container (a
 * permission error), so the recreate is deferred. `drift` names whichever
 * change prompted it.
 *
 * Two causes, both needing operator action no API call can perform; the
 * `reason` string is tailored to the one that occurred:
 *   - "operation not permitted" (EPERM) on **rootless Podman** — almost
 *     always an orphaned user namespace (the container's userns belongs to
 *     a previous "pause" session after a Podman service restart); `podman
 *     system migrate` recovers it. On Docker or rootful Podman the same text
 *     is treated as a generic permission problem, not a userns wedge.
 *   - "permission denied" (EACCES), or EPERM on a non-rootless-Podman
 *     runtime — the API socket or a mount the removal touches is not
 *     writable by this user; a host-side permission problem.
 *
 * When the container has a host bind mount, `reason` also notes that a
 * force-remove + recreate does not touch that data. (Only bind mounts and
 * named volumes survive a recreate — the writable layer does not — so the
 * note is added only when a bind mount is actually configured.)
 *
 * Fired once per wedge (not on every reconcile) so a consumer can surface
 * it via `setPluginError` with the remedy instead of the operator seeing
 * only a silent drift loop in the logs.
 */
export interface ContainerWedged {
  /** Managed name as passed to `ensureRunning` (before the `sk-` namespace
   * prefix), e.g. `"questdb"`. */
  name: string;
  /** What prompted the recreate, e.g. `"networkMode"`, `"env"`, a digest
   * change, or `"nofile N → M"`. */
  drift: string;
  /** Human-readable explanation with remediation; safe for `setPluginError`. */
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
   * Called once per ulimit that signalk-container had to clamp during
   * this `ensureRunning` call (currently only `nofile`). The container
   * still starts — with the `granted` value — so this is an advisory the
   * plugin can surface (e.g. `app.setPluginStatus` or a config-panel
   * banner) to tell the operator the host limit is the bottleneck and how
   * to lift it.
   *
   * Same handler contract as `onVolumeIssue`: sync or async, fire-and-
   * forget, errors caught and logged at error level, kept off the
   * lifecycle path otherwise.
   */
  onUlimitClamped?: (event: UlimitClamp) => void | Promise<void>;

  /**
   * Called once per resource limit that signalk-container had to lower to
   * what the daemon can grant during this `ensureRunning` call (currently
   * only `cpus`, capped to the daemon's CPU count). The container runs
   * with the `granted` value, so this is an advisory the plugin can
   * surface the same way as `onUlimitClamped`. Same handler contract:
   * sync or async, fire-and-forget, errors caught and logged.
   */
  onResourceClamped?: (event: ResourceClamp) => void | Promise<void>;

  /**
   * Called when a drift-driven recreate is deferred because the runtime
   * cannot stop or remove the live container ("operation not permitted",
   * typically an orphaned rootless user namespace after a Podman service
   * restart). Fired once per wedge, not on every reconcile. The container
   * cannot be recovered from the API — the event's `reason` names the
   * remedy — so a consumer should surface it via `setPluginError`. Same
   * fire-and-forget handler contract as `onUlimitClamped`.
   */
  onContainerWedged?: (event: ContainerWedged) => void | Promise<void>;

  /**
   * Called once per device entry that hit a passthrough event during
   * this `ensureRunning` call — see `DeviceIssue.action` for the three
   * dispositions. `'skipped'`/`'optimistic'` fire only when the call
   * actually creates a container; `'unresolved'` additionally re-fires
   * on reconciles of a live container carrying
   * `DEVICES_UNRESOLVED_LABEL`.
   *
   * Same handler contract as `onVolumeIssue`: sync or async, fire-and-
   * forget, errors caught and logged at error level, kept off the
   * lifecycle path otherwise.
   */
  onDeviceIssue?: (event: DeviceIssue) => void | Promise<void>;

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

/** The nofile (`RLIMIT_NOFILE`) limits a process runs with. `Infinity` = unlimited. */
export interface NofileLimits {
  soft: number;
  hard: number;
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
  /**
   * Remove a managed container AND delete its bind-mount data directory,
   * correctly handling the rootless-Podman ownership trap.
   *
   * Use this for plugin teardown / uninstall cleanup. A plain
   * `fs.rmSync(dataDir)` from the Signal K process (host uid, e.g. 1000)
   * fails with EACCES when a rootless-Podman container wrote its data as a
   * NON-root in-container uid. Under the userns mapping, a non-zero
   * in-container uid lands in the host's subordinate-uid range (e.g. 110000),
   * which the host user cannot delete. This is common: many images start as
   * root but drop to a service user before writing — QuestDB, for instance,
   * runs as root only to `chown` then `gosu`-drops to its own uid, so its
   * data files are subuid-owned. (Files written as in-container root map back
   * to the host user and would delete fine; it's the dropped-privilege writes
   * that get trapped.) Verified live on rootless Podman 5.4.2. Stopping the
   * container first does not help — it is file ownership, not a held mount.
   *
   * What it does:
   *   1. Stops + removes the container `name` (idempotent — a
   *      missing container is not an error).
   *   2. Tries a direct host-side recursive delete of `hostPath`. On
   *      docker / rootful Podman the files are host-owned and this is all
   *      that runs.
   *   3. On EACCES/EPERM (the rootless-Podman subuid case) it runs a
   *      one-shot helper container under the default userns mapping (so
   *      it runs as in-container root, which owns the subuid files),
   *      bind-mounts `hostPath`, and `rm -rf`s its contents from inside
   *      the userns. The now-empty host-owned parent dir is then removed
   *      host-side.
   *
   * Helper-image choice: the helper reuses the **container's own image**,
   * captured by inspecting it before removal. That image is already on
   * disk (the container was just running it), so cleanup never triggers a
   * registry pull — important on an offline boat. The one case the
   * in-userns fallback can't cover is a container that was already gone
   * AND a dir the host user can't delete: there is then no known image to
   * run, so the call throws asking the operator to delete the dir manually
   * rather than silently leaving data behind.
   *
   * Path safety: refuses to operate on an empty path or a filesystem root.
   * Pass an absolute path under the Signal K data tree
   * (`app.getDataDirPath()` or below).
   *
   * Errors: never reports success while data remains. If the in-userns
   * wipe also fails, the rejection carries the runtime reason so the
   * caller can surface it.
   *
   * Available in signalk-container 1.18.0+.
   *
   * @param name      Managed container name (without the `sk-` prefix).
   * @param hostPath  Absolute host path of the bind-mount data to delete.
   * @param options   `ownerPluginId` labels the cleanup helper job so a
   *                  crash mid-wipe can be reaped by `cleanupOrphanedJobs`.
   */
  removeManagedData(
    name: string,
    hostPath: string,
    options?: { ownerPluginId?: string },
  ): Promise<void>;
  getState(name: string): Promise<ContainerState>;
  /**
   * Read the nofile (`RLIMIT_NOFILE`) limits a managed container is
   * ACTUALLY running with — as opposed to the value requested at create
   * time, which may have been clamped to the host ceiling.
   *
   * Primary source is the kernel's live `/proc/<container-pid>/limits`
   * (readable under bare-metal Signal K + rootless Podman); falls back to
   * the create-time `HostConfig.Ulimits` echoed by inspect, which equals
   * the live value whenever present. Returns null when the container does
   * not exist or neither source is available (e.g. containerized Signal K
   * without pid-namespace access) — treat null as "unknown", never as a
   * limit.
   *
   * Use this to verify whether a previously reported ulimit clamp still
   * reflects reality — e.g. clear a "capped by the host" advisory once
   * the container actually runs with the full requested limit.
   *
   * Available in signalk-container 1.25.3+.
   */
  getContainerNofile(name: string): Promise<NofileLimits | null>;
  /**
   * Run a one-shot helper container to completion, streaming its output
   * via the `onProgress`/`onStdoutLine`/`onStderrLine` callbacks and
   * resolving with the exit status.
   *
   * Pass `config.signal` (an `AbortSignal`) to cancel a job mid-flight:
   * aborting force-removes the running container and resolves with
   * `status: "cancelled"`. This is the only way to interrupt a long
   * single step (e.g. a tile-join); boundary-level cancellation in the
   * caller cannot. Available in signalk-container >= 1.16.0.
   */
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
  updates: UpdateServiceApi;
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

/**
 * Host platforms the doctor recognises from markers visible inside the
 * Signal K process. Recognition drives platform-specific remediation text
 * (a step-by-step guide for that platform's packaging) and never affects
 * `status`.
 *
 * - `halos` — HaLOS (Hat Labs OS). Its `signalk-server` container app
 *   bind-mounts the host `/run` into the Signal K container, so the
 *   `/run/halos/` directory published by halos-core-containers is visible.
 */
export type HostPlatform = "halos";

export interface SelfDeploymentResult {
  /** True when /.dockerenv, /run/.containerenv, or `$container` is set. */
  isContainerized: boolean;
  /**
   * Recognised host platform, or `null` when no marker matched. Optional
   * because payloads from older servers omit it entirely; renderers and the
   * boundary validator treat absent as `null`.
   */
  platform?: HostPlatform | null;
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
   * the host hasn't delegated; today that's `["cpu", "memory", "pids"]`
   * minus whatever's in `available`. `cpuset` is intentionally NOT
   * required — rootless Podman never delegates it to the user slice, so
   * requiring it would false-positive on every healthy rootless host;
   * `cpusetCpus` is instead dropped per-field by `filterUnsupportedLimits`
   * when the controller is absent. When `isContainerized` is true AND
   * `missing` is non-empty, `status` escalates to
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
    /**
     * Rootless storage root that was probed. On bare-metal Signal K the
     * daemon-reported graphroot (honors `storage.conf` overrides) wins
     * over the XDG-derived default path. When Signal K is containerized
     * the daemon's host path is in a foreign mount namespace, so only
     * the XDG-derived (same-namespace) path is probed. The enclosing
     * `containerStorage` value is `null` when no path is available.
     */
    storagePath: string | null;
    /** Filesystem type as reported by `/proc/mounts`, or `null` if unknown. */
    fstype: string | null;
    /** True when `fstype` is in the "may cause `--userns=keep-id` trouble" set. */
    idmapHazard: boolean;
    /** Operator-facing remediation; empty when `idmapHazard` is false. */
    advice: string[];
  } | null;
  /**
   * systemd linger state for the user owning the rootless runtime.
   * Probed only when the daemon is reachable AND rootless — rootless
   * Podman and rootless Docker both live inside the user's systemd
   * instance, which without linger only runs while that user is logged
   * in: on a headless host nothing starts the runtime socket (or
   * containers with a restart policy) at boot. Rootful runtimes are
   * system services and never need linger. Advisory only — does not
   * escalate `status`.
   *
   * `null` when the probe could not run: rootful runtime, the linger
   * directory was unreadable, or Signal K is containerized and the
   * host's `/var/lib/systemd/linger` is not bind-mounted in (the
   * default today — the probe sees nothing rather than guessing).
   */
  linger: {
    /**
     * Host username whose linger file was checked. `null` when SK is
     * containerized (the in-container username says nothing about the
     * host user) — `enabled` then falls back to "any linger entry
     * exists", which is exact on single-user hosts.
     */
    user: string | null;
    /** See `user` for the matching rule. */
    enabled: boolean;
    /** Operator-facing remediation; empty when `enabled` is true. */
    advice: string[];
  } | null;
  /**
   * Device-passthrough state of the managed containers. Unlike the other
   * sections this is NOT probed by `selfDeployment` itself — it is
   * grafted in by the plugin API layer from the `DeviceIssue` events of
   * the most recent `ensureRunning` calls (the doctor probe has no view
   * into per-container config). Advisory only — does not escalate
   * `status`. `null`/absent when no managed container reported a device
   * issue, or when the probe ran outside the plugin API (stub doctor,
   * unit tests, pre-start, payloads from older servers).
   */
  devicePassthrough?: {
    issues: Array<{
      /** Unprefixed managed-container name (the `ensureRunning` name). */
      container: string;
      entry: string;
      hostPath: string;
      action: "skipped" | "optimistic" | "unresolved" | "group-skipped";
      reason: string;
    }>;
    /** Operator-facing remediation lines (mount/plug-in guidance). */
    advice: string[];
  } | null;
  /**
   * DNS helper state for Podman's netavark network backend. Probed only
   * when the daemon is reachable AND the runtime is Podman, via the
   * libpod `/info` endpoint (the docker-compat `/info` doesn't expose
   * `networkBackendInfo`). Advisory only — does not escalate `status`.
   *
   * On Debian-family hosts aardvark-dns is only a Recommends of
   * netavark, and recommends-off installs (Armbian is the canonical
   * case) end up with netavark but no DNS helper: containers on
   * user-defined networks get the bridge gateway as nameserver with
   * nothing listening on :53, so every lookup fails with "connection
   * refused" while the default `podman` network (DNS disabled, host
   * resolv.conf) keeps working — which makes the breakage look
   * plugin-specific rather than host-wide.
   *
   * `null` when the probe could not run: Docker runtime, unreachable
   * daemon, a Podman old enough to not report `networkBackendInfo`
   * (pre-4.0 / CNI), or the libpod endpoint failing.
   */
  networkDns: {
    /** Network backend name from libpod info ("netavark", "cni"). */
    backend: string | null;
    /** Resolved aardvark-dns path; null when the helper is missing. */
    helperPath: string | null;
    /** True when the backend is netavark and no DNS helper was resolved. */
    dnsBroken: boolean;
    /** Operator-facing remediation; empty when `dnsBroken` is false. */
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
  /**
   * Prior versions of managed-container images to keep, in addition to
   * the running one, when the scheduled prune runs. 0 keeps only the
   * running image. Only superseded versions of images belonging to
   * managed containers are touched — never unrelated images, the
   * running image, or any image in use by a container. Shares the
   * `pruneSchedule` cadence, so it does not run when that is "off".
   */
  keepImageVersions?: number;
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
   * CPU priority tier applied to every managed container underneath
   * the consumer plugin's own `resources` and the user's
   * `containerOverrides` (both win field-by-field). Expressed as
   * `cpuShares` — see `CPU_PRIORITY_SHARES`. Default `normal` (no
   * request).
   */
  containerCpuPriority?: CpuPriority;
  /**
   * CPU priority tier applied to every `runJob` container underneath
   * the caller's `resources`. Default `lowest`, so one-shot helpers
   * (chart imports, GDAL) yield to the long-running services when
   * they contend for CPU.
   */
  jobCpuPriority?: CpuPriority;
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
  /**
   * Emit SignalK notifications (`notifications.container.*`) for managed-
   * container degradation: an unhealthy container, a device the host
   * rejected, a required volume whose source is missing, and a degraded
   * container-runtime deployment. Severity is `warn` (or `alert` for a
   * missing required volume) — visual only, never an audible alarm. The
   * notifications supplement the existing plugin-status / log / consumer-
   * callback surfacing; they do not replace it. Requires a SignalK server
   * that exposes the managed-notification API (≥ 2.30.0); on older servers
   * the setting has no effect.
   *
   * Default: `true`.
   */
  emitDegradationNotifications?: boolean;
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

// Persistent manifest types. These are hand-written here — the public
// type home — rather than derived from the TypeBox schemas in
// src/manifest/schema.ts, so that importing "signalk-container/types"
// pulls in no `typebox` dependency. schema.ts imports these interfaces
// and asserts (at compile time) that its `Static<>` shapes stay
// structurally identical, so the two can never silently diverge: the
// schema is the runtime validator, this is the compile-time contract.

/** Why a manifest history entry was recorded. */
export type ManifestHistoryReason =
  | "plugin-install"
  | "plugin-update"
  | "user-pull"
  | "auto-update"
  | "manual-check";

/** One image-resolution event in a container's manifest history. */
export interface HistoryEntry {
  /** ISO-8601 timestamp of the resolution event. */
  ts: string;
  /** Prior resolved digest (`sha256:`/`local:`), or null on first record. */
  from: string | null;
  /** New resolved digest (`sha256:`/`local:`). */
  to: string;
  /** What caused this record — install, update, user pull, etc. */
  reason: ManifestHistoryReason;
  /** Plugin version that triggered the record, when known. */
  triggeredBy?: string;
}

/** A single managed container's pinning record within a manifest. */
export interface ContainerManifestEntry {
  /** Image repository the container was resolved from, without tag. */
  image: string;
  /** Tag the consumer plugin declared (before digest resolution). */
  declaredTag: string;
  /** Declared digest (`sha256:`), or null when only a tag was pinned. */
  declaredDigest: string | null;
  /** Resolved digest (`sha256:` or the `local:<image-id>` fallback). */
  resolvedDigest: string;
  /** ISO-8601 timestamp of the resolution. */
  resolvedAt: string;
  /** Update channel in effect (e.g. `tag:latest`, `digest:explicit`). */
  updateChannel: string;
  /** Chronological resolution history, oldest first. */
  history: HistoryEntry[];
}

/** Per-plugin image-pinning manifest persisted on disk. */
export interface ConsumerManifest {
  /** On-disk schema version; always `1` for this shape. */
  schemaVersion: 1;
  /** Owning plugin's id (npm package name). */
  pluginId: string;
  /** Plugin version that last wrote this manifest. */
  pluginVersion: string;
  /** ISO-8601 timestamp of first registration. */
  registeredAt: string;
  /** Per-container pinning records, keyed by unprefixed container name. */
  containers: Record<string, ContainerManifestEntry>;
}

// Update-service types live in ./updates/types.ts but are reachable through
// the public API (`ContainerManagerApi.updates`), so re-export them here —
// otherwise a consumer importing "signalk-container/types" can use the
// `updates` member but cannot name its parameter/result types.
export type {
  UpdateServiceApi,
  UpdateRegistration,
  UpdateCheckResult,
  UpdateReason,
  VersionSource,
  VersionSourceResult,
  TagKind,
  GithubReleasesSourceOptions,
  DockerHubTagsSourceOptions,
};
