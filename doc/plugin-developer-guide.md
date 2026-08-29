# Plugin Developer Guide: Using signalk-container

How to use signalk-container from your Signal K plugin to manage Docker/Podman containers. This guide covers the integration patterns, pitfalls, and solutions discovered during real-world development.

> **Prefer the helper library.** Most of the patterns below — manager discovery, tag validation, startup self-heal, `ensureRunning`, update registration, HTTP readiness, clean teardown — are packaged in [signalk-container-helper](https://github.com/hoeken/signalk-container-helper), a typed, zero-dependency wrapper (`ManagedContainer` / `AdoptedContainer`). New plugins should build on it and consult this guide for the underlying mechanics. The rest of this document describes the raw `globalThis.__signalk_containerManager` API the helper is built on.

## Quick Start

```typescript
// In your plugin's async startup function:
const containers = (globalThis as any).__signalk_containerManager;
if (!containers) {
  app.setPluginError("signalk-container plugin is required");
  return;
}

// Wait for runtime detection to settle (podman vs docker probe is async).
await containers.whenReady();
if (!containers.getRuntime()) {
  app.setPluginError("No container runtime detected");
  return;
}

// ensureRunning is the only call you need on every plugin start.
// signalk-container compares this config against the live container and
// removes + recreates automatically when anything has drifted — no
// hash-file dance required.
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

Plugins start in parallel. signalk-container exposes the API object on `globalThis` **synchronously** in `start()`, but it then probes the host for podman vs docker asynchronously — so `getRuntime()` returns `null` for a short window after the manager appears. Wait for that probe to settle with `whenReady()`:

```typescript
async function asyncStart(config) {
  const containers = (globalThis as any).__signalk_containerManager;
  if (!containers) {
    app.setPluginError("signalk-container plugin not available");
    return;
  }

  app.setPluginStatus("Waiting for container runtime...");
  await containers.whenReady();

  // whenReady resolves once detection settles in either direction —
  // success OR failure. Check getRuntime() to tell them apart.
  if (!containers.getRuntime()) {
    app.setPluginError("No container runtime detected (podman/docker missing)");
    return;
  }

  // Now safe to call ensureRunning()
}
```

`whenReady()` replaces the older `while (Date.now() < deadline) { … }` polling pattern. Available in signalk-container 1.6.0 and later. If you need to support older versions of signalk-container, pin your `peerDependencies` to `>=1.6.0` rather than maintaining a fallback polling loop.

---

## Podman vs Docker Differences

### Image names must be fully qualified for Podman

Podman without `unqualified-search-registries` configured rejects short names like `questdb/questdb:latest`. signalk-container handles this automatically by prefixing `docker.io/` when needed. You don't need to worry about this in your plugin — just pass the normal Docker Hub image name.

### SELinux volume flags

signalk-container adds `:Z` to volume mounts when using Podman (required on Fedora/RHEL for SELinux relabelling). Docker ignores this flag harmlessly. Your plugin doesn't need to handle this.

### Container naming

All containers are prefixed with `sk-` (e.g., `sk-signalk-questdb`). This avoids conflicts with user containers and makes cleanup predictable. Pass just your plugin name to `ensureRunning()` — the prefix is added automatically.

### Host timezone

Container images default to UTC, which makes time-based logic inside a managed container (a cron-style Node-RED flow, Grafana time rendering, log timestamps) disagree with the host clock. signalk-container therefore injects `TZ=<host zone>` into every managed container and one-shot job automatically. Your plugin doesn't need to handle this.

The rules:

- If your plugin sets `env.TZ` itself — any value, including `""` (POSIX for UTC) — that value wins and nothing is injected.
- If the SignalK process resolves to UTC (a genuinely-UTC host, or a containerized SignalK that wasn't told the host zone), nothing is injected — the container's UTC default already matches.
- The injected `TZ` participates in drift detection like any other env key, so existing containers on a non-UTC host are recreated once when this feature first applies.

`TZ` names an [IANA zone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) (e.g. `Pacific/Fiji`), which the software inside the container resolves through a timezone database. Runtimes that bundle their own tzdb (Node via ICU, Java via the JRE) honor it out of the box; shell-level tools like `date` in minimal glibc/musl images need the image's `tzdata` package.

---

## Container Config Changes

Just call `ensureRunning(name, config)` whenever your plugin starts or its configuration changes. signalk-container compares the requested config against the live container's effective state and automatically removes + recreates when any of `image`, `tag`, `command`, `networkMode`, `env`, `volumes`, or `ports` differ. `resources` changes are applied live where possible (see [Resource Limits](#resource-limits) below).

```typescript
await containers.ensureRunning("my-service", {
  image: "questdb/questdb",
  tag: config.version,
  ports: { "9000/tcp": "127.0.0.1:9000" },
  volumes: { "/data": app.getDataDirPath() },
  env: { MY_COMPRESSION: config.compression },
  restart: "unless-stopped",
});
```

Data is safe because volumes live on the host filesystem, not inside the container.

> **One footgun:** if you set `command`, set it consistently across calls. Toggling between an explicit `command` and `undefined` would compare `undefined` against the image's baked `CMD` and look like drift on every call. Either always set `command`, or never set it.

**Removed: hash-file pattern.** Earlier versions of this guide instructed plugins to maintain a `${dataDir}.container-hash` file and call `containers.remove()` themselves on mismatch. That pattern is no longer needed — and was easy to get wrong (each consumer plugin used a different field subset, missing fields the others included). Delete any `container-hash` reads/writes and any `state !== "missing" && hash differs` recreate logic. Restart the consumer plugin once and the central diff will reconcile any drift on the next `ensureRunning` call.

### Healthcheck for images that ship none

When an image declares a `HEALTHCHECK`, signalk-container makes it run reliably across runtimes — you get this automatically, no config needed.

The gap is images that declare **no** healthcheck at all (`questdb/questdb` is the canonical case). Under Podman such a container is reported as `starting` even though it is fully up and serving — there is no probe to ever run, so it never transitions to `healthy`, and the reported health stays wrong indefinitely.

Set `ContainerConfig.healthcheck` to supply a probe and resolve the health state:

```typescript
await containers.ensureRunning("signalk-questdb", {
  image: "questdb/questdb",
  tag: config.version,
  ports: { "9000/tcp": "127.0.0.1:9000" },
  volumes: { "/var/lib/questdb": app.getDataDirPath() },
  restart: "unless-stopped",
  healthcheck: {
    // Docker HEALTHCHECK array form. ["CMD", ...] execs the argv directly;
    // ["CMD-SHELL", "<string>"] runs it under a shell. The probe runs INSIDE
    // the container, so target the in-container port, not the host mapping.
    test: ["CMD", "curl", "-f", "http://127.0.0.1:9000/ping"],
    interval: "30s", // durations are passed to the runtime verbatim
    timeout: "5s",
    startPeriod: "15s", // grace before failures count
    retries: 3,
  },
});
```

Two things worth knowing:

- **Pick a probe that returns promptly.** The command must succeed (exit 0) while the service is healthy. QuestDB's `/ping` returns an empty `204` instantly; probing `/` instead makes `curl` hang on the web-console `301` redirect until it times out, which would drive the container _unhealthy_. Use the image's own tooling (`curl`/`wget` if present) against a lightweight liveness endpoint.
- **`healthcheck: false`** emits `--no-healthcheck`, so Podman reports the container with no health status instead of a stuck `starting`. Use this when the image has no healthcheck and you don't want one — it removes the phantom `starting` without adding a probe.

An explicit `healthcheck` wins over the image's own `HEALTHCHECK`. It is **not** part of drift detection — changing it does not recreate a running container (same as `restart` and `labels`); the new probe takes effect on the next recreate (image/env/volumes/ports change) or clean start. If your plugin has a second `ensureRunning` call site (e.g. an in-place "update now" path), set `healthcheck` there too, or an updated container regresses to `starting`.

> Availability: `ContainerConfig.healthcheck` requires signalk-container ≥ 1.14.0. On older versions the field is ignored — the container still runs, it just keeps the pre-fix `starting` state.

### Per-process ulimits (`nofile`, …)

A process inside a container inherits its per-process resource limits (`ulimit`) from the **container runtime**, not from the host's matching sysctl. The canonical trap is open files: raising the host's `fs.file-max` does **not** raise the container process's `nofile` (`RLIMIT_NOFILE`) — that comes from the runtime's default, which on rootless Podman is often far below what a database needs. QuestDB recommends `nofile=1048576` and otherwise logs an open-files warning and risks WAL corruption under heavy ingestion.

Set `ContainerConfig.ulimits` to pin the limit on the container, independent of the host login configuration:

```typescript
await containers.ensureRunning("signalk-questdb", {
  image: "questdb/questdb",
  tag: config.version,
  ports: { "9000/tcp": "127.0.0.1:9000" },
  volumes: { "/var/lib/questdb": app.getDataDirPath() },
  restart: "unless-stopped",
  ulimits: {
    nofile: 1048576, // a bare number sets soft = hard
    // or independent limits: nofile: { soft: 65536, hard: 1048576 }
  },
});
```

Keys are ulimit names (`nofile`, `nproc`, `memlock`, …); they map to the runtime's `Ulimits` ({ Name, Soft, Hard }) the same way on Podman and Docker. Values must be non-negative integers with `hard >= soft` — an invalid limit throws at `ensureRunning` time rather than surfacing as an opaque runtime create error.

`nofile` is **clamped to what the host can actually grant**. A rootless container cannot raise its `nofile` hard limit above the calling user's hard limit — the runtime rejects a higher request with `setrlimit RLIMIT_NOFILE: Operation not permitted` and the container fails to start. signalk-container reads the host ceiling (the Signal K process's own hard limit when rootless, `fs.nr_open` when rootful) and lowers an over-request to it, logging an advisory, so the container always starts with the best limit available instead of failing. Where the ceiling cannot be read at all (Signal K on macOS driving podman machine — the limits live inside the VM), the request goes through unclamped; if the runtime then rejects the start, signalk-container removes the failed container and retries once **without** the `nofile` entry, so the container runs with the runtime's default limits instead of never starting, and the same advisory reports the shortfall. To get the full requested value on a rootless host, raise the limit for the user running the container runtime — on Raspberry Pi OS / stock Debian this is usually done via `/etc/systemd/system.conf` `DefaultLimitNOFILE` + `systemctl daemon-reexec` + reboot. See the README ["Raising the open-files limit"](../README.md#raising-the-open-files-limit-nofile) section for the exact steps, then restart the container. After the rejection fallback specifically, remove the container once the host limit is raised — `podman rm -f <container>` (or `docker rm -f <container>`; the advisory's `reason` names the right command and the exact managed name, `sk-<name>` under the default `sk` namespace) — the fallback container carries no `nofile` request for the regrant probe to compare against, so a plain restart cannot re-grant it.

When a clamp happens signalk-container fires `EnsureRunningOptions.onUlimitClamped`, so the consumer can surface it instead of it only appearing in the container manager's debug log. Wire it to your plugin status so the operator sees the host limit is the bottleneck:

```typescript
await containers.ensureRunning("signalk-questdb", config, {
  onUlimitClamped: (e) =>
    app.setPluginStatus(
      `${e.ulimit} clamped ${e.requested} → ${e.granted} (host limit). ${e.reason}`,
    ),
});
```

The event carries `{ ulimit, requested, granted, reason }`. It is an advisory — the container is running with `granted` — so prefer `setPluginStatus` or a banner over `setPluginError`. After the rejection fallback, `granted` is the observed live hard limit, or `0` when no source is readable (the macOS podman-machine case) — treat `0` as _unknown_, not as a grant of zero, and surface `reason`, which always carries the full story and remediation.

When config drift needs a recreate but the runtime cannot stop or remove the live container (a permission error), signalk-container defers the recreate and fires `EnsureRunningOptions.onContainerWedged` **once** (not on every reconcile) with `{ name, drift, reason }`. The `reason` is tailored to the cause and carries the operator remedy: a rootless-Podman "operation not permitted" is diagnosed as an orphaned user namespace (an API-unrecoverable state that needs an out-of-band fix), while a Docker/rootful-Podman permission error or an EACCES gets the generic permission remedy and echoes the runtime's own message; when the container has a host bind mount, `reason` also notes that recording data survives a recreate. Surface `reason` verbatim rather than re-deriving it. The container cannot be recovered from the API, so surface it via `setPluginError` rather than `setPluginStatus`. The advisory re-arms automatically once the container recovers (a no-drift reconcile, a successful in-process recreate, or the container going missing). Requires signalk-container ≥ 1.29.0.

`cpus` is capped the same way. A `cpus` request above the container runtime's available CPU count — whether it comes from your plugin default or a user override — is lowered to that count during `ensureRunning` and `updateResources`. Docker refuses such a request outright (`--cpus 1.5` on a 1-vCPU host fails the container create); podman accepts it, but the extra grants nothing. The lowered value is what the container is created with and what later reconciles compare against, so it stays stable across restarts. If you pass `EnsureRunningOptions.onResourceClamped`, it fires with `{ resource: "cpus", requested, granted, reason }` so you can surface it like `onUlimitClamped` (same fire-and-forget contract); without a handler the clamp is a debug-log line in the container manager. If the runtime does not report a CPU count, `cpus` is left unchanged. Requires signalk-container ≥ 1.28.1.

Like `healthcheck` and `labels`, `ulimits` is **not** part of drift detection — changing it does not recreate a running container; the new limit takes effect on the next recreate (image/env/volumes/ports change) or clean start. If your plugin has a second `ensureRunning` call site (e.g. an in-place "update now" path), set `ulimits` there too so an updated container keeps the limit.

> Availability: `ContainerConfig.ulimits` requires signalk-container ≥ 1.17.0. On older versions the field is ignored — the container still runs, it just inherits the runtime's default ulimits.

### Read-only volumes

A volume can be bound read-only, for a directory another component owns:

```js
volumes: {
  // Charts published by signalk-charts-provider-simple: this container reads
  // them, the provider owns them.
  "/charts": { source: chartsPath, readOnly: true },
}
```

Requires signalk-container 1.30.0+; older versions ignore the field and bind
read-write, so treat it as defence in depth rather than a guarantee.

### Detecting a host device

Whether the machine has a GPU — or any device worth passing through — cannot be
answered from the plugin. `stat("/dev/dri")` reports on the plugin's own
filesystem, which is the Signal K container whenever Signal K is
containerized, and that container has no `/dev/dri` even on a machine that has
one. Ask signalk-container, which can see the host:

```js
const gpu = await containers.probeHostDevice?.("/dev/dri");
if (gpu?.exists) {
  config.devices = ["/dev/dri"]; // hot-plug directory form
  config.groupAdd = gpu.groups; // names, resolved on the host
}
```

`groups` are names rather than gids on purpose: the gid of `render` or `video`
differs per distro and per install, so a hardcoded number silently loses access
elsewhere.

`null` means **unknown** — no runtime, the path could not be read (a permission
error, say), or the nodes are there but their owning group could not be
determined. It is
deliberately distinct from `{ exists: false }`, which means definitely absent.
Assume no device, but do not tell the user there isn't one.

Works the same on Docker and rootless podman, though by different routes: see
the README's _Detecting host devices_ for why rootless podman cannot report
real gids and what the probe does instead.

### Optional and required volumes

By default, `volumes` entries with a missing host path are auto-created as empty directories by the runtime — fine for plugin state dirs. When a volume represents a _user-managed_ or _deployment-required_ resource, use the `VolumeSpec` object form with an `ifMissing` policy (it also carries `readOnly`, see [Read-only volumes](#read-only-volumes)):

- `"create"` (default, same as a bare string): runtime creates the host dir. Right for plugin state.
- `"skip"`: signalk-container drops the volume when the host path is missing; the container starts without the mount. Right for optional USB drives, NFS mounts, baseline scans.
- `"abort"`: signalk-container throws from `ensureRunning` with a clear error. Right for mounts the container cannot function without (TLS certs, deployment secrets, required state).

Wire `onVolumeIssue` in the options to react when a volume's source is missing, aborted, or recovered. The same callback fires for all three actions; switch on `event.action`. signalk-container detects recovery automatically: when a previously-missing source reappears on a subsequent `ensureRunning` call, the container is recreated to include the mount and the handler fires with `action: "recovered"`.

```typescript
await containers.ensureRunning(
  "my-backup",
  {
    image: "myorg/backup",
    tag: "latest",
    volumes: {
      "/data": app.getDataDirPath(), // auto-create
      "/usb": { source: "/media/dirk/USB-SSD", ifMissing: "skip" }, // optional
      "/certs": {
        source: "/etc/letsencrypt/live",
        ifMissing: "abort",
      }, // required
    },
  },
  {
    onVolumeIssue: (event) => {
      if (event.action === "skipped") {
        app.setPluginStatus(
          `Optional mount ${event.containerPath} not available`,
        );
      } else if (event.action === "aborted") {
        app.setPluginError(
          `Required mount ${event.containerPath} missing: ${event.source}`,
        );
      } else {
        // 'recovered' — clear any prior status
        app.setPluginStatus("Running");
      }
    },
  },
);
```

Named volumes (sources without a leading `/`) always pass through regardless of `ifMissing` — the runtime owns their lifecycle.

`onVolumeIssue` accepts either a synchronous handler or an `async` one. signalk-container fires the call but does not await it; both synchronous throws and rejected promises are caught and logged at error level so handler bugs cannot break container lifecycle. Keep handlers fast and side-effect-only (set plugin status, log).

### Auto-update on floating tags

By default, the `image+tag` string is compared as-is. A consumer that pins `tag: "latest"` (or `main`, `edge`, `nightly`, …) keeps running the digest it pulled on first install, even after the registry tag moves to a new image — `"latest"` matches itself, no drift, no pull.

Opt in to digest-drift detection by setting `autoUpdateOnFloatingTag: true` on the config. On every `ensureRunning` call where the tag classifies as floating, signalk-container pulls the tag and compares the registry-fresh image-id against the running container's image-id. A mismatch is treated as drift → remove + recreate.

```typescript
await containers.ensureRunning("my-service", {
  image: "ghcr.io/me/my-service",
  tag: "latest",
  autoUpdateOnFloatingTag: true,
  restart: "unless-stopped",
});
```

Semantics:

- The flag is **off** for every existing consumer plugin. Behavior is unchanged unless you opt in.
- The probe only fires on a floating tag (`classifyTag` classifies the tag as `"floating"`). Semver tags (`"9.0.0"`, `"v1.2.3"`) and unknown tags are not probed — the existing config-string drift check already catches a semver bump.
- If `digest` is set, the probe is skipped — the caller already pins to a digest and the config-string check covers it.
- Offline pulls are silently skipped (`ENOTFOUND`, `ENETUNREACH`, `ETIMEDOUT`, etc.). Boats at sea must never have their containers killed by a missing internet connection.
- Non-offline pull failures (auth, parse, permissions) are also skipped with a debug log — update probing never blocks plugin startup.
- Config-drift check runs first, then digest-drift. If config changed (env, volumes, ports), that recreate fires before any digest comparison. The two never both trigger.

Notification-only flow (without auto-recreate) is available separately via [`containers.updates.register({...})`](#update-detection) — that fires a `notifications.plugins.<id>.updateAvailable` Signal K notification but does not pull or recreate. Use the updates service when you want the user to confirm the upgrade; use `autoUpdateOnFloatingTag` when "follow the floating tag" is the intended behavior.

### Streaming container logs into your plugin's debug channel

When the user enables debug for your plugin (the toggle on the plugin configuration page), Signal K's `app.debug` lines appear in the server log. Without help, those lines show only what your plugin code logs — never the container's own stdout/stderr. Pass `onContainerLog` to fold the container's output into the same stream:

```typescript
await containers.ensureRunning("questdb", config, {
  onContainerLog: (line) => app.debug(`[questdb] ${line}`),
  // optional: backfill the last 100 lines on plugin restart so
  // you don't lose context when SK was restarted mid-run
  onContainerLogStartTail: 100,
});
```

The subscription survives auto-recreate (the tail re-attaches to the fresh container), is torn down on `containers.remove()`, and stopped on plugin `stop()`. Lines are combined stdout+stderr.

`onContainerLog` accepts either a synchronous handler or an `async` one. Both synchronous throws and rejected promises are caught and logged at error level — handler bugs cannot break container lifecycle.

End users get the same stream via the **Logs** button on every managed-container card in the config panel, regardless of whether your plugin wired `onContainerLog`.

For an explicit one-shot fetch (e.g. attaching log context to a health-check failure), use `containers.getLogs(name, { tail })` — returns the last N lines as a `Promise<string[]>`. One-shot output is grouped by stream (stdout lines first, then stderr), not true chronological interleave — the runtime CLI emits the two streams on separate fds and the OS-level ordering is lost before we see them. Use `onContainerLog` if you need real-time per-line ordering.

Both are available in signalk-container 1.7.0+.

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
{ runtime: 'podman', version: '5.4.2', isRootless: true, socketPath: '/run/user/1000/podman/podman.sock' }
```

### `whenReady(): Promise<void>`

Resolves once runtime detection has settled, in either direction (success OR failure). Use this once at plugin start instead of polling `getRuntime()` in a `while` loop. After it resolves, call `getRuntime()` to distinguish "detection succeeded" from "no runtime found":

```typescript
await containers.whenReady();
if (!containers.getRuntime()) {
  app.setPluginError("No container runtime detected");
  return;
}
// Safe to call ensureRunning / runJob / etc.
```

Available in signalk-container 1.6.0+.

### `ensureRunning(name, config, options?): Promise<void>`

Creates and starts a container if missing; starts it if stopped. If the container is already running OR stopped with **drifted config** (image, tag, command, networkMode, env, volumes, or ports differ from the requested config), it is removed and recreated transparently. Resource limits changes are applied live where possible — see [Resource Limits](#resource-limits).

Volumes accept either a bare host-path string (auto-create — runtime creates the host dir if missing) or a `VolumeSpec` object `{ source, ifMissing: "create" | "skip" | "abort" }` for per-volume policy. `options` is an `EnsureRunningOptions` (a superset of `HealthCheckOptions`) which also accepts an `onVolumeIssue` event handler. See [Optional and required volumes](#optional-and-required-volumes) for the full pattern.

`options` also accepts `onContainerLog` to stream the container's stdout/stderr into your plugin's debug channel — see [Streaming container logs](#streaming-container-logs-into-your-plugins-debug-channel) — and `onUlimitClamped`, fired when a requested `nofile` ulimit could not be granted as asked — lowered to the host ceiling at create, or dropped after the runtime rejected the start — see [Per-process ulimits](#per-process-ulimits-nofile-). It also accepts `onResourceClamped` (a `cpus` cap lowered to the daemon's CPU count) and `onContainerWedged` (a drift recreate deferred because the runtime cannot stop or remove the container), both described under [Per-process ulimits](#per-process-ulimits-nofile-).

For opt-in digest pinning, pass `digest` (`sha256:<64-hex>`) on the config and `pluginId` / `pluginVersion` on the options — see [Image Pinning Manifest](#image-pinning-manifest). To follow a floating tag (`latest`, `edge`, …) and auto-recreate when the registry moves, set `autoUpdateOnFloatingTag: true` — see [Auto-update on floating tags](#auto-update-on-floating-tags).

`ContainerConfig.user` controls the host-UID mapping for files the container creates on bind mounts — see [Host-UID Ownership](#host-uid-ownership). `ContainerConfig.extraHosts` lets you add hostname → IP entries to `/etc/hosts`; signalk-container automatically maps `host.containers.internal` to `host-gateway` on Docker (Podman has it natively), and a user value passed in `extraHosts` is respected as an override.

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

### `recreate(name, config, options?): Promise<void>`

_Available in signalk-container 1.12.0+._

Force-recreates a managed container: removes the existing one (running or stopped) if present, then creates it fresh from `config`. Unlike `ensureRunning` — which short-circuits on "already running with matching config" — `recreate` always replaces the container, briefly interrupting it.

Use this when your plugin knows the desired state differs from live and wants to apply it now without depending on drift detection. The two canonical cases:

1. **Plugin startup self-heal** — your plugin pins an image version through a constant and bumped it in this release. Compare the live container's image against the desired one and call `recreate` when they differ, rather than relying on `ensureRunning`'s drift recreate (which a stale or future version of signalk-container could fail to honour).
2. **"Update now" UX** — the user clicked an explicit update button in your plugin's UI. `recreate` is the clean primitive for "stop, pull, restart with the new tag" without re-implementing the stop / pull / remove / ensureRunning sequence yourself.

Volume policy, `signalkAccessiblePorts`, `signalkConfigRootMount`, and `signalkDataMount` are resolved identically to `ensureRunning`. The same `options` shape applies — including `onVolumeIssue`, `onContainerLog`, `healthCheck`, `pluginId`, and `pluginVersion`.

```typescript
// Plugin-startup self-heal: live container's image disagrees with our pinned tag.
const live = await containers.listContainers();
const found = live.find((c) => c.name === `sk-${CONTAINER_NAME}`);
const desiredImage = `${BACKUP_IMAGE}:${resolvedTag}`;
if (found && found.image !== desiredImage) {
  await containers.recreate(CONTAINER_NAME, buildContainerConfig(resolvedTag), {
    onVolumeIssue,
  });
} else {
  await containers.ensureRunning(
    CONTAINER_NAME,
    buildContainerConfig(resolvedTag),
    { onVolumeIssue },
  );
}
```

`recreate` is idempotent against final state but always pays the brief downtime of a stop+create cycle. Prefer `ensureRunning` for the common "make sure my container is up with my config" path; reach for `recreate` only when you need a guaranteed fresh container.

### `start(name): Promise<void>`

Starts a stopped container. Throws if container doesn't exist.

### `stop(name): Promise<void>`

Stops a running container. Idempotent.

### `remove(name): Promise<void>`

Stops and removes a container. Idempotent.

### `removeManagedData(name, hostPath, options?): Promise<void>`

Removes a managed container **and** deletes its bind-mount data directory. Use this for plugin teardown / uninstall data cleanup — not the plain `fs.rmSync(dataDir)` you might reach for first.

Why it exists: on **rootless Podman** with the default `--userns=keep-id:uid=0,gid=0` mapping, a container process that writes as a non-root in-container UID (QuestDB is the canonical case) creates bind-mount files owned by a host **subuid** (e.g. `110000`), not by the Signal K user. A host-side `fs.rmSync` from the Signal K process (uid 1000) then fails with `EACCES`, and the data directory survives the uninstall. Stopping the container first does not help — it is file ownership, not a held mount.

What it does:

1. Stops + removes the container `name` (idempotent — a missing container is fine).
2. Tries a direct host-side recursive delete of `hostPath`. On docker / rootful Podman the files are host-owned and this is all that runs.
3. On `EACCES`/`EPERM` it runs a one-shot helper under the default userns mapping (so it runs as in-container root, which owns the subuid files), bind-mounts `hostPath`, and `rm -rf`s its contents from inside the userns. The now-empty host-owned parent dir is then removed host-side.

The helper reuses the **container's own image** (captured by inspecting it before removal), so cleanup never triggers a registry pull — important on an offline boat. Pass `options.ownerPluginId` so a crash mid-wipe can be reaped by [`cleanupOrphanedJobs`](#cleanuporphanedjobsfilter-promisecleanuporphansresult). The call refuses to operate on an empty path or a filesystem root; pass an absolute path under your plugin's data dir. It never reports success while data remains — if the in-userns wipe also fails, it rejects with the runtime reason. The one case it cannot cover is a container that was already gone _and_ a directory the host user can't delete (no known image to run the helper); it then throws asking the operator to delete the directory manually. Available in signalk-container 1.18.0+.

```ts
// plugin uninstall / "delete all data" path
await containers.removeManagedData("questdb", questdbDataDir, {
  ownerPluginId: "signalk-questdb",
});
```

### `getState(name): Promise<ContainerState>`

Returns `'running'`, `'stopped'`, `'missing'`, or `'no-runtime'`.

### `getStateDetail(name): Promise<ContainerStateDetail>`

The same coarse `state`, plus why it is in that state. `getState()` alone
cannot tell a container that has crashlooped from one the operator stopped —
both report `'stopped'`.

```ts
const { state, exitCode, oomKilled } =
  await containers.getStateDetail("questdb");
// state 'stopped' either way; exitCode 137 + oomKilled true is the crash
```

See `ContainerStateDetail` in `signalk-container/types` for the full shape.
Every field beyond `state` is optional: a runtime that does not report one
leaves it `undefined` rather than defaulting to `0`, which would read as a
clean exit that never happened.

`restartCount` is cumulative over the container's life, not a fault count —
it is legitimately non-zero on a healthy long-lived container under
`restart: 'unless-stopped'` after a host reboot. Read it as a rate over time
if you want to detect a crashloop, never as a raw threshold.

`exitCode` may still carry the previous run's value while a container is
running, so read it against `state` rather than on its own.

### `getContainerNofile(name): Promise<NofileLimits | null>`

Reads the `nofile` (`RLIMIT_NOFILE`) limits the managed container is
_actually_ running with — as opposed to the value requested at create time,
which may have been clamped to the host ceiling. Primary source is the live
`/proc/<container-pid>/limits`; falls back to the create-time
`HostConfig.Ulimits` echoed by inspect. Returns `null` when the container
does not exist or neither source is available — treat `null` as "unknown",
never as a limit. Use it to verify whether a previously reported ulimit
clamp still reflects reality (e.g. clear a "capped by the host" advisory
once the container runs with the full requested limit). Available in
signalk-container 1.25.3+.

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
  // Optional per-stream callbacks. Both fire alongside onProgress, so use
  // them only when you need to distinguish stdout (e.g. structured progress
  // markers) from stderr (e.g. tool diagnostics).
  onStdoutLine: (line) => parseStructuredProgress(line),
  onStderrLine: (line) => captureDiagnostic(line),
  // Optional cgroup limits applied via --cpus / --memory / --pids-limit etc.
  // Without this, a CPU-bound helper can saturate every core regardless of
  // any in-process thread cap the caller may have set via env. Jobs also
  // run at the user's "CPU priority: jobs" tier (default lowest, i.e.
  // cpuShares 128) unless you set cpuShares here yourself.
  resources: { cpus: 2, memory: "1g" },
  label: "parquet-export",
  // Strongly recommended for any long-running job. Tags the container
  // with `sk-job-owner=<id>` so cleanupOrphanedJobs() can find and reap
  // it after a Signal K crash. Use your plugin's `id` from package.json.
  // Available in signalk-container >= 1.3.0.
  ownerPluginId: "signalk-charts-provider-simple",
  // Optional AbortSignal to cancel the job mid-run. Aborting force-removes
  // the running container and resolves with status "cancelled". This is the
  // only way to interrupt a single long step (e.g. a tile-join) — stopping
  // your own dispatch loop only cancels between jobs, not during one.
  // Available in signalk-container >= 1.16.0.
  signal: abortController.signal,
});

if (result.status === "completed") {
  console.log("Exit code:", result.exitCode);
  console.log("Output:", result.log);
} else if (result.status === "cancelled") {
  console.log("Job was cancelled via its AbortSignal");
}
```

To cancel, hold the `AbortController` and call `abort()` — e.g. from a REST handler wired to a UI Cancel button:

```typescript
const abortController = new AbortController();
const jobPromise = containers.runJob({
  ...config,
  signal: abortController.signal,
});
// later, on user request:
abortController.abort(); // jobPromise resolves with status "cancelled"
```

A signal already aborted when `runJob` is called (or aborted during the
image pull) returns `cancelled` without leaving a container running. A job
that finishes on its own is unaffected — a later `abort()` is a no-op.

### `getLogs(name, options?): Promise<string[]>`

One-shot capture of a managed container's combined stdout/stderr log. Mirrors `podman logs --tail <N> [--since <ts>] sk-<name>`. Useful for attaching log context to a health-check failure, or for backfill scenarios that bypass the streaming broker.

```typescript
const lines = await containers.getLogs("questdb", { tail: 50 });
console.log(lines.join("\n"));
```

`tail` defaults to 200, max 10000 (enforced server-side). `since` is unix-epoch seconds (optional). Throws if the container doesn't exist or the runtime isn't initialised. For live streaming see [`onContainerLog`](#streaming-container-logs-into-your-plugins-debug-channel) in `ensureRunning` options. Available in signalk-container 1.7.0+.

### `cleanupOrphanedJobs(filter): Promise<CleanupOrphansResult>`

Reap `sk-job-*` containers leaked by a previous server lifecycle (Signal K crashed or restarted mid-job, the helper container kept running with no parent listener). Stops and removes each matching container with `--force` and returns a record of what was reaped, so the plugin can scrub any persistent state it had associated with those jobs (a "currently converting" flag, an install record that was written before the conversion ran, etc.).

Filters by the `sk-job-owner` label written by `runJob` when the caller provided `ContainerJobConfig.ownerPluginId`. Plugins that omit `ownerPluginId` on their job configs cannot be reaped by this API — there is no safe way for one plugin to claim another's containers.

Idempotent: if there are no orphans, returns `{ reaped: [] }`. Available in signalk-container >= 1.3.0.

Typical wiring in the consumer plugin's `start()`, after the manager has been resolved via the `whenReady()` pattern shown in the "Startup order" section above:

```typescript
const containers = (globalThis as any).__signalk_containerManager;
if (!containers || !containers.getRuntime()) {
  return; // signalk-container not available; normal degraded path
}

// Reap any helper containers leaked by a previous Signal K crash mid-job.
// Each entry in `reaped` is one orphan we just stopped + removed.
const cleanup = await containers.cleanupOrphanedJobs({
  ownerPluginId: "signalk-charts-provider-simple",
});
for (const orphan of cleanup.reaped) {
  app.debug(
    `Reaped orphan job: ${orphan.name} (${orphan.label ?? "no label"})`,
  );
  // Plugin-specific rollback: clear the converting flag, drop the install
  // record we wrote before the job ran, etc. The runtime layer can't know
  // what semantic state your plugin attached to the job. Guard against
  // an orphan that wasn't tagged with a label — without one there's
  // nothing to identify which install record to roll back.
  if (orphan.label) {
    removeStaleInstallByJobLabel(orphan.label);
  }
}
```

The label that comes back on each `OrphanJobInfo.label` is whatever the caller passed in `runJob({ label: "..." })`. A common pattern is to encode the entity the job operated on (`label: \`tippecanoe-${chartNumber}\``) so the cleanup pass can identify which install record to roll back.

### `prune(): Promise<PruneResult>`

Removes dangling images.

```typescript
{ imagesRemoved: 3, spaceReclaimed: '1.2 GB' }
```

### `listContainers(): Promise<ContainerInfo[]>`

Lists all `sk-` prefixed containers.

### `resolveContainerAddress(name, port): Promise<string | null>`

The `host:port` (or `container-name:port`) your plugin should connect to
after `ensureRunning()`. Which form you get depends on how SignalK itself is
deployed, so constructing the address yourself is unsafe.

Pair it with `signalkAccessiblePorts` in your `ContainerConfig`: declare the
ports SignalK needs to reach, then ask the resolver where to connect.

### `ensureNetwork(name): Promise<void>`

Creates a user-defined network if it does not exist. Idempotent — calling it
for a network that is already there is a no-op, not an error.

**Prefer `signalkAccessiblePorts`.** It declares intent ("SignalK needs to
reach port 9000") and lets signalk-container choose the networking strategy.
These four network methods are the manual escape hatch for topologies that
need explicit control, such as several managed containers that must talk to
each other but not to SignalK.

### `removeNetwork(name): Promise<void>`

Removes a network. Idempotent — removing one that does not exist is a no-op.
A network still holding a container cannot be removed; remove the containers
first.

### `connectToNetwork(containerName, networkName): Promise<void>`

Attaches a managed container to an additional network. Takes the unprefixed
name; the namespace prefix is resolved for you.

A container created on the default rootless network cannot be attached to a
user-defined one; the runtime rejects it. Create it on a user-defined
network via `networkMode` if you intend to attach more later.

### `disconnectFromNetwork(containerName, networkName): Promise<void>`

Detaches a managed container from a network. Idempotent.

### `execInContainer(name, command): Promise<{ exitCode, stdout, stderr }>`

Runs a command inside a running managed container and returns its exit code
and output. Intended for probes and one-off queries; for real work that
needs its own lifecycle use `runJob()` instead, which gets a fresh container
and does not depend on the target being up.

### `getImageDigest(imageOrContainer): Promise<string | null>`

Returns the local image ID (sha256 digest) for an image reference or container name. Returns `null` if not present locally. Used internally by the update detection service for floating-tag drift checks, but exposed to plugins that want to do their own digest comparison.

### `resolveHostPath(absPath): Promise<{ source, subPath } | null>`

Translates an arbitrary absolute path into the `(source, subPath)` pair you need to mount it into a managed container, regardless of how Signal K itself is deployed.

Use this when a plugin needs to mount a path that is NOT `app.getDataDirPath()` — for example a chart directory, a download cache, or any user-configured location. `resolveSignalkDataMount()` handles the data dir specifically; this is its general-purpose counterpart.

```typescript
const r = await containers.resolveHostPath("/opt/signalk/charts");
if (!r) {
  app.setPluginError(
    "Chart directory is not reachable from the container runtime. " +
      "Move it under app.getDataDirPath() or bind it into the Signal K container.",
  );
  return;
}

await containers.runJob({
  image: "myorg/converter",
  command: [
    "convert",
    `/in/${r.subPath}/foo.zip`,
    `/out/${r.subPath}/foo.mbtiles`,
  ],
  inputs: { "/in": r.source },
  outputs: { "/out": r.source },
});
```

Resolution rules:

- **Bare-metal Signal K**: `{ source: absPath, subPath: "" }` — the absolute path is its own host path.
- **Signal K in a container with a bind mount covering `absPath`** (or any of its parents): `{ source: <resolved host path>, subPath: "" }`. The runtime can subpath-bind the host filesystem, so we narrow the source as much as possible.
- **Signal K in a container with a named volume covering `absPath`**: `{ source: <volume name>, subPath: <path inside the volume> }`. Named volumes can't be subpath-mounted, so the consumer mounts the whole volume and navigates to `subPath` inside.
- **No mount covers `absPath`**: returns `null`. Surface an actionable error instead of passing `null` through to `runJob`.

### `getResources(name): ContainerResourceLimits`

Returns the currently effective (merged plugin default + user override) resource limits for a managed container. Empty object `{}` if the container isn't tracked or has no limits.

```typescript
const effective = containers.getResources("my-db");
// → { cpus: 2, memory: "1g", memorySwap: "1g", pidsLimit: 200 }
```

Prefer this over direct `podman inspect` because it reflects the merge logic and stays in sync with user overrides applied via the config panel or REST API. For the raw user override (the diff stored in plugin config), read `GET /api/containers/:name/resources` which also returns an `override` field.

### `updateResources(name, limits): Promise<UpdateResourcesResult>`

Apply new resource limits to a running container, merging `limits` against the consumer plugin's pristine default captured at `ensureRunning` time. Tries `podman update` first (live, no downtime), falls back to stop+remove+ensureRunning if the runtime refuses (e.g. `cpusetCpus` on a host without cgroup delegation, or unsetting a `memory` limit which create-time-only fields can't do live).

```typescript
const result = await containers.updateResources("my-db", {
  cpus: 3.0, // just the field the user changed
});
console.log(result.method); // "live" or "recreated"
console.log(result.warnings); // optional messages (e.g. cgroup drops)
```

The input `limits` is treated as a diff: fields you don't include are inherited from the plugin default. Fields set to `null` are explicit unsets. The minimized override (only fields actually different from the default) is stored in plugin config and persisted automatically via `savePluginOptions`.

If the recreate path is taken and fails, signalk-container attempts rollback to the previous working config before throwing. If rollback also fails, the plugin enters an error state and the error message names both failures clearly.

Throws if `name` has no cached `ContainerConfig` — i.e. if the consumer plugin hasn't called `ensureRunning` yet during this Signal K session. That's normally impossible during normal operation since consumer plugins always call `ensureRunning` at startup.

### `containers.manifest.get(pluginId): Promise<ConsumerManifest | null>`

Returns the persisted manifest for a consumer plugin, or `null` if no manifest exists yet. The manifest records the declared/resolved digests, the resolved-from-tag fallback, the update channel, and a bounded history of digest changes per container. Writes happen only as a side-effect of successful `ensureRunning` calls — this getter is read-only.

```typescript
const manifest = await containers.manifest.get("signalk-questdb");
console.log(manifest?.containers["questdb"]?.resolvedDigest);
```

### `containers.manifest.list(): Promise<ConsumerManifest[]>`

Returns every persisted manifest. Used by the admin UI to render the per-plugin pinning view.

### `containers.manifest.getContainerHistory(containerName): Promise<HistoryEntry[]>`

Returns the bounded history (max 20 entries) of digest changes for a specific container, regardless of which plugin owns it. Useful for forensics on "why does this work on boat A but not boat B" — the history records `from`/`to` digests, ISO timestamps, and the triggering plugin version.

```typescript
const history = await containers.manifest.getContainerHistory("questdb");
// → [{ ts, from, to, reason: "plugin-install" | "plugin-update" | ..., triggeredBy }]
```

Returns `[]` if the container has no manifest entry (e.g. it predates the manifest layer or `ensureRunning` has never been called for it in this Signal K session).

### `containers.doctor.imageRunsAsUser(image, user?): Promise<ImageProbeResult>`

Probe whether `image` can run cleanly under the host-UID mapping signalk-container will emit for managed containers — i.e. that `/tmp` is writable for the host caller and the image doesn't depend on a writable `~/.<x>` or a root-only path. Use this _before_ adopting an unfamiliar image, instead of debugging a wedged container after the fact.

The probe starts the image with the same `--user` / `--userns` flags `ensureRunning` would emit for the given `user` value, executes `touch /tmp/x && echo ok`, and reports the result. Never throws — non-zero exit, missing binary, and exec failures all surface as `{ ok: false, error }`.

```typescript
const probe = await containers.doctor.imageRunsAsUser("myorg/worker:1.2.3");
if (!probe.ok) {
  app.setPluginError(`image not UID-compatible: ${probe.error}`);
  app.debug(probe.output); // combined stdout/stderr from the probe run
}
```

Pass `user` to test a specific mapping — e.g. an image whose `USER` directive sets `1001`:

```typescript
await containers.doctor.imageRunsAsUser("myorg/worker:1.2.3", {
  inImageUid: 1001,
  inImageGid: 1001,
});
```

Returns `{ ok: true, output: "ok\n" }` on success; `{ ok: false, output, error }` on failure. Available in signalk-container 1.8.0+.

### `containers.doctor.selfDeployment(): Promise<SelfDeploymentResult>`

Diagnose the Signal K deployment itself — distinct from the per-image probe above. Answers "is my host actually set up to drive `podman`/`docker` at all, and (when SK is containerised) are the in-container prerequisites met?" Used by signalk-container at startup to turn vague "no runtime found" errors into actionable remediation, and exposed to consumer plugins for the same purpose if they want to surface it in their own diagnostics.

Returns a `SelfDeploymentResult` (see `src/types.ts`) whose `status` is one of:

| Status               | Meaning                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`                 | Runtime socket reachable, daemon answered; when containerised, self-id also resolved.                                                              |
| `no-runtime`         | No `podman` or `docker` binary in `$PATH`.                                                                                                         |
| `socket-unreachable` | Binary present, but `<binary> info` could not contact a daemon (no socket mounted, daemon not running, etc.).                                      |
| `permission-denied`  | Binary + socket present, but the daemon rejected the caller (UID/group mismatch).                                                                  |
| `self-id-unresolved` | SK is containerised, daemon is reachable, but `SIGNALK_CONTAINER_ID` / `HOSTNAME` / `/proc/self/cgroup` all failed to identify SK's own container. |

Each failure status carries a `remediation: string[]` of copy-pasteable lines tailored to the failure mode. Never throws.

```typescript
const dx = await containers.doctor.selfDeployment();
if (dx.status !== "ok") {
  app.setPluginError(
    `signalk-container cannot run: ${dx.status}\n` + dx.remediation.join("\n"),
  );
}
```

Also surfaced over REST at `GET /plugins/signalk-container/api/doctor/deployment`. Available in signalk-container 1.9.0+.

### `containers.doctor.generateSetupSnippet(format?, result?): Promise<SetupSnippetResult>`

Pure-templating companion to `selfDeployment()`: produces a ready-to-paste `docker-compose.yml` fragment (`format: "compose"`, the default) or a `podman run` / `docker run` shell command (`format: "run"`) tailored to the detected runtime — the snippet wires up the socket bind-mount. A `dockerfile` note confirms no image change is needed (signalk-container talks to the runtime over the socket, not a CLI), and a `notes` array carries operator-facing caveats.

Useful when a consumer plugin wants to surface "you need to deploy Signal K with these settings" guidance in its own onboarding UI rather than redirecting the user to signalk-container's admin panel.

```typescript
const r = await containers.doctor.generateSetupSnippet("compose");
console.log(r.snippet); // YAML fragment
console.log(r.dockerfile); // image prereqs
r.notes.forEach((note) => console.log("note:", note));
```

By default the snippet uses the host UID/GID detected at runtime detection time; pass an explicit `result` to template against a hypothetical deployment shape (e.g. for tests or for rendering a "what if" walkthrough).

Also surfaced over REST at `GET /plugins/signalk-container/api/doctor/snippet?format=compose|run` — plain text by default, JSON via `Accept: application/json`. Available in signalk-container 1.10.0+.

---

## Host-UID Ownership

Managed containers run by default under the **Signal K host user's UID/GID**, so files the container creates on bind-mounted host paths are owned by the same identity that runs Signal K. No recursive `chmod` sweeps, no "root-owned files in `~/.signalk`" surprises.

How the translator achieves that varies by runtime:

| Runtime                      | Mechanism                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| Rootless Podman              | User-namespace remapping that translates the in-image UID/GID back to the host caller. |
| Docker (rootless or rootful) | Direct UID/GID translation — the in-container process runs as the host caller's IDs.   |
| Rootful Podman               | Same direct UID/GID translation as Docker.                                             |
| Windows                      | No translation — Docker Desktop handles UID/GID mapping internally.                    |

Consumer plugins do not have to call anything special — the default mapping just works for the typical case (image runs as root, container writes files that Signal K then reads). The exact CLI flags emitted for each runtime are an implementation detail of `userMappingFlags` in `src/runtime.ts`; consult it (and the matching tests) if you need to see the literal form for a given variant.

### When to set `ContainerConfig.user`

Only when the image declares a **non-root `USER`** directive. The `inImageUid` / `inImageGid` defaults are `0` (root); for an image with `USER 1001` you must tell the translator so the keep-id mapping picks the right starting point:

```typescript
await containers.ensureRunning("my-worker", {
  image: "ghcr.io/myorg/worker", // image declares USER 1001
  tag: "1.2.3",
  user: { inImageUid: 1001, inImageGid: 1001 },
  // ...
});
```

Get this wrong and rootless Podman will translate the in-image UID to the wrong host UID; the container will look fine until it writes a file and you discover the bind-mounted host path is owned by some random subuid.

### Opting out: `user: false`

Pass `false` if the image must run as root (or manages its own user model entirely) and you don't need host-aligned ownership on bind mounts:

```typescript
await containers.ensureRunning("legacy-worker", {
  image: "legacy/needs-root",
  tag: "v1",
  user: false, // no --user, no --userns
  // ...
});
```

The container then runs with whatever the image's `USER` directive specifies, with no flag emitted by signalk-container.

### Image requirements for UID-aligned containers

An image that signalk-container starts under the default ownership mapping must:

- **Run cleanly as a non-root UID** passed via the runtime's user/userns mechanism. The image cannot assume root privileges for setup; anything that needs root must happen at build time.
- **Have a writable `HOME` for the runtime UID.** Image entrypoints that touch `~/.config` or any dotfile in `$HOME` fail otherwise. The right pattern is a dedicated non-root user with its own home directory created at build time (see the Dockerfile example below). When you can't change the user — e.g. an upstream image that hardcodes `HOME=/root` — set `ENV HOME=/tmp` (or another per-UID-writable path) in a thin wrapper image instead. Do not work around this by making `/root` world-writable; that erases the security boundary the dedicated user provides.
- **Have a writable `/tmp` for the runtime UID.** Default `1777` is fine; the doctor probe checks exactly this.
- **Not depend on root-only paths at runtime.** `/root`, ownership of `/var/run`, `chown` on bind-mounted host paths in the entrypoint — all break under the mapping.
- **Not call `chmod` or `chown` against host-mounted paths in its entrypoint.** The whole point of the UID alignment is that files are already correctly owned at creation; an entrypoint that re-asserts ownership is fighting the model and will silently no-op on FAT/exFAT/NTFS bind sources anyway.

If you control the image's Dockerfile, the cleanest pattern is a dedicated non-root user with a real home directory:

```dockerfile
RUN useradd -m -u 1001 -s /bin/sh worker
USER worker
```

Then declare `user: { inImageUid: 1001, inImageGid: 1001 }` on the `ContainerConfig` so the rootless-Podman remap picks the right starting point.

If you're adopting a third-party image and it doesn't meet these criteria, options in rough order of preference:

1. Run the doctor probe (next subsection) to confirm the breakage and the failure mode.
2. File an upstream fix if the image is maintained — most popular images are happy to accept a non-root patch.
3. Use `user: false` to opt out of the mapping (the image runs as root, files on bind mounts are owned by root on the host — back to the pre-1.8.0 behavior).
4. Build a thin wrapper image that fixes the ownership requirements at build time.

### Verifying compatibility ahead of time

Before adopting an unfamiliar image, run `containers.doctor.imageRunsAsUser(image, user?)` (see API reference above). It catches the common failure modes (`/tmp` not writable for the host UID, image entrypoint touches `~` and `$HOME` isn't writable for that UID) up-front, instead of leaving you to debug a container stuck in a restart loop with a cryptic error.

### `ContainerJobConfig.user`

`runJob` accepts the same `user` field with identical semantics. Both code paths share the flag translator, so a probe that passes for `ensureRunning` also passes for `runJob`.

### Reading the resolved host identity

`getRuntime()` returns `hostUser: { uid, gid } | null` (null on Windows). Most plugins don't need it — the translator handles the mapping internally — but it's available for diagnostics:

```typescript
const rt = containers.getRuntime();
app.debug(`Signal K runs as ${rt?.hostUser?.uid}:${rt?.hostUser?.gid}`);
```

---

## Image Pinning Manifest

Consumer plugins can opt in to **digest pinning** to declare "this plugin has been tested against this exact image digest." When set, signalk-container pulls `image@digest` instead of `image:tag` and records the resolved manifest digest of the running container in a per-plugin lock-file.

```typescript
await containers.ensureRunning(
  "questdb",
  {
    image: "questdb/questdb",
    tag: "9.0.0",
    digest:
      "sha256:1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b",
    updateChannel: "digest:explicit", // or "tag:7.x", "tag:latest"
  },
  {
    pluginId: "signalk-questdb", // npm package name
    pluginVersion: "1.0.0", // your plugin's version
  },
);
```

All four fields are optional. The behavior matrix:

| Plugin passes         | Runtime                                                 | Manifest                                                                                |
| --------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| nothing new           | Pulls `image:tag` as today                              | Recorded under synthetic `container:<name>` id with the live RepoDigest                 |
| only `digest`         | Pulls `image@digest`                                    | `declaredDigest` set; first call recreates the container because `Config.Image` changes |
| only `pluginId`       | Pulls `image:tag`                                       | Recorded under the real plugin id                                                       |
| `digest` + `pluginId` | Pulls `image@digest`, recorded under the real plugin id | Full pinning                                                                            |

`pluginId` is validated at write time: it must be a valid npm package name (`signalk-questdb`), a scoped form (`@signalk/foo`), or — if absent — the synthetic fallback `container:<name>` that signalk-container uses internally.

Manifests are persisted under `${dataDir}/signalk-container-manifests/`. The canonical pluginId always lives inside the JSON. Always read via `containers.manifest.get(pluginId)` rather than touching the files directly.

`updateChannel` is recorded on the manifest and accepts these shapes:

- `"tag:<pattern>"` — semver-aware within a tag pattern, e.g. `"tag:7.x"`.
- `"tag:latest"` / `"tag:main"` — floating-tag digest-drift detection.
- `"digest:explicit"` — updates flow only via plugin releases.

If omitted, signalk-container defaults to `"tag:<tag>"`.

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

1. **`register()` is safe to call before runtime is ready.** It's pure bookkeeping — the scheduler defers the first tick until `getRuntime()` returns non-null. Your plugin still must `await containers.whenReady()` before doing other container operations, but the registration call itself is safe.
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

| Field               | Runtime flag           | Use case                                                                                                                                                                                        |
| ------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cpus`              | `--cpus`               | Hard CPU cap via CFS quota. e.g. `1.5` = 1.5 cores. **The most important field for stability.** Capped to the daemon's CPU count (Docker rejects more); see `onResourceClamped` below.          |
| `cpuShares`         | `--cpu-shares`         | Soft weight, unset = cgroup `cpu.weight` 100 (an explicit 1024 is 39 on crun, 100 on runc ≥ 1.3.2). Only matters under contention. Prefer the plugin's tiers: 5120 high / 512 low / 128 lowest. |
| `cpusetCpus`        | `--cpuset-cpus`        | Pin to specific cores, e.g. `"1,2"`. Useful for "keep mayara off core 0 where Signal K runs".                                                                                                   |
| `memory`            | `--memory`             | Hard memory cap. Container is OOM-killed if it exceeds this. **Critical for OS stability.**                                                                                                     |
| `memorySwap`        | `--memory-swap`        | Total memory + swap. Set equal to `memory` to disable swap entirely. Recommended for predictability.                                                                                            |
| `memoryReservation` | `--memory-reservation` | Soft floor — kernel reclaims first from containers above this when host is under memory pressure.                                                                                               |
| `pidsLimit`         | `--pids-limit`         | Process/thread cap. Prevents fork bombs and runaway thread leaks.                                                                                                                               |
| `oomScoreAdj`       | `--oom-score-adj`      | OOM score adjustment, -1000..1000. Higher = killed first under host OOM. Set high on "I'd rather lose this than Signal K".                                                                      |

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

### v0.1.8 semantic refinements (important for plugin authors)

v0.1.8 tightened the merge semantics so the system behaves predictably across plugin updates and user interactions. As a plugin author you don't need to do anything special — these are invariants signalk-container enforces automatically — but understanding them helps you reason about edge cases.

**1. Stored overrides are minimized against your plugin default.**

When a user applies an override via the UI or REST API, signalk-container compares the submitted payload against your pristine `config.resources` (captured at `ensureRunning` time) and stores only the fields that actually differ. For example, if your default is `{cpus: 1.5, memory: "512m", memorySwap: "512m", pidsLimit: 200}` and the user applies `{cpus: 2, memory: "512m", memorySwap: "512m", pidsLimit: 200}` (because the form was seeded from current effective state), the stored override becomes just `{cpus: 2}` — the memory/swap/pids values match the default, so they're dropped.

Consequence: **if you bump your plugin's default memory from `"512m"` to `"1g"` in a future version, users who only overrode `cpus` automatically get the new memory default.** Their override doesn't pin them to the old value.

**2. `updateResources` merges the payload against your plugin default before applying.**

When the user POSTs `{cpus: 2}` to `/api/containers/:name/resources`, signalk-container internally does `mergeResourceLimits(pluginDefault, {cpus: 2})` before applying to the container. The container ends up with `{cpus: 2, memory: "512m", memorySwap: "512m", pidsLimit: 200}` — the user's change plus all of your defaults. Without this merge, the user's partial payload would wipe the other fields.

Consequence: **users can submit partial payloads without losing your other defaults.** Scripts hitting the REST API don't need to know your full default set.

**3. Reset-to-default via `DELETE /api/containers/:name/resources`.**

The UI's "Reset to default" button and the DELETE endpoint do three things atomically: apply your pristine `config.resources` to the running container (live or via recreate), clear the user's stored override (`containerOverrides[name]` → deleted from plugin config), and persist the cleared state to disk. Users can go back to "pure plugin default" with one click, including explicit unsets that would otherwise require a manual JSON edit.

**4. `getContainerState` is robust against transient runtime state flap.**

The underlying podman/docker `inspect` call can briefly report inconsistent `.State.Status` values under concurrent load (observed on rootless podman with systemd cgroup delegation). v0.1.8's `getContainerState` queries three fields — `Status`, `Running`, and `Pid` — and reports `"running"` if any of them indicate running. This prevents the update service's state gate from misfiring and skipping legitimate checks.

**5. The `effectiveResources` cache is no longer trusted for no-op decisions.**

Prior versions compared the incoming `updateResources` payload against the in-memory `effectiveResources` cache to detect no-ops. v0.1.8 instead calls `getLiveResources()` (podman inspect) and compares against actual cgroup state. This means:

- Stale cache entries after a buggy predecessor run no longer mask reality
- Manual `podman update` from outside Signal K is detected on the next updateResources call
- Container state drift from any source is handled correctly

**6. The config panel form re-seeds from server truth after every Apply / Reset.**

The inline ResourceLimitsEditor updates its form inputs from the server's post-action `effective` state after Apply or Reset. This eliminates the class of bug where a user's stale form values could silently re-submit on accidental Apply after a Reset.

---

## TypeScript Types

The complete public API is published as a self-contained, dependency-free type entrypoint. Import it directly instead of hand-maintaining a copy that drifts from the running plugin:

```typescript
import type {
  ContainerManagerApi,
  ContainerConfig,
  EnsureRunningOptions,
  VolumeIssue,
  ConsumerManifest,
  UpdateServiceApi,
  UpdateRegistration,
  UpdateCheckResult,
  VersionSource,
  // …every public type
} from "signalk-container/types";
```

The subpath ships type declarations plus a types-only runtime stub (`export {}`), so importing it adds no real runtime dependency and no `dependencies`/`peerDependencies` entry (do **not** add `signalk-container` to either; its prereleases break npm semver ranges — declare the relationship with `"signalk": { "requires": ["signalk-container"] }` instead). Runtime access stays via `globalThis.__signalk_containerManager`, exactly as before; only the _types_ come from the import.

The `./types` subpath exists from **signalk-container 1.23.0** onward. The declarations you import describe whatever version you resolved, so a member added in a later plugin release only appears in the type once you upgrade the declaration source too; either way, feature-detect newer members (`typeof manager.recreate === "function"`) at the call site, since the _running_ plugin may be older than your types.

> **Higher-level option:** [signalk-container-helper](https://github.com/hoeken/signalk-container-helper) wraps the whole consumer lifecycle (manager discovery, tag validation, self-heal, `ensureRunning`, update registration, HTTP readiness, teardown) into `ManagedContainer` / `AdoptedContainer` classes and re-exports these same types. If you're building a new containerized plugin, start there rather than wiring the manager by hand.

If you cannot import at all (e.g. a plain-JavaScript plugin with no build step), declare a narrow local interface for the one or two shapes you actually touch and treat the manager global as `unknown` at the boundary — a hand-written mirror lags the real API, so prefer the import above. The authoritative definitions live in [`src/types.ts`](../src/types.ts).

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

When Signal K runs inside a container itself, signalk-container needs only the host's Docker/Podman socket bind-mounted in — it talks to the runtime over the Docker API, so no podman/docker CLI binary is required inside the container. Detect this case via `isContainerized()`:

```typescript
import { isContainerized } from "signalk-container/dist/runtime";

if (isContainerized()) {
  // Signal K is running inside a container
  // - host runtime socket must be bind-mounted in (no CLI binary needed)
  // - spawned containers are siblings, not nested
  // - host.containers.internal points to the actual host
  //   (signalk-container 1.8.0+ adds this mapping for Docker too;
  //    Podman has it natively)
  // - shared networks need explicit setup
}
```

The signalk-container plugin uses this check to:

- Show `(in-container)` prefix in status
- Provide a more helpful error when no runtime is found
- Document the security and networking implications in the README

For consumer plugins (like signalk-questdb): if you rely on `host.containers.internal` to reach Signal K from a spawned container, that won't work when Signal K itself is in a container — it would point to the host, not the SK container. Use the SK container's name on the shared network instead.

See the README's "Running Signal K in a Container" section for full details on socket mounting, security caveats, and networking.

### Which API for what

A consumer plugin that mounts a host path into a managed container has four reasonable patterns, depending on whether SK is bare-metal or itself containerised. Pick by use case:

| Use case                                                                                                                 | API                                    | Why                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mount **the whole SK data directory** at a chosen container path. signalk-container picks the host source automatically. | `ContainerConfig.signalkDataMount`     | Declarative — set the container path on the config object, signalk-container resolves the host side. Plugin sees the same string regardless of deployment.                                                                         |
| Just need to **know the host source** behind `app.getDataDirPath()` (e.g. for a non-`volumes` config field).             | `containers.resolveSignalkDataMount()` | Imperative companion to `signalkDataMount`. Returns the host path or volume name. `null` if the runtime hasn't been detected yet.                                                                                                  |
| Mount a **specific path inside or outside** the data dir (a chart directory, an existing host download cache, etc.).     | `containers.resolveHostPath(absPath)`  | General-purpose. Returns `{ source, subPath }` — the bind-mount source the runtime needs, plus the offset inside if the covering SK mount is a parent directory. `null` when SK is in a container and no SK mount covers the path. |
| Hardcoded **host path** that already exists on the host filesystem (a fixed `/etc/...`, a USB drive at `/media/...`).    | Raw `volumes` entry                    | The path is already host-side; no translation needed. Use the per-volume `ifMissing` policy if it may be absent.                                                                                                                   |

What you must **not** do: `volumes: { "/in-container/path": app.getDataDirPath() }`. That works on bare-metal but breaks when SK runs in a container — `app.getDataDirPath()` is the SK-container-internal view, and the host's runtime daemon cannot resolve it. The result is `Error: statfs <path>: no such file or directory`.

### Worked example: signalk-questdb

The [signalk-questdb 1.0.0 → 1.0.1 fix](https://github.com/dirkwa/signalk-questdb/pull/21) is the canonical illustration. Before, the volume source was the raw `app.getDataDirPath()` — works on bare-metal, fails in-container. The fix routes that path through `containers.resolveHostPath()` before passing it as a bind-mount source.

The three invariants the resolver should preserve:

1. **Falls back to the original path** when `resolveHostPath` isn't available — keeps the plugin working against signalk-container `< 1.7.0` where the API didn't exist.
2. **Falls back on a thrown error** — `resolveHostPath` is documented as non-throwing in current signalk-container, but cross-plugin APIs are consumed through `(globalThis as any).__signalk_containerManager` (no type-level guarantee), so wrapping is the safer pattern.
3. **Preserves per-plugin scoping** — `app.getDataDirPath()` for a plugin already resolves to `<configRoot>/plugin-config-data/<pluginId>` (Signal K server rewrites it per-plugin), so the managed container sees only the plugin's own subdirectory after translation, not the whole SK data dir.

The implementation of these three invariants is in [signalk-questdb's `src/index.ts`](https://github.com/dirkwa/signalk-questdb/blob/main/src/index.ts) — pinning the code inline here would risk drift as that plugin evolves.

---

## Common Mistakes Summary

| Mistake                                                           | Symptom                                                                                                         | Fix                                                                                                                                                                                               |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `async start()` without catch                                     | Silent failure, no status                                                                                       | Sync `start()` + `asyncStart().catch()`                                                                                                                                                           |
| `app.setPluginStatus(id, msg)`                                    | Status shows plugin id as message                                                                               | `app.setPluginStatus(msg)` (one arg)                                                                                                                                                              |
| Setting property on `app`                                         | Other plugins can't see it                                                                                      | Use `globalThis.__signalk_xxx`                                                                                                                                                                    |
| Not waiting for runtime detection                                 | `getRuntime()` returns null                                                                                     | `await containers.whenReady()` then check `getRuntime()` (signalk-container 1.6.0+)                                                                                                               |
| Short Docker image names with Podman                              | Pull fails with "short-name did not resolve"                                                                    | signalk-container handles this automatically                                                                                                                                                      |
| `DEDUP ENABLED UPSERT KEYS` in QuestDB DDL                        | Table creation fails                                                                                            | `DEDUP UPSERT KEYS` (no ENABLED)                                                                                                                                                                  |
| Committing webpack `public/` output                               | CI fails with "untracked files"                                                                                 | Add `public/*.js` to `.gitignore`                                                                                                                                                                 |
| `engines.node` missing from package.json                          | CI validation error                                                                                             | Add `"engines": { "node": ">=22" }`                                                                                                                                                               |
| Not stopping container in `stop()`                                | Container runs after plugin disabled                                                                            | Call `containers.stop()` in plugin `stop()`                                                                                                                                                       |
| `savePluginOptions` doesn't restart                               | Plugin stays stopped after config save                                                                          | Don't rely on it for restart; do work directly                                                                                                                                                    |
| Config hash in QuestDB data volume                                | Hash file lost (QuestDB owns the dir)                                                                           | Store hash file next to plugin JSON config                                                                                                                                                        |
| Raw `app.getDataDirPath()` in `volumes` when SK is in a container | Container fails to create with `Error: statfs <path>: no such file or directory` from the host's runtime daemon | Use `signalkDataMount` (whole data dir) or `await containers.resolveHostPath(absPath)` (per-plugin subdir) so signalk-container translates the SK-container-internal path back to the host source |
| No `resources` set on `ensureRunning`                             | Container can saturate the host                                                                                 | Always set sensible CPU/memory caps; measure with `podman stats` first                                                                                                                            |
| Setting `cpus: 4` on a Pi 4 (4 cores)                             | One container can starve all others + Signal K                                                                  | Leave at least 1 core's worth of headroom for the OS and Signal K                                                                                                                                 |
| `memory` set, `memorySwap` left default                           | Container thrashes swap before OOM                                                                              | Set `memorySwap` equal to `memory` to disable swap entirely                                                                                                                                       |
| Override in signalk-container config has key `sk-mayara-server`   | Override silently ignored                                                                                       | Use the unprefixed name (`mayara-server`) — signalk-container adds the `sk-` prefix internally                                                                                                    |
