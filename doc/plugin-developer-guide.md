# Plugin Developer Guide: Using signalk-container

How to use signalk-container from your Signal K plugin to manage Docker/Podman containers. This guide covers the integration patterns, pitfalls, and solutions discovered during real-world development.

## Quick Start

```typescript
// In your plugin's async startup function:
const containers = (globalThis as any).__signalk_containerManager;
if (!containers) {
  app.setPluginError("signalk-container plugin is required");
  return;
}

await containers.ensureRunning("my-service", {
  image: "myorg/myimage",
  tag: "latest",
  ports: { "8080/tcp": "127.0.0.1:8080" },
  volumes: { "/data": app.getDataDirPath() },
  env: { MY_VAR: "value" },
  restart: "unless-stopped",
});
```

---

## Critical: Signal K Plugin Lifecycle

### The server does NOT await `start()`

Signal K server calls `plugin.start(config, restart)` **synchronously**. If your `start()` is `async`, the returned Promise is ignored. Errors from rejected promises become unhandled rejections — no error status, no logs, silent failure.

**Wrong:**

```typescript
// The server calls this but does NOT await it.
// If ensureRunning() rejects, no one catches it.
async start(config) {
  await containers.ensureRunning(...)  // unhandled rejection if this fails
  app.setPluginStatus('Running')       // never reached
}
```

**Correct:**

```typescript
start(config) {
  asyncStart(config).catch((err) => {
    app.setPluginError(
      `Startup failed: ${err instanceof Error ? err.message : String(err)}`
    );
  });
}
```

Extract all async logic into a separate function and call it from a synchronous `start()` with an explicit `.catch()`.

### `setPluginStatus` and `setPluginError` take ONE argument

The server wraps these methods per-plugin. The plugin id is pre-filled automatically.

**Wrong:**

```typescript
app.setPluginStatus(plugin.id, "Running"); // plugin.id becomes the message!
```

**Correct:**

```typescript
app.setPluginStatus("Running");
app.setPluginError("Connection failed");
```

The server internally calls `app.setPluginStatus(pluginId, msg)` with two args, but the version given to plugins via `appCopy` is already bound to the plugin id.

---

## Critical: Cross-Plugin Communication

### Each plugin gets a shallow copy of `app`

Signal K server creates each plugin's `app` via `_.assign({}, app, {...})`. This is a **shallow copy**. Setting a property on one plugin's `app` does NOT propagate to other plugins.

**Wrong:**

```typescript
// In signalk-container:
(app as any).containerManager = api;

// In signalk-questdb:
const containers = (app as any).containerManager; // undefined!
```

**Correct — use `globalThis`:**

```typescript
// In signalk-container:
(globalThis as any).__signalk_containerManager = api;

// In signalk-questdb:
const containers = (globalThis as any).__signalk_containerManager;
```

Clean up in `stop()`:

```typescript
stop() {
  delete (globalThis as any).__signalk_containerManager;
}
```

### Startup order is not guaranteed

Plugins start in parallel. Your plugin may start before signalk-container has finished detecting the runtime. You must poll and wait:

```typescript
async function asyncStart(config) {
  let containers;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    containers = (globalThis as any).__signalk_containerManager;
    // containerManager is exposed immediately, but runtime detection
    // is async. Wait until getRuntime() returns non-null.
    if (containers && containers.getRuntime()) break;
    app.setPluginStatus("Waiting for container runtime...");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!containers || !containers.getRuntime()) {
    app.setPluginError("signalk-container plugin not available");
    return;
  }

  // Now safe to call ensureRunning()
}
```

The key insight: signalk-container exposes the API object on `globalThis` **synchronously** in `start()`, but `getRuntime()` returns `null` until the async runtime detection completes. Always check both.

---

## Podman vs Docker Differences

### Image names must be fully qualified for Podman

Podman without `unqualified-search-registries` configured rejects short names like `questdb/questdb:latest`. signalk-container handles this automatically by prefixing `docker.io/` when needed. You don't need to worry about this in your plugin — just pass the normal Docker Hub image name.

### SELinux volume flags

signalk-container adds `:Z` to volume mounts when using Podman (required on Fedora/RHEL for SELinux relabelling). Docker ignores this flag harmlessly. Your plugin doesn't need to handle this.

### Container naming

All containers are prefixed with `sk-` (e.g., `sk-signalk-questdb`). This avoids conflicts with user containers and makes cleanup predictable. Pass just your plugin name to `ensureRunning()` — the prefix is added automatically.

---

## Container Config Changes

When your plugin's configuration changes (compression, ports, image version, etc.), the container needs to be recreated because Docker/Podman env vars are set at container creation time.

**Pattern: hash-based recreation**

```typescript
const containerConfig = {
  image: "questdb/questdb",
  tag: config.version,
  ports: { "9000/tcp": "127.0.0.1:9000" },
  volumes: { "/data": app.getDataDirPath() },
  env: { MY_COMPRESSION: config.compression },
  restart: "unless-stopped",
};

// Hash the config to detect changes
const configHash = JSON.stringify({
  tag: containerConfig.tag,
  ports: containerConfig.ports,
  env: containerConfig.env,
});

const hashFile = `${app.getDataDirPath()}/container-config-hash`;
let lastHash = "";
try {
  lastHash = readFileSync(hashFile, "utf8");
} catch {
  /* first run */
}

const state = await containers.getState("my-service");
if (state !== "missing" && configHash !== lastHash) {
  // Config changed — remove and recreate
  await containers.remove("my-service");
}

await containers.ensureRunning("my-service", containerConfig);
writeFileSync(hashFile, configHash);
```

Data is safe because volumes live on the host filesystem, not inside the container.

---

## Stopping Containers When Plugin is Disabled

When your plugin's `stop()` is called (user disables the plugin), you should stop the managed container. Otherwise it keeps running with no one managing it:

```typescript
async stop() {
  // Clean up writer, timers, subscriptions...

  // Stop the managed container
  if (currentConfig?.managedContainer !== false) {
    const containers = (globalThis as any).__signalk_containerManager;
    if (containers) {
      try {
        await containers.stop('my-service');
      } catch {
        // may already be stopped
      }
    }
  }
}
```

The container is only stopped, not removed. Re-enabling the plugin will start it again instantly without pulling.

---

## API Reference

Access via `(globalThis as any).__signalk_containerManager`:

### `getRuntime(): RuntimeInfo | null`

Returns detected runtime info or `null` if detection hasn't completed.

```typescript
{ runtime: 'podman', version: '5.4.2', isPodmanDockerShim: false }
```

### `ensureRunning(name, config, options?): Promise<void>`

Creates and starts a container if not already running. No-op if already running.

```typescript
await containers.ensureRunning("my-db", {
  image: "postgres",
  tag: "16",
  ports: { "5432/tcp": "127.0.0.1:5432" },
  volumes: { "/var/lib/postgresql/data": "/host/path" },
  env: { POSTGRES_PASSWORD: "secret" },
  restart: "unless-stopped",
  command: ["-c", "shared_buffers=256MB"], // optional
});
```

Use `networkMode: 'host'` for containers that need direct access to the host network (e.g. multicast/broadcast discovery). Port mappings are ignored when `networkMode` is set.

```typescript
await containers.ensureRunning("mayara-server", {
  image: "ghcr.io/marineyachtradar/mayara-server",
  tag: "latest",
  networkMode: "host",
  restart: "unless-stopped",
});
```

### `start(name): Promise<void>`

Starts a stopped container. Throws if container doesn't exist.

### `stop(name): Promise<void>`

Stops a running container. Idempotent.

### `remove(name): Promise<void>`

Stops and removes a container. Idempotent.

### `getState(name): Promise<ContainerState>`

Returns `'running'`, `'stopped'`, `'missing'`, or `'no-runtime'`.

### `pullImage(image, onProgress?): Promise<void>`

Pulls an image. `onProgress` receives line-by-line pull output.

### `imageExists(image): Promise<boolean>`

Checks if an image exists locally.

### `runJob(config): Promise<ContainerJobResult>`

Runs a one-shot container (exits when done).

```typescript
const result = await containers.runJob({
  image: "myorg/converter",
  command: ["convert", "/in/data.csv", "/out/data.parquet"],
  inputs: { "/in": "/host/input" }, // read-only mount
  outputs: { "/out": "/host/output" }, // read-write mount
  env: { FORMAT: "parquet" },
  timeout: 120, // seconds
  onProgress: (line) => console.log(line),
  label: "parquet-export",
});

if (result.status === "completed") {
  console.log("Exit code:", result.exitCode);
  console.log("Output:", result.log);
}
```

### `prune(): Promise<PruneResult>`

Removes dangling images.

```typescript
{ imagesRemoved: 3, spaceReclaimed: '1.2 GB' }
```

### `listContainers(): Promise<ContainerInfo[]>`

Lists all `sk-` prefixed containers.

### `getImageDigest(imageOrContainer): Promise<string | null>`

Returns the local image ID (sha256 digest) for an image reference or container name. Returns `null` if not present locally. Used internally by the update detection service for floating-tag drift checks, but exposed to plugins that want to do their own digest comparison.

---

## Update Detection

signalk-container ships a centralized update detection service. Instead of each plugin re-implementing "is there a newer image for my container?", you register your container once and the service handles version checking, scheduling, caching, offline tolerance, and Signal K notifications.

The service is detection-only — it tells you when an update is available. **Applying the update remains the consumer plugin's responsibility** because each plugin has its own ContainerConfig (ports, env, volumes, conditional flags) and post-apply glue (reconnecting clients, persisting config, etc.) that signalk-container can't know about.

### Basic registration

Inside your plugin's `start()`, after the container is up and runtime is ready:

```typescript
containers.updates.register({
  pluginId: "signalk-questdb",
  containerName: "signalk-questdb",
  image: "questdb/questdb",
  // MUST be a function (not a captured value): the user can edit
  // the version in plugin options without re-registering.
  currentTag: () => currentConfig?.questdbVersion ?? "latest",
  versionSource: containers.updates.sources.githubReleases("questdb/questdb"),
  // Optional: query the running container for its version directly.
  // If present and returns non-null, takes precedence over currentTag.
  currentVersion: async () => {
    const r = await queryClient.exec("SELECT build()");
    return (
      r.dataset[0]?.[0]?.toString().match(/QuestDB\s+([\d.]+)/)?.[1] ?? null
    );
  },
});
```

In your plugin's `stop()`:

```typescript
containers.updates.unregister("signalk-questdb");
```

### Floating tags are handled automatically

The service classifies the running tag and picks the right strategy:

| Tag                                                 | Classification | Strategy                                                          |
| --------------------------------------------------- | -------------- | ----------------------------------------------------------------- |
| `9.2.0`, `v1.5`, `2.0.0-beta1`                      | semver         | Compare against `versionSource.latest` via semver                 |
| `latest`, `main`, `master`, `nightly`, `edge`, `v3` | floating       | Pull image, compare local digest to remote digest                 |
| `my-fork`, `custom-2024`                            | unknown        | Same as floating: digest drift only, never claims "newer-version" |

You don't choose between strategies — you just pass `currentTag` and `versionSource`, and the service does the right thing whether the user pinned `9.2.0` or `latest` or `main`. For floating tags, "update available" means "the registry rebuilt the image" rather than "there's a newer version number". The `latestVersion` field in the result still reflects the latest stable semver release, so the UI can display "you're on `:main`, latest stable is 9.2.0" as informational context.

### Reading the result

The service exposes three accessor methods:

```typescript
// Cached, no network: cheap, safe to call from polling endpoints.
const result = containers.updates.getLastResult("signalk-questdb");

// Force a fresh check now (or coalesces with an in-flight check).
const fresh = await containers.updates.checkOne("signalk-questdb");
```

`UpdateCheckResult` has these fields:

```typescript
{
  pluginId: "signalk-questdb",
  containerName: "signalk-questdb",
  runningTag: "9.1.0",
  tagKind: "semver",         // "semver" | "floating" | "unknown"
  currentVersion: "9.1.0",   // null if cannot resolve
  latestVersion: "9.2.0",    // null if version source returned no data
  updateAvailable: true,
  reason: "newer-version",   // "newer-version" | "digest-drift" | "up-to-date" | "offline" | "unknown" | "error"
  checkedAt: "2026-04-08T12:00:00.000Z",
  lastSuccessfulCheckAt: "2026-04-08T12:00:00.000Z",
  fromCache: false,          // true when reason is "offline" and we returned cached data
}
```

### Replacing an existing update endpoint

If your plugin already exposes `/api/update/check`, you can keep the same URL and just delegate. This means **your config panel UI doesn't need to change**:

```typescript
router.get("/api/update/check", async (_req, res) => {
  const result = await containers.updates.checkOne("signalk-questdb");
  res.json({
    currentVersion: result.currentVersion ?? "unknown",
    latestVersion: result.latestVersion ?? "unknown",
    updateAvailable: result.updateAvailable,
  });
});
```

Your existing `/api/update/apply` route stays as-is — it owns the ContainerConfig rebuild, persistence, and post-apply glue.

### Offline handling (boats at sea)

The service treats network unavailability as the **normal expected state**, not as an error condition. When a check fails with a network error (`ENETUNREACH`, `ECONNREFUSED`, DNS failure, fetch timeout, etc.):

- The result returns with `reason: "offline"` and `fromCache: true`, copying values from the last successful check
- Your config panel sees HTTP 200 with the cached data, **never** a 5xx error
- No `app.error` is logged
- No Signal K notification is emitted
- The offline failure does NOT count toward auto-unregister

When network comes back, the next scheduled check (or a manual one) just succeeds. No exponential backoff, no manual recovery needed.

The persistent cache lives at `${app.getDataDirPath()}/updates-cache.json` and survives Signal K restarts. A boat that powers up mid-ocean still sees the last-known-good check rather than "unknown".

### Auto-unregister on persistent real errors

After 5 consecutive **real** errors (HTTP 4xx/5xx, JSON parse failure, repo renamed, etc. — but **not** offline errors), the service auto-unregisters and logs an error. This bounds damage from a broken registration. The consumer plugin can re-register after fixing the issue (typically by restarting).

### Notifications

When a check transitions from "up-to-date" to "update-available", the service emits a Signal K notification to `notifications.plugins.<pluginId>.updateAvailable`. This is picked up by notification subscribers (PushOver, etc.) without any additional UI integration. Notifications are emitted only on transitions, not on every check.

### Critical rules

1. **`register()` is safe to call before runtime is ready.** It's pure bookkeeping — the scheduler defers the first tick until `getRuntime()` returns non-null. Your plugin still must poll `getRuntime()` before doing other container operations, but the registration call itself is safe.
2. **`currentTag` MUST be a function**, not a captured value. The user can edit the version in plugin options without restarting your plugin, and `currentTag` is called fresh on every check.
3. **You must `unregister()` in your plugin's `stop()`**. Otherwise stale registrations linger.
4. **If signalk-container restarts, your registration is lost.** Your plugin must re-poll and re-register, just like with `ensureRunning`.
5. **For floating tags, `updateAvailable` means "rebuild detected", not "newer version".** Your UI should make this distinction clear when `tagKind === "floating"`.
6. **Don't auto-apply.** The service is detection-only — your plugin owns the apply path. The user clicks the button.

---

## Resource Limits

A boat at sea typically runs Signal K plus several containers (questdb, grafana, mayara, etc.) on a Raspberry Pi or low-power x86 mini PC. One container hogging CPU or leaking memory can starve Signal K's event loop, raise NMEA decode latency, trigger thermal throttling, or even OOM-kill the host.

signalk-container exposes podman/docker resource flags through a `resources` field on `ContainerConfig`. You set sensible defaults; the user can override per-container in signalk-container's plugin config. Field-level merge — the user override wins on a per-field basis.

### Setting defaults from your plugin

```typescript
await containers.ensureRunning("mayara-server", {
  image: "ghcr.io/marineyachtradar/mayara-server",
  tag: "latest",
  networkMode: "host",
  restart: "unless-stopped",
  resources: {
    cpus: 1.5, // hard cap at 1.5 cores
    memory: "512m", // hard memory cap
    memorySwap: "512m", // = memory → swap disabled
    pidsLimit: 200, // bound thread leaks
  },
});
```

The defaults you pick should reflect what your container actually needs at typical workload, with maybe 25% headroom. Don't be conservative to the point of starvation, but don't leave it unlimited either — that defeats the purpose.

### What each field maps to

| Field               | Runtime flag           | Use case                                                                                                                   |
| ------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `cpus`              | `--cpus`               | Hard CPU cap via CFS quota. e.g. `1.5` = 1.5 cores. **The most important field for stability.**                            |
| `cpuShares`         | `--cpu-shares`         | Soft weight (default 1024). Only matters under contention. Use to set priority between containers.                         |
| `cpusetCpus`        | `--cpuset-cpus`        | Pin to specific cores, e.g. `"1,2"`. Useful for "keep mayara off core 0 where Signal K runs".                              |
| `memory`            | `--memory`             | Hard memory cap. Container is OOM-killed if it exceeds this. **Critical for OS stability.**                                |
| `memorySwap`        | `--memory-swap`        | Total memory + swap. Set equal to `memory` to disable swap entirely. Recommended for predictability.                       |
| `memoryReservation` | `--memory-reservation` | Soft floor — kernel reclaims first from containers above this when host is under memory pressure.                          |
| `pidsLimit`         | `--pids-limit`         | Process/thread cap. Prevents fork bombs and runaway thread leaks.                                                          |
| `oomScoreAdj`       | `--oom-score-adj`      | OOM score adjustment, -1000..1000. Higher = killed first under host OOM. Set high on "I'd rather lose this than Signal K". |

### Picking sensible defaults

Don't guess. Measure your container under realistic load on the smallest hardware you support (typically a Pi 4 or Pi 5), then add ~25% headroom. The workflow:

1. **Run your container without limits first.** Don't set `resources` at all. Get it doing a typical workload — for mayara that means radar data flowing in, for questdb that means active inserts and queries from grafana, for grafana that means a panel actively rendering.

2. **In another shell, watch live resource use:**

   ```bash
   podman stats sk-mayara-server
   # or, for a continuously updating snapshot of all sk-* containers:
   podman stats --no-reset $(podman ps --filter "name=sk-" --format "{{.Names}}")
   ```

   The output looks like:

   ```
   ID          NAME              CPU %    MEM USAGE / LIMIT   MEM %    NET IO            BLOCK IO    PIDS
   abc123…     sk-mayara-server  87.42%   312.5MB / 7.7GB     3.96%    142kB / 2.1MB    0B / 0B     12
   ```

   Watch for ~5–10 minutes covering peaks (e.g. radar range changes, panel reloads, query bursts). Note **peak CPU %** and **peak MEM USAGE**.

3. **Convert to limits:**
   - `cpus`: divide peak CPU% by 100, then add headroom. Mayara peaking at 95% = needs about 1 core; set `cpus: 1.25` to give 25% headroom.
   - `memory`: round peak MEM up to a clean unit, add headroom. Peaks at 312 MB → set `memory: "384m"` (≈25% headroom).
   - `memorySwap`: set equal to `memory` to disable swap. On a Pi this is almost always what you want — swap is slow and unpredictable, and a clean OOM kill is more recoverable than a thrashing system.
   - `pidsLimit`: get the running thread count from `ps -T -p $(pidof mayara-server) | wc -l` (or `--format "{{.PIDs}}"` from `podman stats`), double it, round up. Most containers stay under 50.

4. **Apply the limits and re-test.** Watch `podman stats` again under load. If the container is hitting 100% CPU% with a `cpus` cap set, or `MEM USAGE` is bumping against `LIMIT`, your defaults are too low. Bump and repeat. You're aiming for the container to comfortably fit inside its limits at peak load.

5. **Document what your defaults assume.** In your plugin's README or in a code comment next to the `ensureRunning` call, say "tested on Pi 5 with 8GB" or "assumes 1080p Grafana panels at 1Hz refresh". Users running on weaker hardware or different workloads may need to override.

### Verifying limits are applied

After your plugin starts the container, confirm the limits actually took effect:

```bash
podman inspect sk-mayara-server --format '
  cpus={{.HostConfig.NanoCpus}}
  memory={{.HostConfig.Memory}}
  pids={{.HostConfig.PidsLimit}}
'
```

`NanoCpus` is in nanoseconds-per-second of CPU quota; `1500000000` = 1.5 cores. `Memory` and `PidsLimit` are in bytes and absolute count. Zero means "no limit". Compare against what you passed in `resources` — they should match the **merged** values (your defaults ⊕ user overrides), which you can also see via:

```bash
curl http://localhost:3000/plugins/signalk-container/api/containers/mayara-server/resources
# {"name":"mayara-server","effective":{"cpus":1.5,"memory":"512m"},"override":null}
```

If they don't match, the most likely culprit is that the user has an override in signalk-container's config that's superseding your default. Check the `override` field in the API response.

### Troubleshooting

| Symptom                                             | Likely cause                                        | Fix                                                                       |
| --------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| Container restarts repeatedly with exit code 137    | OOM killed — `memory` cap too low                   | Raise `memory` and `memorySwap`, or measure peak first                    |
| Container slow but never killed; `MEM %` near 100%  | Hitting `memory` cap, kernel reclaiming hard        | Same — raise the limits                                                   |
| `CPU %` pinned at the cap, host responsive          | Working as designed; limits are protecting Signal K | Probably fine. If functionality suffers, raise `cpus`                     |
| `updateResources()` returns `method: "recreated"`   | Limits include `cpusetCpus` or `oomScoreAdj`        | Expected — those can't be live-updated. Container had ~5s downtime        |
| `getResources()` returns `{}` for a known container | Plugin hasn't called `ensureRunning` yet            | Wait for plugin startup; check `getRuntime()` first                       |
| Override in signalk-container config has no effect  | Container was already running before override saved | Restart the consumer plugin, or call `updateResources()` from your plugin |
| Live update silently skipped (no `--cpus` flag)     | All limits are `null` or empty after merge          | Check `getResources()` to see what merged effective is                    |

### User overrides via signalk-container config

The user can override your defaults in signalk-container's plugin config UI under "Per-container resource overrides". The override is keyed by container name (without `sk-` prefix) and field-level merged on top of your default.

Example: your plugin defaults `cpus: 1.5, memory: "512m"`. The user sets `{ "mayara-server": { "cpus": 2.0 } }`. The effective limits become `{ cpus: 2.0, memory: "512m" }` — the user bumped CPU without having to know your memory default.

To **explicitly remove** a limit your plugin set, the user uses `null`:

```json
{ "mayara-server": { "memory": null } }
```

This results in effective limits `{ cpus: 1.5 }` — no memory cap.

### Live updates without restart

When the user changes overrides and saves, signalk-container restarts (Signal K stops + starts the plugin on config save), so the new merged limits apply on the next `ensureRunning()` call from your plugin. For changes to **already-running** containers, your plugin (or a UI) can call:

```typescript
const result = await containers.updateResources("mayara-server", {
  cpus: 2.0,
  memory: "1g",
});
console.log(result.method); // "live" or "recreated"
```

The service tries `podman update` (or `docker update`) first — instantaneous, no downtime. If the runtime refuses (cpuset on some kernels, oom-score-adj which is set at create time only, etc.), it falls back to stop+remove+ensureRunning with the new limits. The cached `ContainerConfig` from the original `ensureRunning` call is reused, so port mappings, env vars, and volumes are preserved automatically.

`result.method` tells you which path was taken. `result.warnings` may contain a message explaining why live update failed if a recreate happened.

### Reading the effective limits

```typescript
const effective = containers.getResources("mayara-server");
// → { cpus: 2.0, memory: "512m", pidsLimit: 200 } — merged result
```

This is the same data exposed via `GET /plugins/signalk-container/api/containers/:name/resources`, which also includes the raw user override under the `override` key.

### Critical rules

1. **Always set sensible defaults.** Unlimited containers are a stability hazard on a boat.
2. **`memorySwap` = `memory` is almost always what you want.** Swap on a Pi or eMMC is slow and unpredictable; better to OOM-kill the offending container quickly than to thrash.
3. **Don't pin to core 0 by default** (`cpusetCpus: "0"`). Signal K's event loop usually lives there.
4. **`updateResources` is callable any time** but the cached config used for recreate fallback comes from your most recent `ensureRunning()` call. If you've never called `ensureRunning`, recreate will throw with a clear error.
5. **`cpuset-cpus` and `oom-score-adj` cannot be live-updated.** Setting either forces the recreate fallback.

---

## TypeScript Types

If you want type safety, define a minimal interface in your plugin:

```typescript
interface ContainerManagerApi {
  getRuntime: () => { runtime: string; version: string } | null;
  ensureRunning: (name: string, config: unknown) => Promise<void>;
  start: (name: string) => Promise<void>;
  stop: (name: string) => Promise<void>;
  remove: (name: string) => Promise<void>;
  getState: (
    name: string,
  ) => Promise<"running" | "stopped" | "missing" | "no-runtime">;
  pullImage: (
    image: string,
    onProgress?: (msg: string) => void,
  ) => Promise<void>;
  imageExists: (image: string) => Promise<boolean>;
  getImageDigest: (imageOrContainer: string) => Promise<string | null>;
  updateResources: (
    name: string,
    limits: unknown,
  ) => Promise<{ method: "live" | "recreated"; warnings?: string[] }>;
  getResources: (name: string) => unknown;
  runJob: (
    config: unknown,
  ) => Promise<{ status: string; exitCode?: number; log: string[] }>;
  prune: () => Promise<{ imagesRemoved: number; spaceReclaimed: string }>;
  listContainers: () => Promise<unknown[]>;
  updates: {
    register: (reg: unknown) => void;
    unregister: (pluginId: string) => void;
    checkOne: (pluginId: string) => Promise<unknown>;
    getLastResult: (pluginId: string) => unknown | null;
    sources: {
      githubReleases: (repo: string, options?: unknown) => unknown;
      dockerHubTags: (image: string, options?: unknown) => unknown;
    };
  };
}
```

---

## Plugin Config Panel (Module Federation)

If you want a custom config UI like signalk-container and signalk-questdb, use the `signalk-plugin-configurator` pattern:

### package.json

```json
{
  "keywords": ["signalk-node-server-plugin", "signalk-plugin-configurator"]
}
```

### Webpack config

```javascript
const { ModuleFederationPlugin } = require("webpack").container;
const pkg = require("./package.json");

module.exports = {
  entry: "./src/configpanel/index",
  mode: "production",
  output: { path: path.resolve(__dirname, "public"), clean: false },
  module: {
    rules: [
      {
        test: /\.jsx?$/,
        loader: "babel-loader",
        exclude: /node_modules/,
        options: { presets: ["@babel/preset-react"] },
      },
    ],
  },
  plugins: [
    new ModuleFederationPlugin({
      name: pkg.name.replace(/[-@/]/g, "_"),
      library: { type: "var", name: pkg.name.replace(/[-@/]/g, "_") },
      filename: "remoteEntry.js",
      exposes: {
        "./PluginConfigurationPanel":
          "./src/configpanel/PluginConfigurationPanel",
      },
      shared: {
        react: { singleton: true, requiredVersion: "^19" },
        "react-dom": { singleton: true, requiredVersion: "^19" },
      },
    }),
  ],
};
```

### Component signature

```jsx
export default function PluginConfigurationPanel({ configuration, save }) {
  // configuration = current plugin config object
  // save(newConfig) = call to persist config and restart plugin
}
```

The `save()` function provided by the Admin UI POSTs to `/plugins/{pluginId}/config` and triggers a plugin restart.

### Build output

Webpack outputs to `public/` which Signal K serves at `/{package-name}/`. The Admin UI loads `remoteEntry.js` and dynamically imports `PluginConfigurationPanel`.

**Do not commit `public/*.js` to git** — add them to `.gitignore`. They're built during `npm run build` (which CI and `npm publish` both run via `prepublishOnly`).

---

## Containerized Signal K

When Signal K runs inside a container itself, signalk-container needs the host's Docker/Podman socket and CLI binary mounted in. Detect this case via `isContainerized()`:

```typescript
import { isContainerized } from "signalk-container/dist/runtime";

if (isContainerized()) {
  // Signal K is running inside a container
  // - host runtime must be exposed (docker.sock + binary)
  // - spawned containers are siblings, not nested
  // - host.containers.internal points to the actual host
  // - shared networks need explicit setup
}
```

The signalk-container plugin uses this check to:

- Show `(in-container)` prefix in status
- Provide a more helpful error when no runtime is found
- Document the security and networking implications in the README

For consumer plugins (like signalk-questdb): if you rely on `host.containers.internal` to reach Signal K from a spawned container, that won't work when Signal K itself is in a container — it would point to the host, not the SK container. Use the SK container's name on the shared network instead.

See the README's "Running Signal K in a Container" section for full details on socket mounting, security caveats, and networking.

---

## Common Mistakes Summary

| Mistake                                                         | Symptom                                        | Fix                                                                                            |
| --------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `async start()` without catch                                   | Silent failure, no status                      | Sync `start()` + `asyncStart().catch()`                                                        |
| `app.setPluginStatus(id, msg)`                                  | Status shows plugin id as message              | `app.setPluginStatus(msg)` (one arg)                                                           |
| Setting property on `app`                                       | Other plugins can't see it                     | Use `globalThis.__signalk_xxx`                                                                 |
| Not waiting for runtime detection                               | `getRuntime()` returns null                    | Poll until `getRuntime()` is non-null                                                          |
| Short Docker image names with Podman                            | Pull fails with "short-name did not resolve"   | signalk-container handles this automatically                                                   |
| `DEDUP ENABLED UPSERT KEYS` in QuestDB DDL                      | Table creation fails                           | `DEDUP UPSERT KEYS` (no ENABLED)                                                               |
| Committing webpack `public/` output                             | CI fails with "untracked files"                | Add `public/*.js` to `.gitignore`                                                              |
| `engines.node` missing from package.json                        | CI validation error                            | Add `"engines": { "node": ">=22" }`                                                            |
| Not stopping container in `stop()`                              | Container runs after plugin disabled           | Call `containers.stop()` in plugin `stop()`                                                    |
| `savePluginOptions` doesn't restart                             | Plugin stays stopped after config save         | Don't rely on it for restart; do work directly                                                 |
| Config hash in QuestDB data volume                              | Hash file lost (QuestDB owns the dir)          | Store hash file next to plugin JSON config                                                     |
| No `resources` set on `ensureRunning`                           | Container can saturate the host                | Always set sensible CPU/memory caps; measure with `podman stats` first                         |
| Setting `cpus: 4` on a Pi 4 (4 cores)                           | One container can starve all others + Signal K | Leave at least 1 core's worth of headroom for the OS and Signal K                              |
| `memory` set, `memorySwap` left default                         | Container thrashes swap before OOM             | Set `memorySwap` equal to `memory` to disable swap entirely                                    |
| Override in signalk-container config has key `sk-mayara-server` | Override silently ignored                      | Use the unprefixed name (`mayara-server`) — signalk-container adds the `sk-` prefix internally |
