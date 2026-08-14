# signalk-container

Shared container runtime management (Podman/Docker) for Signal K plugins. This plugin runs _inside_ the Signal K server and exposes a cross-plugin API at `globalThis.__signalk_containerManager` so other plugins (questdb, grafana, mayara, etc.) can manage their own containers without each implementing their own dockerode integration.

Key components:

- **`src/index.ts`** — Signal K plugin entrypoint. Wires the runtime probe, exposes the `ContainerManagerApi` on `globalThis`, owns the REST endpoints (`/plugins/signalk-container/api/...`) and the React config panel mount.
- **`src/client.ts`** — The dockerode socket client. Owns socket selection (`resolveClient`), the shared `Docker` singleton (`getClient`), the `ContainerClient` injection interface, the `safe()`/`safeInspect()` error-normalizing wrappers, and the log-stream demux helpers. Every runtime call in the plugin goes through here.
- **`src/containers.ts`** — Thin runtime layer over the dockerode `ContainerClient` for lifecycle (`ensureRunning`, `removeContainer`, `getContainerState`), config-drift detection (`getLiveContainerConfig`, `diffContainerConfig`), and live-state probes (`getLiveResources`, `getActualPortBindings`).
- **`src/jobs.ts`** — One-shot helper containers via `runJob`. Used by chart-provider and similar plugins that need short-lived workers (GDAL, tippecanoe, etc.).
- **`src/resources.ts`** — cgroup-limit flag emission + live-update path via `podman/docker update`. The "Bug D" precedent for diff-on-already-running lives here.
- **`src/runtime.ts`** — Runtime detection over the socket (`detectRuntime` resolves a socket via `client.ts`, classifies `podman` vs `docker` from `version()`, reads `isRootless`/`cgroupControllers`), the `userMappingFlags` UID-mapping decision matrix, and `isContainerized()` self-detection.
- **`src/updates/`** — Centralized image-update detection (digest drift for floating tags, version comparison for semver). Used by all consumer plugins via `containers.updates.register(...)`.
- **`src/configpanel/`** — React config panel source. Built with Vite + `@module-federation/vite` (see `vite.config.ts`); build artifacts land in `public/`, served via Module Federation into the Signal K Admin UI.

## Code Quality Principles

### Scope and Complexity

Follow YAGNI, SOLID, DRY, and KISS. Only make changes that are directly requested or clearly necessary. A bug fix does not need surrounding code cleaned up. A simple feature does not need extra configurability.

Do not add error handling, fallbacks, or validation for scenarios that cannot happen. Trust internal code and framework guarantees. Only validate at system boundaries (user input from the config panel, runtime command output, REST request bodies).

### General Standards

- Self-documenting code; comments explain _why_, not _what_ — no echo comments restating what the code already says.
- Documentation describes current state, not development history. Avoid "previously this did X" or "added in PR #N" in source comments — that information belongs in git, not in the code.
- No magic numbers; use named constants. The `FIELDS_THAT_CANNOT_LIVE_UNSET` set in `src/resources.ts` is the canonical example.

### Type Safety

- **All new code in TypeScript.** No new `.js` source files.
- Reuse types from `src/types.ts` rather than redefining. `ContainerConfig`, `ContainerRuntimeInfo`, `ContainerResourceLimits`, `LiveContainerConfig`, `PortBinding`, etc. are the public vocabulary — extend them rather than creating parallel shapes.
- Avoid `any` and equivalent escape hatches. The one allowed use is `(globalThis as any).__signalk_containerManager` because the consumer-plugin side cannot import `ContainerManagerApi` without taking a dependency.
- Validate external inputs at system boundaries — runtime command output, REST request bodies, plugin config schema. Internal calls trust their callers.

### Testing

- Test runner is `node:test`. Tests in `src/test/*.ts`, compiled to `dist/test/*.js`. Globs in `package.json` **must** be double-quoted so Windows expands them.
- Unit tests live directly under `src/test/`. Integration tests that need a real container runtime (image pulls, cgroup probes, etc.) live under `src/test/integration/`. The split keeps `npm test` runnable in restricted sandboxes where outbound network access may be unavailable.
- Three scripts:
  - `npm test` — unit only (`dist/test/*.test.js`, no recursion). Safe to run anywhere.
  - `npm run test:integration` — integration only (`dist/test/integration/*.test.js`). Requires podman or docker; tests still self-skip on Windows and when no runtime is found.
  - `npm run test:all` — both. The pre-PR full sweep on a dev box.
- All new code requires tests. Test behavior at the function boundary, not internal control flow.
- Inject `client: ContainerClient = getClient()` rather than calling dockerode directly. Tests stub via `makeMockClient(spec)` from `src/test/helpers/mockClient.ts`. See `src/test/getLiveResources.test.ts` for the canonical pattern: a mock whose `getContainer().inspect()` returns the JSON object under test, no real podman/docker invocations.
- Container-integration tests (those that actually pull `alpine:3.19`) live under `src/test/integration/` and gate on `hasContainerRuntime()` which returns `null` on Windows. Do not add new tests that pull real Linux images without putting them under `src/test/integration/` AND gating on the helper.
- All tests must pass on every commit. Run `npm run build:all:integration` (= `build && test:all`) locally before opening a PR; CI's `npm test` covers the unit half and you cover the integration half.

## Runtime Invariants

These are non-obvious rules baked into the runtime layer. Breaking them produces silent failures or runtime-specific bugs.

### Container-name namespace

Every managed container, one-shot job container, and job label carries a **namespace prefix** so two Signal K servers sharing one container runtime never collide, reap, or drift-recreate each other's containers. The canonical case is a devcontainer dev instance and a production install on the same host, both talking to the same rootless-Podman socket: without a namespace the dev server's `ensureRunning("questdb")` would inspect the production `sk-questdb`, and its job reaper (`cleanupOrphanedJobs`) could force-remove production `sk-job-*` helpers.

- `src/namespace.ts` is the single source of truth. The namespace token defaults to `sk`, so an install that sets no env var produces **the same container names, job names, and label keys** as prior releases: containers `sk-<name>`, jobs `sk-job-<id>`, labels `sk-charts-job` / `sk-job-owner` / `sk-job-label`.
- `setNamespace(process.env.SIGNALK_CONTAINER_NAMESPACE, onInvalid)` runs once in `plugin.start()`, **before** anything creates or reaps a container. `plugin.stop()` calls `resetNamespace()` (mirrors the `setDisableUserns` lifecycle — see below). The value is boundary-validated: 1–32 lowercase alphanumerics; anything else logs via `app.error` and falls back to `sk` so a typo can't crash startup or produce an invalid container name.
- Everything derives from the token via the accessors — `containerPrefix()`, `jobPrefix()`, `jobMarkerLabel()`, `jobOwnerLabel()`, `jobNameLabel()`, `requestedResourcesLabel()`. Never re-hardcode `"sk-"`; `prefixedName()` is the sole place a bare name becomes a container name — call it, never re-implement a `startsWith("sk-")` prefix check.
- The **label keys** are namespaced too (`<ns>-charts-job`, `<ns>-job-owner`, `<ns>-job-label`, `<ns>-requested-resources`), so a dev instance's reap query doesn't even _list_ production's jobs. The name-prefix guard in `orphanFromContainer` (`name.startsWith(jobPrefix())`) remains the unspoofable-by-label trait — and being namespaced, it can never match a foreign-namespace helper.
- The devcontainer sets `SIGNALK_CONTAINER_NAMESPACE=devpod` (in the installer repo's `dev/dev.sh`), so its containers are `devpod-<name>`. Note the prefix isolates **names and reaping**, not host **ports** — a consumer plugin that publishes a fixed host port still collides port-wise with its production twin; that is handled separately (pick non-colliding ports for dev).

### nofile ulimits: rootless podman < 5.5.0 drops the API request

Rootless podman below 5.5.0 silently ignores `HostConfig.Ulimits` on the docker-compat create endpoint (containers/podman#25881, fixed by #25908) — verified live on 5.4.2: the created container inherits the **podman service's** limits and inspect echoes those effective values back as `RLIMIT_NOFILE`, not the request. Three consequences baked into the code:

- `readContainerNofile` treats the inspect echo as "asked" and `/proc/<pid>/limits` as "live"; on broken podman the two sources agree on the effective value, so the probe stays truthful even though the request was dropped.
- The `ensureRunning` nofile regrant bounds recreates two ways: against the previous create's _ask_ (daemon-capped Docker, where re-asking can't help) **and** against a per-observed-limit attempt map (`nofileRegrantAttempts`) — required because on broken podman the echo is not the ask, so the ask-bound alone cannot detect a failed attempt. Never remove either bound in isolation.
- The integration canary `src/test/integration/nofileProbe.test.ts` asserts probe-vs-/proc agreement and stopped-echo consistency on every runtime, and pins the requested value only where the runtime honors the API request (docker, podman ≥ 5.5.0).
- The doctor surfaces this proactively: `PODMAN_MIN_NOFILE_HONORED` (5.5) in `src/doctor.ts` emits `REMEDIATION_OLD_PODMAN_NOFILE` when the runtime is podman AND `rootless === true` AND below the floor. **Advisory only — it never escalates `status`**, matching the storage-driver/linger precedent; a working 5.4 host stays `ok`. It stacks with the `PODMAN_MIN_RECOMMENDED` (4.5, EPIPE) and `PODMAN_MIN_BASELINE` (5.4, supported baseline — Debian 13 "trixie" ships 5.4.2) advisories rather than replacing them, so a 4.3 rootless host reports all three — each names a distinct mechanism. The baseline advisory deliberately carries NO rootless gate (it states support and test coverage, not a rootless-only defect), while the rootless gate on the nofile advisory is load-bearing: rootful podman honours the API request, so warning there would be a false positive.
- When the host outright REJECTS the ask at container start (crun/runc `setrlimit` — classified `ulimit-rejected` in `src/errors.ts`, checked before the `permission` patterns because the raw text contains "operation not permitted"), the `ensureRunning` create path retries ONCE without the nofile entry so the container starts on the runtime's default limits, then emits the clamp advisory with `granted` = the observed live hard limit (0 when no source is readable, e.g. podman machine on macOS where the ceiling probe returns null and the ask went through unclamped). Never loop the retry — the nofile ask is dropped at most once. The fallback shares one retry loop with the optimistic-device fallback: a create can trip both, in either order, and every retry rebuilds from the union of ALL concessions so far (dropped device binds + `DEVICES_UNRESOLVED_LABEL` stamp + dropped nofile ask) — a retry rebuilt from the pristine config would re-introduce something the runtime already refused and fail the start that both fallbacks are intended to save.
- The fallback container carries no nofile entry in its inspect echo, so the regrant reads `asked` from the live limit. Where neither source is readable (macOS) the regrant never fires; elsewhere it may attempt one recreate with the original ask, which fails the same way, re-enters the fallback, and is then bounded by `nofileRegrantAttempts` — do not add a separate attempt map for the fallback, and do not weaken that guard.

### Podman SELinux flag

`volumeArg(hostPath, containerPath, runtime)` adds `:Z` for podman bind mounts (Fedora/RHEL SELinux relabel). Named volumes — host strings without a leading `/` or `.` — MUST NOT receive `:Z`; podman rejects them with `"invalid option z for named volume"`. Always go through `volumeArg`, never build `-v host:container[:flags]` strings inline.

### Volume source policy

`ContainerConfig.volumes` accepts either a bare host-path string (auto-create — the runtime creates the host dir if missing) or `{ source, ifMissing: 'create' | 'skip' | 'abort' }` for per-volume policy. Classification happens in the API wrapper (`src/index.ts`) via `classifyVolumeSources` before `containers.ensureRunning` is called, so the diff and `buildRunArgs` both see the pre-filtered `Record<string, string>` map. The `lastConfigs` cache stores the post-filter shape — drift detection sees consistent state across calls.

`'skip'` and `'abort'` events fire `onVolumeIssue` in the options arg (`EnsureRunningOptions extends HealthCheckOptions`). Recovery events fire when a previously-missing source reappears and the container is recreated to include it; recovery tracking lives in a module-level `lastVolumeIssues: Map<name, ...>` in the wrapper. Handler errors are caught + logged at error level, never propagate.

Named volumes (source without leading `/`) always pass through; `ifMissing` only applies to host paths. `volumeSource()` in `containers.ts` is the single narrower from the union back to bare-string for the two call sites that consume `config.volumes` after classification (`buildRunArgs`, `diffContainerConfig`).

### HOME defaulting for signalkConfigRootMount

When a consumer declares `signalkConfigRootMount` and does not set `env.HOME`, the wrapper in `src/index.ts` injects `HOME=<signalkConfigRootMount>` before forwarding to `containers.ensureRunning`. CLI tools inside the container (kopia, rclone, anything that reads `~/.cache` or `~/.config`) need a writable home directory; the image's baked default (typically `/root` or `/app`) is not writable when docker/rootful-podman starts the container as the host caller's UID. Rootless podman survives an unwritable HOME because the userns remap aliases `/root` to the host caller, but defaulting HOME there too keeps the shape uniform across runtimes and means a consumer plugin doesn't have to know which runtime its user is on.

The injection is in `defaultHomeForConfigRoot()` (`src/containers.ts`) and only fires when the consumer's `env.HOME` is `undefined`. A defined-but-empty `HOME=""` is left alone — that's a deliberate consumer opt-out (tools behave differently with `HOME=""` than unset). Consumers that need HOME to point somewhere _other_ than the config root mount just set it themselves.

### TZ defaulting (host timezone propagation)

Same pattern as HOME defaulting: the wrapper in `src/index.ts` injects `TZ=<host zone>` into `config.env` for both `ensureRunning` (which `recreate` inherits) and `runJob`, via `defaultTimezoneEnv()` in `src/containers.ts`. A consumer-set `env.TZ` — any value, including `""` — always wins. `resolveHostTimezone()` reads the zone via `Intl` (honors the process `TZ` env var, falls back to `/etc/localtime`) and returns `undefined` for UTC-equivalent zones (`UTC_ZONE_NAMES`), so nothing is injected on a UTC host — which is also the in-container deployment where the real host zone is unknowable unless the operator passed it into the SignalK container. Injection happens **before** any other config shaping in the wrapper so the TZ key flows into `lastConfigs` and drift detection like a consumer-set key; do not inject at the `containers.ts`/`buildRunArgs` layer, where the diff would not see it.

### Container log streaming

Two-layer structure (`src/containers.ts` → `src/log-stream-broker.ts`):

1. `tailContainerLogs` (`src/containers.ts`) — calls `getContainer(name).logs({ follow: true, stdout: true, stderr: true, tail: N })` and pipes the stream through `client.modem.demuxStream` into a `makeLineSplitter`-fed `onLine` callback. Containers run without a TTY (the default), so the log stream is **multiplexed** — every stdout/stderr chunk carries an 8-byte frame header; reading raw bytes leaks that header as binary garbage into rendered lines, so demuxing is mandatory. Returns a `StreamingProcessHandle` whose `stop()` calls `stream.destroy()`. The handle's `pid` is always `undefined` (a socket stream has no process); the broker checks `spawnFailed` instead. `getContainerLogs` is the one-shot sibling (`follow: false`) — it ALSO demuxes (the API returns a multiplexed Buffer; the CLI used to pre-demux for us).
2. `LogStreamBroker` (`src/log-stream-broker.ts`) — per-container fan-out. First subscribe opens the tail; last unsubscribe destroys it. On stream end/error with subscribers still attached the broker auto-respawns with exponential backoff (constants `RESPAWN_DELAY_MS` / `MAX_RESPAWN_DELAY_MS`); a delivered line resets the counter. A synchronously-failed tail is detected via `handle.spawnFailed` (NOT `pid === undefined` — dockerode handles never carry a pid). This is what lets SSE-only consumers recover from auto-recreate or daemon glitches without waiting for a fresh subscribe call. Brokers are keyed by container name on the wrapper and auto-recreate cancels the prior subscription before installing a new one.

Consumer surfaces:

- `EnsureRunningOptions.onContainerLog` — plugin authors wire it into `app.debug`.
- `GET /api/containers/:name/logs/stream` — Server-Sent Events. Frames are `data: <line>\n\n`; `event: end` fires on container removal / plugin stop. Heartbeats keep reverse-proxy idle timeouts at bay. Client disconnect unsubscribes and ref-counts the broker down.
- `GET /api/containers/:name/logs?tail=N&since=ts` — one-shot, used by the UI for initial backfill before opening the SSE stream.

Lifecycle:

- `containers.remove(name)` and `plugin.stop()` force-close brokers; SSE clients get a final `event: end` frame.
- `safeInvokeContainerLog` mirrors `safeInvokeVolumeIssue` — sync throws and async rejections from plugin handlers route to `app.error` and never propagate.
- Combined stdout+stderr (matches `podman logs <name>` semantics). Per-stream separation is out of scope for v1.

See `src/client.ts`, `src/containers.ts`, `src/log-stream-broker.ts`, and the tests in `src/test/` for exact timing and lifecycle mechanics.

### Podman image qualification

`qualifyImage("foo/bar:tag", podmanRuntime)` prefixes `docker.io/` when needed (podman requires fully qualified names unless `unqualified-search-registries` is set; this holds over the API too). Docker passes through. Use this everywhere we feed an image string to a dockerode call.

### Inspect-format diff pattern

When we need to read live container state, call `getContainer(name).inspect()` once (through `safeInspect`, which returns `null` on a 404 instead of throwing) and read the JSON fields directly. dockerode returns the same field shapes on podman and docker (verified live: `HostConfig.NanoCpus`, `HostConfig.Memory`, `NetworkSettings.Ports`, `Mounts[].{Type,Source,Destination}`, `Config.{Image,Cmd,Env,Healthcheck}`, etc.), so there's no Go-template parsing and no podman-vs-docker text divergence to guard against. `getLiveResources` and `getLiveContainerConfig` are the canonical examples. `diffContainerConfig` is a pure function over those inspect-derived values — keep new live-state probes reading inspect JSON directly so the diff stays uniform across runtimes.

### networkMode canonicalization

Docker reports `HostConfig.NetworkMode` as `"default"` or `"bridge"` when no `--network` was passed. Podman rootless reports `"slirp4netns"` or `"pasta"`. These are runtime defaults equivalent to "user did not request a specific network." `canonicalNetworkMode()` in `src/containers.ts` normalizes all of them to `""` so comparison against a requested `undefined`/`""` is correct. Any new comparison of `networkMode` between requested and live state must go through this helper.

### Device access (`devices` / `groupAdd`)

Three runtime quirks shape this feature; all were verified live on rootless Podman 5.4.2 and are load-bearing:

- **Rootless runtimes reject `HostConfig.DeviceCgroupRules`** at container create ("device cgroup rules are not supported in rootless mode or in a user namespace"), so `resolveDeviceRequests` emits no rules when `isRootless === true`. Rootless device access is gated by plain file permissions on the bound nodes instead — that's what `groupAdd` + keep-original-groups exist for.
- **`--group-add keep-groups` is CLI sugar only.** Over the docker-compat create API, a literal `keep-groups` in `HostConfig.GroupAdd` is treated as a group _name_ and fails the container at start. The API-level spelling is the `run.oci.keep_original_groups: "1"` annotation (`HostConfig.Annotations`), emitted for rootless podman only — never for docker.
- **Podman applies `HostConfig.Devices`/`DeviceCgroupRules` but reports neither back through inspect** (compat and libpod both return `[]`/`null`, even for CLI-created `--device` containers). `diffContainerConfig` therefore live-compares node devices and rules on docker only; on podman it compares against `prior`, and directory devices compare through their bind mounts (visible on both engines). Do not "fix" a podman devices-drift gap by comparing against live inspect — it will recreate on every reconcile.
- **The `keep-id:uid=0,gid=0` userns form is deliberate — do NOT "simplify" it to bare `keep-id`.** `userMappingFlags` emits `keep-id:uid=0,gid=0` for a root-by-default image (the default). It is tempting to read `:uid=0,gid=0` as a no-op and switch to bare `keep-id` "for identity fidelity" (bare keep-id makes the in-container process read as the host caller instead of `root`). This is WRONG and breaks every root-by-default consumer image (questdb, grafana, mayara): under bare `keep-id` an in-image-root process is NOT in-container root — it holds no effective capabilities and cannot write its own image paths (`/root`, `/var`) or `chown`, whereas `keep-id:uid=0,gid=0` keeps it in-container root. Bind-mount file ownership lands on the host caller under BOTH forms (in-container 0 maps to the caller either way), and the `removeManagedData` integration test's subuid-`chown` step depends on in-container root — so the parametric form is load-bearing, not cosmetic. Separately, the all-`nobody` supplementary-group display inside such a container is the SUCCESS state, not a failure: crun keeps the caller's real host GIDs at the kernel level (that is what `run.oci.keep_original_groups` does), and the kernel checks those raw GIDs against the device node's owner, so `/dev/snd` opens even though `id` renders the groups as `nobody`.

Group NAMES are resolved to numeric GIDs against the HOST's `/etc/group` before emission (`resolveGroupAdd`) — the runtimes resolve names against the container image's `/etc/group`, which is the wrong namespace for host device nodes. Both `buildCreateOptions` and `diffContainerConfig` go through the same resolvers in `src/devices.ts` (with `_set…ForTesting` probe overrides), so emission and drift mirror can never diverge; never re-derive either side inline.

### `disableUserNamespaceRemap` (rootless-Podman + idmap-incompatible storage)

Some filesystems (ZFS is the canonical case) cannot be id-mapped by the kernel. `HostConfig.UsernsMode: "keep-id"` either fails outright on container create or triggers Podman's `storage-chown-by-maps` sweep, which is catastrophically slow on CoW metadata. The README's user-facing section documents the host-side primary fix (storage driver swap to `fuse-overlayfs`); the plugin-side escape hatch below covers the case where the operator cannot or will not change storage drivers.

Invariants:

- `disableUserNamespaceRemap` is a plugin-config boolean; default `false` preserves the historical `keep-id` behaviour for every existing deployment.
- The flag affects **only** the rootless-Podman branch of `userMappingFlags()`. Docker and rootful-Podman paths are untouched because they use `User` (a `--user`-equivalent), never `keep-id`. (Aside: `keep-id` is meaningless under rootful Podman — there is no user namespace to map into, so podman silently no-ops it and runs as in-image root. We use `User` on the rootful branches precisely to get caller ownership; this is why accurate `isRootless` detection is correctness-critical, since a misread would silently produce root-owned bind-mount files rather than failing loudly.)
- `userMappingFlags()` returns a create-payload fragment, not CLI flags: `{ HostConfig: { UsernsMode: "keep-id:uid=N,gid=N" } }` for rootless podman, `{ User: "N:N" }` for docker/rootful podman, `{}` for opt-out. When `disableUserNamespaceRemap` is active it returns `{}` for rootless-Podman — no `UsernsMode` and no `User`. The default rootless mapping (in-image UID 0 → host caller's UID) then drives bind-mount ownership for root-by-default images. Non-root images lose host-caller ownership; that's the documented trade-off.
- The toggle lives in module state in `src/runtime.ts`, set by `setDisableUserns()` from `plugin.start()` and reset to `false` in `plugin.stop()`. Stop/start cycles must not strand a previous run's setting.
- Drift detection in `ensureRunning` composes through `userMappingFlags()`, so the toggle is automatically reflected; never add a parallel codepath that re-derives the same decision.

Discoverability — `selfDeployment().containerStorage` reports the filesystem backing the rootless-Podman storage root and emits `advice` lines when the filesystem is in `IDMAP_HAZARD_FSTYPES`. Advisory only; never escalates `status`.

### Degradation notifications (`notifications.container.*`)

`src/notifications.ts` (`makeDegradationEmitter`) publishes SignalK notifications for four managed-container degradation conditions, via the server's `app.notifications.raise()`/`clear()` API. Wired into the `src/index.ts` wrapper.

- **Conditions → path → state**: unhealthy → `notifications.container.<name>.unhealthy` `warn`; host-rejected device (`DeviceIssue` action `unresolved`) → `.deviceUnresolved` `warn`; missing required volume (`ifMissing:'abort'`) → `.volumeAborted` `alert`; degraded runtime deployment (`isDashboardDeploymentError`) → the host-level `notifications.container.deployment` `warn`. Paths use the **unprefixed** container name (the notification bus is per-server, so the container-name namespace buys nothing here) and `idInPath:false` (stable, addressable, updates in place — plus the tracked id is what `clear` needs).
- **Additive, never a replacement.** Every site keeps its existing log / `setPluginError` / consumer-callback surfacing; the notification is a parallel channel. Do not remove the old surfacing when touching these sites.
- **Two gates**: the `emitDegradationNotifications` config toggle (default **on**) and the server exposing `app.notifications` (≥ 2.30.0). The pinned `@signalk/server-api` (2.24.0) does NOT declare `raise`/`clear`, so the `App` interface declares a local minimal shape (like `handleMessage?`/`config?`) and the emitter no-ops when `app.notifications` is absent — older servers degrade to the existing surfacing, never throw.
- **NO `method`.** The emitter states severity only; the NotificationManager owns presentation (RFC notification-handling §6.1). The `raise` option type deliberately omits `method` so the `updates/service.ts` `handleMessage`+`method:["visual"]` pattern (a separate, older emitter on `notifications.plugins.<id>.updateAvailable`) can't be copied here.
- **Recovery/clear**: unhealthy is edge-triggered (raise on healthy→unhealthy, clear on unhealthy→healthy) via per-container health tracking in `pollHealth`; deviceUnresolved raises/clears off the `unresolved` subset each commit (`syncDeviceIssues`, called from all three `commitDeviceIssues` sites); volumeAborted clears unconditionally on any successful `ensureRunning` (reaching the success commit means nothing aborted); deployment clears on a subsequent start that finds the host `ok`. `afterContainerRemoved` clears the three per-container conditions; `stop()` calls `degradation.reset()` (clears all outstanding + drops state), mirroring the `resetNamespace`/`setDisableUserns` lifecycle.

### Auto-recreate on config drift

`ensureRunning` compares the requested `ContainerConfig` against the live container's effective config on every call. On drift across `image+tag`, `command`, `networkMode`, `env`, `volumes`, or `ports`, it removes and recreates the container transparently. `resources` follows the existing live-update path. Consumer plugins do not need (and should remove) per-plugin `${dataDir}.container-hash` files — this is centralized.

The diff has an optional `prior?: ContainerConfig` parameter for detecting "unset" drift (an env key previously set is now absent, a `command` previously set is now `undefined`). The wrapper in `src/index.ts` reads it from `lastConfigs` before overwriting.

### Recursion guard in ensureRunning

After auto-recreate, `ensureRunning` recursively re-enters itself with `_postRecreate=true`. The underscore prefix marks this as an internal-use-only parameter — do not document it for consumer plugins, do not move it earlier in the signature. The guard breaks the loop if state somehow stays `running` or `stopped` after the `remove`.

### Cross-plugin API surface

`ContainerManagerApi` in `src/types.ts` is the public contract. Adding methods is fine (additive). Removing or changing signatures is a semver-major change. Anything new on the interface must have a JSDoc comment so consumer plugins see it via TypeScript intellisense — the consumer side accesses it via `(globalThis as any).__signalk_containerManager` so JSDoc is its only documentation.

`whenReady()` (added in 1.6.0) is the canonical "wait for runtime detection to settle" call. Consumer plugins should use it instead of polling `getRuntime()` in a loop. Tests and code in this repo do not need it — they have direct access to the detection result.

`recreate(name, config, options?)` (added in 1.12.0) is the canonical "force-recreate now" call for consumer plugins that pin an image version and bumped it. It is `containers.remove(name)` (idempotent on a truly-missing container — runtime errors are tolerated when a follow-up `getContainerState` confirms `missing`) followed by `containers.ensureRunning(name, config, options)` — drift detection plays no role, so it works the same on every signalk-container version that ships it. Use this instead of an `ensureRunning`-only flow when correctness must not depend on the drift detector firing. The implementation is intentionally thin: any wrapper-level behaviour `ensureRunning` provides (volume policy, `signalkAccessiblePorts`, `signalkConfigRootMount`, `signalkDataMount`, log streaming, manifest recording) is inherited unchanged.

### Container persistence across reboots

signalk-container does **not** manage systemd units. The plugin's job is to call `podman/docker run` with the right flags and let the runtime daemon handle reboot survival.

The contract for consumer plugins:

- `ContainerConfig.restart` is forwarded as `--restart=<value>`. Since 1.11.0 the default is `"unless-stopped"` — leave it unset for the standard case and the container will come back at boot. Set `"no"` explicitly for one-shot containers that genuinely shouldn't restart.
- `ensureRunning()` does the right thing on signalk-server startup whether the container is `running`, `stopped`, or `missing` — but it only runs when signalk-server starts. Between reboots, container persistence depends on the runtime's restart policy, not on the plugin.
- For **rootless Podman**, `--restart=unless-stopped` only fires at boot if the user session is up. Run `loginctl enable-linger $USER` once — the universal-installer does this automatically; bare-metal users must do it manually. Without linger, the container will come back the next time signalk-server starts (because `ensureRunning()` is called) but not before.
- For **Docker**, `--restart=unless-stopped` fires whenever `dockerd` starts. No extra setup.
- For the **signalk-universal-installer** deployment (where signalk-server itself is a systemd Quadlet and peer engine containers are Quadlets too), systemd is the source of truth — the universal installer's Quadlets carry `Restart=always` and crashloop-guard directives that the runtime's `--restart` flag isn't equipped to express. Plugins under that deployment register peers with `managedContainer: false` and don't touch their lifecycle.

When a consumer plugin sets a restart policy explicitly, it overrides the default. Existing containers are not recreated just to flip the policy — drift detection skips `restart` because flipping it doesn't justify the downtime; the new default kicks in on the next image/env/volumes recreate or on a clean install.

### In-container signalk-server + host-side rootless Podman

The signalk-universal-installer's deployment runs signalk-server itself as a Podman container, with the host's rootless podman socket bind-mounted to `/var/run/docker.sock` inside. signalk-container talks to that socket directly via dockerode — **the socket IS the channel to the host daemon**, so there is no CLI binary, no client-side flag validation, and no `podman --remote` dance. That collapses most of the sharp edges the CLI era had to work around (the docker-shim reclassification, `--remote --url` promotion, `cleanEnv`/`XDG_RUNTIME_DIR` backfill, and `runtimeCmd` binary-flipping are all gone). Two edges remain, in changed form:

| Concern                                                                                                                                      | Code                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Finding our own container id when HOSTNAME is empty, cgroup is `0::/`, and `Network=host` makes `/etc/hostname` return the host machine name | `parseSelfContainerIdsFromMountinfo()` matches the 64-hex id the runtime stamps into bindfs source paths (`/etc/hostname`, `/etc/resolv.conf`, `/run/.containerenv`); each candidate is validated via `getContainer(id).inspect()` |
| Detecting rootless mode over the socket (dockerode reaches podman's docker-compat `/info`, which does NOT expose `host.security.rootless`)   | `rootlessFromInfo()` in `runtime.ts` reads the compat shape: the top-level `Rootless` boolean, falling back to `SecurityOptions` containing `name=rootless`                                                                        |

When debugging "signalk-container thinks we're not rootless" / "can't find our own id" reports, check whether you're in this deployment shape first — and remember that under the socket the cgroup-controller view comes from the kernel FS (`/sys/fs/cgroup/cgroup.controllers`), not `info()`, because the compat endpoint doesn't expose `CgroupControllers`.

## Workflow Conventions

This repo is maintained by Dirk Wahrheit. Workflow is deliberate; AI tools should follow it strictly.

### Branch and commit rules

- Branch names use **hyphens**, never slashes: `fix-something`, `feat-something`, `chore-release-1-6-0`. Signal K server maintainers reject slash names.
- Angular conventional commits: `<type>(<scope>): <subject>`. Types: `feat|fix|docs|style|refactor|test|chore|perf`. Subject ≤ 50 chars, imperative mood, no period.
- One logical change per commit. The history tells a story — each commit is a meaningful, self-contained step.
- No `Co-Authored-By` lines. No "Generated with Claude Code" attribution.

### PR rules

- Never commit directly to `master`. Every change goes through a PR — including version bumps.
- Version bumps live in their own `chore(release): X.Y.Z` PR. Do not mix `package.json` version changes with feature/fix work.
- One logical change per PR. Refactors, behavior changes, and features belong in separate PRs. If a single change would produce multiple changelog entries, split it.
- PR titles describe what changes; PR bodies explain _why_ and summarize the approach, not the mechanics.
- No checkboxes in PR descriptions (Signal K maintainers convention). If you need a "Tested" section, list what was actually verified, not what's planned.
- PR descriptions must reflect reality. Never list speculative tests; only what actually ran.

### Pre-PR checklist

Before pushing or opening a PR:

1. `npm run format` — `prettier --write .` + `eslint --fix` (writes back fixes)
2. `npm run build:all:integration` — `build && test:all`, where `build` = `clean && build:server (tsc) && build:configpanel (vite build)`. All tests (unit + integration) must pass. CI runs `npm test` (unit only), so the integration coverage is your responsibility before pushing.
3. `npm run ci-lint` — `eslint && prettier --check .` — read-only verification of step 1's output; this is what CI runs and what catches uncommitted format/lint drift.
4. `cr review --plain | tee /tmp/cr-review-<branch>.txt` — local CodeRabbit pass. `cr` only sees committed changes, so commit first, then review. The CLI is rate-limited (~50min cooldown); pipe to a file so reruns aren't needed.

For iterative server-side work, `npm run watch` runs `tsc --watch`. It does **not** rebuild the configpanel and does **not** clean stale `dist/test/` — run a full `npm run build` before invoking `npm test`.

Only push after all four pass. **Never push without explicit approval.** `git push` always needs its own permission — commit/test/format/cr approval does not cover push.

### Release flow

Tag-triggered (`.github/workflows/publish.yml` fires on `v*` tags):

1. Branch `chore-release-X.Y.Z` off master.
2. Bump `version` in `package.json`. There is no `package-lock.json` (the `~/.npmrc` setting disables it).
3. Commit `chore(release): X.Y.Z`. Run the pre-PR checklist.
4. Open PR, wait for explicit merge approval.
5. After merge: `git checkout master && git pull --ff-only`, then `git tag vX.Y.Z && git push --tags`. The workflow creates the GitHub Release and runs `npm publish --provenance --access public` (prereleases use `--tag beta`).
6. Never publish to npm without explicit approval.

Angular semver:

- `feat` → minor
- `fix` → patch
- `BREAKING CHANGE:` footer or `!` → major
- Pure `chore`/`docs`/`refactor` → patch (or skip release)

Dirk may override the bump rule (e.g. ship behavior change as minor even if technically API-compatible). Ask before assuming.

## Common Pitfalls

- **Stale `dist/`**: TypeScript leaves prior compile output. After a branch switch that removes test files, `dist/test/` still holds old `.js` files and `node --test` runs them. The `build` script now starts with `rimraf dist` to avoid this; do not bypass with `tsc --watch` or partial rebuilds when running tests.
- **node_modules drift**: `node_modules/` in a long-running clone can lag the registry. After a `package.json` change involving a tooling dependency (prettier, typescript, eslint), run `npm install` before `npm run format` — formatter output between versions diverges and CI will reject the result.
- **cr review needs a commit**: cr only reviews committed changes. Run `git commit` first, then `cr review --plain`. Running it against the working tree produces "No files to review."
- **Windows runner is Windows containers**: GitHub-hosted Windows runners ship Docker Desktop in Windows-container mode. `docker --version` works; `docker pull alpine:3.19` does not. The `hasContainerRuntime()` helper returns `null` on Windows so integration tests skip cleanly. Do not try to "fix" the Windows runner — there's no Linux daemon available, only the skip.
