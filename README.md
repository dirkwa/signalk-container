# signalk-container

Shared container runtime management (Podman/Docker) for Signal K plugins.

Instead of each plugin implementing its own container orchestration, they delegate to this plugin. It detects the available runtime, pulls images, manages container lifecycles, and provides a config panel in the Admin UI.

## Features

- **Runtime detection** -- Podman preferred, Docker fallback, podman-shim aware
- **Container lifecycle** -- pull, create, start, stop, remove with `sk-` prefix naming
- **One-shot jobs** -- run containers for batch tasks (export, conversion, etc.)
- **Update detection** -- centralized "is there a newer image?" service for all consumer plugins. Auto-detects semver vs floating tags (`:latest`, `:main`), offline-tolerant with persistent cache, emits Signal K notifications, visible inline in the config panel. See the [developer guide](doc/plugin-developer-guide.md#update-detection).
- **Resource limits editor** -- interactive UI in the config panel for setting CPU/memory/PID caps per container. Values are applied live via `podman update` when possible (no downtime), falls back to recreate when needed. Stored overrides are minimized against the consumer plugin's defaults so a future default bump flows through automatically. See the [developer guide](doc/plugin-developer-guide.md#resource-limits).
- **Reset to plugin default** -- one-click restore of a container's original resource limits, clearing any user override.
- **Image management** -- scheduled pruning of dangling images (weekly/monthly)
- **Zero-config data dir sharing** -- `signalkDataMount` mounts the SignalK data directory into any managed container automatically, whether Signal K runs bare-metal, in Docker (named volume), or in Podman (named volume or bind mount). No host paths to configure.
- **Zero-config container service connectivity** -- `signalkAccessiblePorts` lets the SignalK process connect back to a service running inside a managed container (e.g. an HTTP or TCP server). signalk-container picks the right networking strategy automatically — port binding on the host loopback for bare-metal deployments, or a shared Docker network with DNS for containerised ones. No host ports are exposed unnecessarily.
- **SELinux support** -- `:Z` volume flags for Podman bind mounts on Fedora/RHEL; named volumes are handled correctly (`:Z` is not applied)
- **Podman image qualification** -- automatically prefixes `docker.io/` for short image names
- **Cross-plugin API** -- other plugins use `globalThis.__signalk_containerManager`

## Config Panel

The plugin embeds a React config panel in the Signal K Admin UI (via Module Federation). It's the recommended way to manage containers — you shouldn't need to edit JSON directly.

### Runtime section

- Detected runtime with version (Podman or Docker)
- Green status indicator when available, red if no runtime was found

### Settings

- **Preferred runtime** -- auto-detect, or force `podman`/`docker`
- **Auto-prune images** -- off, weekly, or monthly scheduled cleanup of dangling images
- **Update check interval** -- how often to check consumer plugins for new container images (1h to 1 week, default 24h)
- **Background update checks** -- toggle for metered connections; manual checks still work when off

### Managed Containers (one card per running or stopped container)

- Container name, image, state, and port mappings
- **Start** / **Stop** / **Remove** buttons appropriate to the current state
- **Current effective resource limits** shown as compact badges (e.g. `1.5 CPU · 512m · 200 PIDs`)
- **Override active** amber badge when the user has configured a resource override for the container
- **Updates row** (when the consumer plugin has registered with the update service):
  - Color-coded badge: `✓ up to date`, `↑ v3.4.0 available`, `↻ rebuild available` (floating tag), `📡 offline` (with cached state fallback), `⚠ check error`
  - "checked 5m ago" staleness indicator
  - **Check now ↻** button for an immediate fresh check

### Resource Limits Editor (expands inline when you click "Edit Limits" on a running container)

- Four primary fields visible by default: CPU cores, Memory, Memory+swap, Max processes
- **Advanced** section (collapsed) for CPU shares, CPU pinning, memory reservation, OOM score adjust
- **× button** next to each field to explicitly unset (send `null`, removing a plugin-default limit)
- **Apply** -- live update where possible, recreate where needed, with a clear result box showing which method was used and any warnings (e.g. "dropped cpusetCpus — not delegated by cgroups")
- **Revert** -- discard unsaved form edits, re-seed from current effective state
- **Reset to default** -- clear the user override entirely and restore the consumer plugin's pristine default limits (confirmation dialog warns about possible recreate)
- After Apply or Reset, the form re-seeds from the server's fresh state so the inputs always match what's actually running

### Maintenance

- **Prune Dangling Images** button with before/after space reclaimed summary

## How Other Plugins Use It

```typescript
const containers = (globalThis as any).__signalk_containerManager;
if (!containers) {
  app.setPluginError("signalk-container plugin required");
  return;
}

// Start a long-running service container
await containers.ensureRunning("my-service", {
  image: "myorg/myimage",
  tag: "latest",
  signalkDataMount: "/data",         // resolves to the SignalK data dir, regardless of deployment
  signalkAccessiblePorts: [8080],    // port 8080 in the container must be reachable by SignalK
  env: { MY_VAR: "value" },
  restart: "unless-stopped",
});

// Get the actual address to connect to (resolved after ensureRunning)
const addr = await containers.resolveContainerAddress("my-service", 8080);
if (!addr) throw new Error("Container address not available");
// bare-metal  → "127.0.0.1:8080"  (or "127.0.0.1:8081" if 8080 was taken)
// containerised → "sk-my-service:8080"  (Docker DNS, no host port exposed)
const response = await fetch(`http://${addr}/status`);

// Run a one-shot job
const result = await containers.runJob({
  image: "myorg/converter",
  command: ["convert", "--input", "/in/data.csv"],
  inputs: { "/in": "/host/path/input" },
  outputs: { "/out": "/host/path/output" },
  timeout: 120,
});
```

See [doc/plugin-developer-guide.md](doc/plugin-developer-guide.md) for the full integration guide with gotchas and patterns.

## API

| Method                                  | Description                                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getRuntime()`                          | Returns `{ runtime, version, isPodmanDockerShim }` or `null`                                                                                           |
| `pullImage(image, onProgress?)`         | Pull a container image (auto-qualifies for Podman)                                                                                                     |
| `imageExists(image)`                    | Check if image exists locally                                                                                                                          |
| `getImageDigest(imageOrContainer)`      | Local image ID (sha256) for an image:tag or container                                                                                                  |
| `ensureRunning(name, config, options?)` | Create and start container if not running                                                                                                              |
| `start(name)`                           | Start a stopped container                                                                                                                              |
| `stop(name)`                            | Stop a running container                                                                                                                               |
| `remove(name)`                          | Stop and remove a container                                                                                                                            |
| `getState(name)`                        | Returns `running`, `stopped`, `missing`, or `no-runtime`                                                                                               |
| `runJob(config)`                        | Execute a one-shot container job                                                                                                                       |
| `prune()`                               | Remove dangling images                                                                                                                                 |
| `listContainers()`                      | List all `sk-` prefixed containers                                                                                                                     |
| `execInContainer(name, command)`        | Run a command inside a running container                                                                                                               |
| `ensureNetwork(name)`                   | Create a Podman/Docker network if it doesn't exist                                                                                                     |
| `removeNetwork(name)`                   | Remove a network                                                                                                                                       |
| `connectToNetwork(container, network)`  | Add a container to a network (bridge mode only)                                                                                                        |
| `disconnectFromNetwork(container, net)` | Remove a container from a network                                                                                                                      |
| `updates.register(reg)`                 | Register a container for update detection                                                                                                              |
| `updates.unregister(pluginId)`          | Stop tracking updates for a plugin                                                                                                                     |
| `updates.checkOne(pluginId)`            | Force a fresh update check (or coalesce with in-flight)                                                                                                |
| `updates.getLastResult(pluginId)`       | Cached last result, no network                                                                                                                         |
| `updateResources(name, limits)`         | Apply new resource limits live, fall back to recreate                                                                                                  |
| `getResources(name)`                    | Currently effective limits (plugin defaults ⊕ user override)                                                                                           |
| `resolveSignalkDataMount()`             | Resolve the volume name or host path that backs `app.getDataDirPath()` in the current deployment; returns `null` if the runtime is not yet initialised |
| `resolveContainerAddress(name, port)`  | Return the `host:port` string to reach `port` on a managed container from the SignalK process; call after `ensureRunning()` with `signalkAccessiblePorts` set |

## REST Endpoints

All mounted at `/plugins/signalk-container/api/`:

| Method | Path                          | Description                                                                                                                   |
| ------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/runtime`                    | Detected runtime info                                                                                                         |
| GET    | `/containers`                 | List managed containers                                                                                                       |
| GET    | `/containers/:name/state`     | Container state                                                                                                               |
| POST   | `/containers/:name/start`     | Start a stopped container                                                                                                     |
| POST   | `/containers/:name/stop`      | Stop a running container                                                                                                      |
| POST   | `/containers/:name/remove`    | Stop and remove a container                                                                                                   |
| POST   | `/prune`                      | Prune dangling images                                                                                                         |
| GET    | `/updates`                    | List last update-check results                                                                                                |
| GET    | `/updates/:pluginId`          | Last update-check result for one plugin                                                                                       |
| POST   | `/updates/:pluginId/check`    | Force a fresh update check (HTTP 200 even when offline)                                                                       |
| GET    | `/containers/:name/resources` | Effective resource limits + user override                                                                                     |
| POST   | `/containers/:name/resources` | Apply new resource limits (live or recreate). Body is a `ContainerResourceLimits` diff against the consumer plugin's default. |
| DELETE | `/containers/:name/resources` | Clear any user override and restore the consumer plugin's pristine default limits to the running container.                   |

## Configuration

| Setting                  | Default  | Description                                                                                                                    |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Preferred runtime        | `auto`   | Auto-detect, or force `podman`/`docker`                                                                                        |
| Auto-prune images        | `weekly` | `off`, `weekly`, or `monthly`                                                                                                  |
| Max concurrent jobs      | `2`      | Limit parallel one-shot job executions                                                                                         |
| Update check interval    | `24h`    | How often to check for container image updates (e.g. `24h`, `12h`, `1h`). Min 1h.                                              |
| Background update checks | `true`   | Periodically check for updates in the background. Disable on metered connections — manual checks via the UI button still work. |
| Container overrides      | `{}`     | Per-container resource limits (CPU, memory, PIDs). Field-level merged on top of consumer plugin defaults. See dev guide.       |

## Mounting the SignalK data directory (`signalkDataMount`)

When a managed container needs to read or write files that Signal K also accesses (e.g. HLS segments, exports, caches), use `signalkDataMount` instead of computing and hardcoding a host path or volume name.

```typescript
const SK_MOUNT = "/signalk-data";

await containers.ensureRunning("my-worker", {
  image: "myorg/myworker",
  tag: "latest",
  signalkDataMount: SK_MOUNT, // ← mount the SignalK data dir here
  command: ["--output", path.join(SK_MOUNT, "my-plugin/output/result.bin")],
});
```

signalk-container resolves the correct source automatically:

| Deployment                     | What gets mounted                                                 |
| ------------------------------ | ----------------------------------------------------------------- |
| Bare-metal Signal K            | `app.getDataDirPath()` as a bind mount (already a host path)      |
| Docker, volume-backed data dir | the named volume (e.g. `mystack_signalk-data`)                    |
| Docker, bind-backed data dir   | the exact host path, even when a parent directory is bind-mounted |
| Podman (rootless or root)      | same logic; named volumes receive no `:Z` flag                    |

The content at `SK_MOUNT` inside the managed container always corresponds to the root of `app.getDataDirPath()`. Build paths using `path.join`:

```typescript
// Path inside managed container that corresponds to an absolute SignalK path:
const containerPath = path.join(
  SK_MOUNT,
  path.relative(app.getDataDirPath(), absSignalkPath),
);
```

> [!note]
> Docker/Podman do not support subpath mounts on named volumes. If your data directory
> is backed by a named volume, the entire volume is mounted at `SK_MOUNT`. Avoid writing
> to paths inside `SK_MOUNT` that are also bind-mounted in the Signal K container (e.g.
> a plugin's own directory if mounted with `./:/home/node/.signalk/node_modules/my-plugin`)
> — those paths are not visible from inside the managed container.

You can also call `containers.resolveSignalkDataMount()` if you need to inspect the resolved source at runtime (e.g. for logging).

## Connecting back to a container service (`signalkAccessiblePorts`)

When a managed container exposes an HTTP, TCP, or other service that the SignalK process itself needs to connect to (e.g. a video stream, a database, an inference engine), use `signalkAccessiblePorts` instead of hardcoding port bindings or writing deployment-detection logic in your plugin.

```typescript
const STREAM_PORT = 8090;

await containers.ensureRunning("my-streamer", {
  image: "myorg/streamer",
  tag: "latest",
  signalkAccessiblePorts: [STREAM_PORT],
  restart: "unless-stopped",
  command: ["--listen", String(STREAM_PORT)],
});

const addr = await containers.resolveContainerAddress("my-streamer", STREAM_PORT);
if (!addr) throw new Error("Container address not available");
// Connect from the SignalK process — addr is always the right host:port:
http.get(`http://${addr}/stream`, handleResponse);
```

signalk-container resolves the correct networking strategy automatically:

| Deployment | Strategy | Address returned |
| --- | --- | --- |
| Bare-metal Signal K | Port bound to `127.0.0.1` (first free port ≥ declared value) | `127.0.0.1:8090` (or `127.0.0.1:8091` if 8090 was taken) |
| Containerised, user-defined network | Container attached to SignalK's own Docker/Podman network; no host port exposed | `sk-my-streamer:8090` (Docker DNS) |
| Containerised, default bridge (no DNS) | Container shares SignalK's network namespace | `127.0.0.1:8090` |

The allocated address is cached for the lifetime of the plugin session, so repeated `ensureRunning()` calls never trigger an unwanted container recreate due to a port number change.

> [!note]
> `signalkAccessiblePorts` sets up networking automatically. Do not combine it with
> a manual `ports` or `networkMode` entry for the same container — the field takes
> full ownership of those concerns.

## Setting Resource Limits

On a boat with limited compute (typically a Pi 4/5 or low-power x86 mini PC), one runaway container can starve Signal K, raise NMEA decode latency, trigger thermal throttling, or even take the host down via OOM. signalk-container exposes podman/docker resource flags so consumer plugins can set sensible defaults — and you, as the user, can tune them per-container in two ways: **the config panel UI (recommended)** or direct JSON edit (for scripted/automated setups).

### How it works

Each consumer plugin (signalk-questdb, signalk-grafana, mayara, etc.) declares default CPU/memory limits when it starts its container. Your override is **merged field-by-field** on top of the plugin's defaults, and only the fields that actually differ from the default get stored. This means if a future plugin version bumps its memory default from 512m to 1g, your override for just `cpus` will automatically pick up the new memory value — no manual edit needed.

### Using the Config Panel (recommended)

1. Open the Signal K admin UI → Plugin Config → **Container Manager**
2. Find the container you want to tune in the "Managed Containers" list
3. Click **Edit Limits ▸** on the row
4. Edit the CPU cores, Memory, Memory+swap, or Max processes fields. Use the × button next to a field to explicitly unset a limit the plugin set. Click **Advanced** to access cpuShares, cpusetCpus, memoryReservation, and oomScoreAdj.
5. Click **Apply** — live updated where possible (no downtime), recreated where needed. The result box shows which method was used plus any warnings.
6. To restore the plugin's default: click **Reset to default** (amber button). This clears your override and applies the pristine default to the running container.

The form re-seeds from the server's fresh state after every Apply or Reset, so the displayed values always match what's actually running.

### Available fields

| Field               | Example          | What it does                                                                                                                                                             |
| ------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cpus`              | `1.5`            | Hard CPU cap. `1.5` = max 1.5 cores. The most important field for stability.                                                                                             |
| `cpuShares`         | `512`            | Soft CPU weight under contention (default 1024). Lower = lower priority.                                                                                                 |
| `cpusetCpus`        | `"1,2"`          | Pin to specific cores. Useful to keep heavy containers off core 0 where Signal K runs. May force a recreate on hosts where the cpuset cgroup controller isn't delegated. |
| `memory`            | `"512m"`, `"2g"` | Hard memory cap. Container is OOM-killed if exceeded.                                                                                                                    |
| `memorySwap`        | `"512m"`         | Memory + swap total. **Set equal to `memory` to disable swap entirely** — recommended on Pi/eMMC where swap is slow.                                                     |
| `memoryReservation` | `"256m"`         | Soft memory floor. Kernel reclaims first from containers above this.                                                                                                     |
| `pidsLimit`         | `200`            | Cap on processes/threads. Prevents fork bombs and thread leaks.                                                                                                          |
| `oomScoreAdj`       | `500`            | OOM kill priority, -1000..1000. Higher = killed first when host runs out of memory. Set at container create time only — forces a recreate when changed.                  |

### Direct JSON (scripted/advanced)

The UI writes to a `containerOverrides` map in `plugin-config-data/signalk-container.json`. You can edit this directly if you prefer — useful for automation or bulk configuration:

```json
{
  "configuration": {
    "containerOverrides": {
      "mayara-server": {
        "cpus": 1.5,
        "memory": "512m",
        "memorySwap": "512m"
      }
    }
  }
}
```

The key (`mayara-server`) is the container name **without** the `sk-` prefix that signalk-container adds internally. Use `null` for a field to explicitly remove a limit set by the plugin:

```json
{
  "mayara-server": { "memory": null }
}
```

After editing the file, restart the Container Manager plugin from the Signal K admin UI (or run the REST calls below) for the changes to take effect on running containers.

### REST API (for scripts or external tools)

```bash
# Read current state
curl http://localhost:3000/plugins/signalk-container/api/containers/mayara-server/resources

# Apply a new override (live or recreate as needed)
curl -X POST http://localhost:3000/plugins/signalk-container/api/containers/mayara-server/resources \
  -H 'Content-Type: application/json' \
  -d '{"cpus": 2}'

# Reset to plugin default (clear the override)
curl -X DELETE http://localhost:3000/plugins/signalk-container/api/containers/mayara-server/resources
```

### When changes take effect

- **Immediately via the UI or REST API** (`updateResources`): signalk-container tries `podman update` / `docker update` first (instantaneous, no downtime). Falls back to stop+remove+create if the runtime can't apply the change live (e.g. unsetting memory limits, or changing `cpusetCpus` / `oomScoreAdj` which are set at container create time only).
- **On next consumer plugin restart**: the merge happens automatically inside `ensureRunning` — useful for installations that manage via JSON edits and don't want to use the REST API.
- **Persistence**: overrides applied via the UI or REST API are auto-persisted to `plugin-config-data/signalk-container.json` — they survive Signal K restarts without any extra action.

### Verifying limits are applied

Check the live container directly:

```bash
podman inspect sk-mayara-server --format '
  cpus={{.HostConfig.NanoCpus}}
  memory={{.HostConfig.Memory}}
  pids={{.HostConfig.PidsLimit}}
'
```

`NanoCpus` is in CPU-nanoseconds per second; `1500000000` = 1.5 cores. Memory is in bytes.

Or via the REST API:

```bash
curl http://localhost:3000/plugins/signalk-container/api/containers/mayara-server/resources | jq
# {
#   "name": "mayara-server",
#   "effective": { "cpus": 1.5, "memory": "512m", ... },  // what's actually applied
#   "override": { "cpus": 1.5 }                            // only what the user changed
# }
```

Note that `override` contains only the fields that differ from the consumer plugin's default — this minimization is automatic and lets future plugin default bumps flow through without you having to re-edit your override.

### Picking the right values

1. Run the container without overrides for a typical workload
2. Watch resource use: `podman stats sk-mayara-server`
3. Note peak CPU% and peak memory
4. Set `cpus` ≈ peak / 100 + 25% headroom; `memory` ≈ peak rounded up + 25% headroom
5. Re-test under load to make sure the container still functions inside its caps

The plugin developer guide has a detailed walk-through in [doc/plugin-developer-guide.md#resource-limits](doc/plugin-developer-guide.md#resource-limits).

## Requirements

- Node.js >= 22
- Podman or Docker installed on the host
- Signal K server

## Running Signal K in a Container

If your Signal K server itself runs inside a container (Docker, Podman),
this plugin needs access to the host's container runtime to manage other
containers. The plugin auto-detects this scenario via `/.dockerenv` or
`/run/.containerenv` and prefixes the status with `(in-container)`.

For the plugin to work, you must expose the host's container runtime to
the Signal K container:

### Docker (with security caveats)

```yaml
services:
  signalk:
    image: signalk/signalk-server
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /usr/bin/docker:/usr/bin/docker:ro
```

The Signal K image must include the `docker` CLI binary, OR you mount
it from the host as shown above. Containers managed by the plugin
become **siblings** of the Signal K container, not nested.

> [!warning]
> Mounting `/var/run/docker.sock` gives the container **root-equivalent
> access to the host**. Anyone who compromises Signal K (including via
> a malicious plugin) can take over the entire host. Only use this if
> you understand and accept the security implications.

### Podman (rootless, safer)

```yaml
services:
  signalk:
    image: signalk/signalk-server
    volumes:
      - $XDG_RUNTIME_DIR/podman/podman.sock:/var/run/podman.sock
      - /usr/bin/podman:/usr/bin/podman:ro
    environment:
      - DOCKER_HOST=unix:///var/run/podman.sock
```

Rootless Podman runs as your user, not root, so the security exposure
is limited to your user account rather than the entire host.

### Networking caveats

When Signal K runs in a container, containers spawned by this plugin
are **siblings** on the host's container network, not inside Signal K's
network namespace. This affects:

- The shared `sk-network` works only if Signal K is also attached to it
  (add it externally or via the same compose file)
- `host.containers.internal` from spawned containers points to the host
  itself, not the Signal K container — use Signal K's container name
  for direct communication

### Recommended setup

For the simplest experience with managed containers, run **Signal K
natively on the host** rather than in a container. The plugin and its
ecosystem (signalk-questdb, signalk-grafana) are designed for this case.

## License

MIT

## Acknowledgements

The plugin icon (`icon.svg`) is the **container** glyph from
[Lucide Icons](https://lucide.dev), used under the ISC License. See
[`NOTICE`](NOTICE) for the full attribution.
