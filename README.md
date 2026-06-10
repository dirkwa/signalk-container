# signalk-container

Shared container runtime management (Podman/Docker) for Signal K plugins.

Instead of each plugin implementing its own container orchestration, they delegate to this plugin. It detects the available runtime, pulls images, manages container lifecycles, and provides a config panel in the Admin UI.

## Features

- **Runtime detection** -- resolves the container runtime over its Docker-API socket (Podman preferred, Docker fallback); no podman/docker CLI binary is needed. Consumer plugins `await containers.whenReady()` once instead of polling in a loop — resolves when the probe settles in either direction.
- **Container lifecycle** -- pull, create, start, stop, remove with `sk-` prefix naming
- **Automatic config-drift recreation** -- `ensureRunning` compares the requested `ContainerConfig` against the live container on every call. If `image`, `tag`, `command`, `networkMode`, `env`, `volumes`, or `ports` differ, the container is removed and recreated transparently. Consumer plugins no longer need a per-plugin hash file to detect "config changed since last start." See the [developer guide](doc/plugin-developer-guide.md#container-config-changes).
- **Healthcheck handling** -- image-declared healthchecks are made to work reliably across runtimes. For images that ship **no** healthcheck, consumer plugins set `ContainerConfig.healthcheck` to supply a probe, so the container reports a real health status instead of being stuck in `starting`. See the [developer guide](doc/plugin-developer-guide.md#healthcheck-for-images-that-ship-none).
- **One-shot jobs** -- run containers for batch tasks (export, conversion, etc.)
- **Update detection** -- centralized "is there a newer image?" service for all consumer plugins. Auto-detects semver vs floating tags (`:latest`, `:main`), offline-tolerant with persistent cache, emits Signal K notifications, visible inline in the config panel. See the [developer guide](doc/plugin-developer-guide.md#update-detection).
- **Resource limits editor** -- interactive UI in the config panel for setting CPU/memory/PID caps per container. Values are applied live via `podman update` when possible (no downtime), falls back to recreate when needed. Stored overrides are minimized against the consumer plugin's defaults so a future default bump flows through automatically. See the [developer guide](doc/plugin-developer-guide.md#resource-limits).
- **Reset to plugin default** -- one-click restore of a container's original resource limits, clearing any user override.
- **Image management** -- scheduled pruning of dangling images (weekly/monthly)
- **Zero-config data dir sharing** -- `signalkDataMount` mounts the SignalK data directory into any managed container automatically, whether Signal K runs bare-metal, in Docker (named volume), or in Podman (named volume or bind mount). No host paths to configure.
- **Zero-config config root sharing** -- `signalkConfigRootMount` mounts the entire SignalK installation config (`~/.signalk/`) — for backup, audit, or config-sync tools that need the whole tree, not the per-plugin subdirectory.
- **Zero-config container service connectivity** -- `signalkAccessiblePorts` lets the SignalK process connect back to a service running inside a managed container (e.g. an HTTP or TCP server). signalk-container picks the right networking strategy automatically — port binding on the host loopback for bare-metal deployments, or a shared Docker network with DNS for containerised ones. No host ports are exposed unnecessarily.
- **SELinux support** -- `:Z` volume flags for Podman bind mounts on Fedora/RHEL; named volumes are handled correctly (`:Z` is not applied)
- **Per-volume host-source policy** -- volumes accept `{ source, ifMissing: "skip" | "abort" }` for user-managed (USB drives, NFS) or deployment-required (TLS certs) mounts. Plugins subscribe to `onVolumeIssue` events for `'skipped'`, `'aborted'`, and `'recovered'` actions; signalk-container auto-recreates the container when a previously-missing source reappears. See the [developer guide](doc/plugin-developer-guide.md#optional-and-required-volumes).
- **Container log streaming** -- click **Logs** on any managed-container card to open a live-streaming popup of the container's stdout+stderr (combined, the same shape `podman logs <name>` produces). Plugin authors can also wire `onContainerLog` in `ensureRunning` options to forward the same stream into their plugin's `app.debug` channel — visible in the Signal K server log when debug is enabled. Multiple subscribers share a single underlying log stream. See the [developer guide](doc/plugin-developer-guide.md#streaming-container-logs-into-your-plugins-debug-channel).
- **Host-UID ownership alignment** -- managed containers run by default under the Signal K host user's UID/GID (via `--user host:host` on Docker/rootful Podman, `--userns=keep-id` on rootless Podman). Files created on bind mounts are owned by the same identity that runs Signal K, with no `chmod` sweeps. Override per container via `ContainerConfig.user` for images with a non-root `USER` directive, or `user: false` to opt out. See the [developer guide](doc/plugin-developer-guide.md#host-uid-ownership).
- **Image compliance probes** -- `containers.doctor.imageRunsAsUser(image, user?)` runs the image under the live UID mapping and verifies it can write `/tmp` as the host caller. Surfaces UID-compatibility problems _before_ a container wedges in a restart loop. See the [developer guide](doc/plugin-developer-guide.md#containersdoctorimagerunsasuserimage-user-promiseimageproberesult).
- **Podman image qualification** -- automatically prefixes `docker.io/` for short image names
- **Docker `host.containers.internal` parity** -- signalk-container adds the `host-gateway` mapping for Docker automatically (Podman has it natively). User-supplied `extraHosts` overrides are respected.
- **Cross-plugin API** -- other plugins use `globalThis.__signalk_containerManager`

## Requirements

- Node.js >= 22
- Podman or Docker installed on the host
- Signal K server

## Running Signal K in a Container

If your Signal K server itself runs inside a container (Docker, Podman),
this plugin needs access to the host's container runtime to manage other
containers. The plugin auto-detects this scenario via `/.dockerenv` or
`/run/.containerenv` and prefixes the status with `(in-container)`.

For the plugin to work, two things must be true inside the Signal K
container:

1. **A matching runtime CLI is available** — the CLI inside the SK
   container must match the daemon on the host (Docker host → `docker`;
   Podman host → `podman`). End users typically bind-mount the host
   binary; image maintainers can bake it into a custom image.
2. **The matching runtime socket is bind-mounted** from the host
   (rootless or rootful podman, or docker).

Concrete platform-specific commands — for both end-user and
image-maintainer setups — are emitted by the deployment doctor (see
`/api/doctor/deployment` and the snippet generator below). Use those
as the source of truth; they always reflect the running plugin
version.

### Quick check: `/api/doctor/deployment`

The plugin ships a self-diagnostic. After starting, hit:

```bash
curl http://<signalk-host>:3000/plugins/signalk-container/api/doctor/deployment
```

The response includes a `status` field (`ok` / `no-runtime` /
`socket-unreachable` / `permission-denied` / `self-id-unresolved` /
`cgroup-controllers-incomplete`) and a `remediation` array of
copy-pasteable lines for whichever failure mode applies. When startup
detection fails, the same remediation is also logged to the Signal K
server log.

A separate `cgroupControllers` field on the response reports the
delegated cgroup v2 controllers and which expected ones are missing —
see [Cgroup controller delegation](#cgroup-controller-delegation) for
what missing controllers mean for resource limits.

### Generate a starter snippet

To bootstrap a new deployment, ask the plugin for a ready-to-paste
compose fragment or shell command tailored to the detected runtime:

```bash
curl 'http://<signalk-host>:3000/plugins/signalk-container/api/doctor/snippet?format=compose' > docker-compose.yml
curl 'http://<signalk-host>:3000/plugins/signalk-container/api/doctor/snippet?format=run'      > run-signalk.sh
```

The endpoint returns plain text by default; pass
`Accept: application/json` to get the structured
`SetupSnippetResult` (snippet + Dockerfile sidecar + operator notes)
for programmatic consumers.

> [!note]
> The per-runtime examples below illustrate the shape of a working setup.
> For an actual deployment, prefer the doctor-generated snippet above — it
> reflects your detected runtime and the running plugin version, so it
> stays correct as these details evolve.

### Rootless Podman (recommended)

The cleanest setup. Runs as your user, not root, so the security
exposure is limited to your user account rather than the entire host —
and matches signalk-container's default behaviour.

On the host, ensure the user-scoped podman socket is enabled:

```bash
systemctl --user enable --now podman.socket
```

Then in your compose / `podman run`:

```yaml
services:
  signalk:
    image: your-signalk-image-with-podman-remote
    user: "${UID}:${GID}" # match the uid that owns the host's podman socket
    volumes:
      - /run/user/${UID}/podman/podman.sock:/run/user/${UID}/podman/podman.sock
    environment:
      - CONTAINER_HOST=unix:///run/user/${UID}/podman/podman.sock
```

Your image's Dockerfile should include `podman` or `podman-remote`:

```dockerfile
RUN apt-get update && apt-get install -y podman    # Debian/Ubuntu
# or:
RUN dnf install -y podman-remote                    # Fedora/RHEL
```

### Rootful Podman

```yaml
services:
  signalk:
    image: your-signalk-image-with-podman
    volumes:
      - /run/podman/podman.sock:/run/podman/podman.sock
    environment:
      - CONTAINER_HOST=unix:///run/podman/podman.sock
```

### Docker

```yaml
services:
  signalk:
    image: your-signalk-image-with-docker-cli
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    group_add:
      - "<docker-gid-from-host>" # `getent group docker | cut -d: -f3`
```

> [!warning]
> Mounting `/var/run/docker.sock` gives the container **root-equivalent
> access to the host**. Anyone who compromises Signal K (including via
> a malicious plugin) can take over the entire host. Prefer rootless
> Podman for production.

### Networking caveats

When Signal K runs in a container, containers spawned by this plugin
are **siblings** on the host's container network, not inside Signal K's
network namespace. This affects:

- The shared `sk-network` works only if Signal K is also attached to it
  (add it externally or via the same compose file)
- `host.containers.internal` from spawned containers points to the host
  itself, not the Signal K container — use Signal K's container name
  for direct communication. signalk-container 1.8.0+ adds this hostname
  to Docker containers automatically (Podman already provides it); set
  `ContainerConfig.extraHosts` to override it or to add other hostnames.

### Cgroup controller delegation

When Signal K runs inside a rootless container, the kernel only enforces
those resource limits whose **cgroup controller has been delegated** down
to the SK container's cgroup. Anything else passed to `podman run` is
silently ignored — your `--memory 1g` request reaches the runtime, but
the cgroup never gets a memory cap and the container can grow without
bound.

The most common culprit is `memory`: many distros delegate `cpu`,
`cpuset`, `io`, and `pids` to user sessions by default, but `memory`
must be explicitly added.

signalk-container 1.9.0+ probes the available controllers via
`/sys/fs/cgroup/cgroup.controllers` and **silently drops** unsupported
limit fields before invoking podman — better than crashing the
container, but the user-visible effect is "I set memory to 1 GB and
nothing happened." The drop is logged at `debug` level with the reason
(`cgroup controller 'memory' not delegated to podman (available: cpuset,
cpu, io, pids)`); the live `effective` resource response also reflects
only what's actually in place.

**The deployment doctor flags this automatically** with `status:
cgroup-controllers-incomplete` and a ready-to-paste remediation block.
Hit `/api/doctor/deployment` (see above) and check the `status` and
`cgroupControllers` fields.

**Manual check from a shell:**

```bash
podman exec <sk-container> cat /sys/fs/cgroup/cgroup.controllers
# cpuset cpu io memory pids       ← memory delegated, all limits work
# cpuset cpu io pids               ← memory missing, --memory is dropped
```

**Enable memory delegation on the host** (one-time, requires sudo):

```bash
sudo mkdir -p /etc/systemd/system/user@.service.d
sudo tee /etc/systemd/system/user@.service.d/delegate.conf <<'EOF'
[Service]
Delegate=cpu cpuset io memory pids
EOF
sudo systemctl daemon-reload
# Log the SK-owning user out and back in (or reboot) so a fresh user@.service starts.
```

After re-login, re-running the consumer plugin's `ensureRunning` (or
just restarting Signal K) recreates the managed container with the
memory cap actually applied. Verify with `podman inspect sk-<name>
--format '{{.HostConfig.Memory}}'` — a non-zero value confirms the cap
is in cgroup state, not just on the command line.

This is purely a host-side prerequisite; signalk-container cannot
override the kernel's controller delegation.

#### Raspberry Pi OS: `cgroup_disable=memory` in the kernel cmdline

If you're on a Raspberry Pi 4/5 running Raspberry Pi OS Trixie (and
likely earlier Pi OS releases) and the systemd `Delegate=memory` snippet
above **doesn't work** — `cat /sys/fs/cgroup/cgroup.controllers` still
shows `cpuset cpu io pids` after a reboot — the cause is one level
deeper. The Pi's GPU firmware injects `cgroup_disable=memory` into the
kernel boot cmdline, so the memory controller never reaches systemd.

Quick check:

```bash
grep -o "cgroup_disable=memory" /proc/cmdline
# Prints "cgroup_disable=memory" → you're hit.
```

Full runbook with copy-pasteable commands, verification steps, and
revert instructions: **[doc/cgroup-memory-on-raspberry-pi-os.md](doc/cgroup-memory-on-raspberry-pi-os.md)**.

The deployment doctor at `/api/doctor/deployment` also detects this
scenario and surfaces the same kernel-cmdline fix in its `remediation`
array, so you don't have to guess which layer is broken first.

### Watch out for systemd auto-restart (Quadlet / `Restart=always`)

If you run Signal K via a podman Quadlet (`*.container` in
`~/.config/containers/systemd/`) or a systemd unit with
`Restart=always`, the unit silently restarts the SK container within
`RestartSec` seconds of any stop — including operator-initiated
`podman stop`. This races with manually-started replacement containers
on the same port.

For test/diagnostic swaps, temporarily disable the unit's
restart/recovery policy before stopping the container and re-enable it
afterward. With a `--user` Quadlet (substitute your actual unit name):

```bash
systemctl --user mask  <your-signalk-unit>.service   # suppress auto-restart
# … run your test container on port 3000 …
systemctl --user unmask <your-signalk-unit>.service  # re-enable
systemctl --user start  <your-signalk-unit>.service
```

This is purely an operator-side consideration; signalk-container has no
visibility into systemd-managed lifecycles.

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
- **Disable user-namespace remap (ZFS escape hatch)** -- off by default. Secondary fix for ZFS / id-map-less hosts; prefer the host-side `fuse-overlayfs` storage driver first ([ZFS host notes](#zfs-and-other-idmap-incompatible-filesystems)). Enable only if container creation fails with `crun: writing file /proc/<pid>/gid_map: Invalid argument` and you cannot switch storage drivers. With the flag on, signalk-container stops emitting `--userns=keep-id` for rootless Podman; bind-mount file ownership still lands on the host caller for root-by-default images (questdb, grafana, mayara), but non-root images lose host-caller ownership in exchange for being able to start at all.

### Managed Containers (one card per running or stopped container)

- Container name, image, state, and port mappings
- **Start** / **Stop** / **Logs** / **Remove** buttons appropriate to the current state
- **Logs** opens a live-streaming popup of the container's combined stdout/stderr — works for both running and stopped containers
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

> If you're running Signal K inside a container and a memory limit
> appears to be ignored, the host's cgroup controller delegation is
> almost certainly the cause — see [Cgroup controller delegation](#cgroup-controller-delegation) above.

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

## Mounting the SignalK config root (`signalkConfigRootMount`)

`signalkDataMount` resolves to `app.getDataDirPath()`, which Signal K rewrites per-plugin to the plugin's _own_ subdirectory (`<configRoot>/plugin-config-data/<pluginId>/`). That's right when a managed container needs a private writable area inside the SignalK data tree.

When a managed container needs the **entire SignalK installation config** (`settings.json`, `security.json`, `package.json`, the whole `plugin-config-data/` tree, etc.) — typical for backup, audit, or config-sync tools — use `signalkConfigRootMount` instead. It resolves through `app.config.configPath` (the actual top of the tree, typically `~/.signalk/`).

```typescript
const SK_MOUNT = "/signalk-data";

await containers.ensureRunning("signalk-backup-server", {
  image: "ghcr.io/dirkwa/signalk-backup-server",
  tag: "latest",
  signalkConfigRootMount: SK_MOUNT, // ← mount the SignalK config root
});
// Inside the container:
//   /signalk-data/settings.json
//   /signalk-data/security.json
//   /signalk-data/plugin-config-data/<plugin>/...
```

The deployment-mode resolution is identical to `signalkDataMount`: bare-metal returns the host path directly, containerised SignalK gets resolved through the SignalK container's mount list (named volumes preserved, bind mounts walked correctly).

`app.config.configPath` is provided by the SignalK server runtime. If the caller's `app` object lacks it (a non-standard host), `ensureRunning()` throws.

> [!note]
> The same named-volume subpath caveat applies — Docker doesn't support subpath mounts on volumes. If `app.config.configPath` happens to live under a parent-directory bind, signalk-container computes the exact host path so the container sees the right tree.

### When SignalK runs in a container: self-container detection

`signalkDataMount`, `signalkAccessiblePorts`, and `resolveHostPath` all need to know **which container** SignalK itself is running in (so they can read its mount list and join its network). signalk-container detects this automatically by cascading three signals — most reliable first:

1. **`SIGNALK_CONTAINER_ID` environment variable** (explicit override)
2. **`HOSTNAME`** — the default in container deployments where the runtime sets `HOSTNAME=<container-id>`
3. **`/proc/self/cgroup`** — extracts the container ID from the cgroup path (works for cgroup v1/v2, Docker, Podman rootless and rootful, and Kubernetes)

The cascade is **mostly** robust against the **`network_mode: host`** case where `HOSTNAME` is the host machine name (e.g. `halos`) rather than the container ID — the cgroup-based step usually picks up the real ID. On some hosts, however, `/proc/self/cgroup` under host networking reads just `0::/` (no container path), and the cascade falls through entirely. When the doctor reports `status: self-id-unresolved` and consumer plugins fail to create sibling containers with `Error: statfs <path>: no such file or directory`, set the override explicitly:

**When automatic detection fails** (custom deployment, unusual cgroup layout, or a future runtime we don't recognise), set `SIGNALK_CONTAINER_ID` to the container's name or ID in your compose file:

```yaml
services:
  signalk:
    image: signalk/signalk-server
    container_name: signalk
    environment:
      - SIGNALK_CONTAINER_ID=signalk # ← matches container_name above
    network_mode: host # only required if you use host networking
    # ... volumes, etc.
```

You'll see "could not detect self container id" in the SignalK log when the cascade has failed; the override resolves it without code changes.

For a full walkthrough of the in-container deployment (socket bind-mount, self-container-id override, reference quadlet, troubleshooting table) see **[doc/run-in-container.md](doc/run-in-container.md)**.

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

const addr = await containers.resolveContainerAddress(
  "my-streamer",
  STREAM_PORT,
);
if (!addr) throw new Error("Container address not available");
// Connect from the SignalK process — addr is always the right host:port:
http.get(`http://${addr}/stream`, handleResponse);
```

signalk-container resolves the correct networking strategy automatically:

| Deployment                             | Strategy                                                                        | Address returned                                         |
| -------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Bare-metal Signal K                    | Port bound to `127.0.0.1` (first free port ≥ declared value)                    | `127.0.0.1:8090` (or `127.0.0.1:8091` if 8090 was taken) |
| Containerised, user-defined network    | Container attached to SignalK's own Docker/Podman network; no host port exposed | `sk-my-streamer:8090` (Docker DNS)                       |
| Containerised, default bridge (no DNS) | Container shares SignalK's network namespace                                    | `127.0.0.1:8090`                                         |

The allocated address is cached for the lifetime of the plugin session, so repeated `ensureRunning()` calls never trigger an unwanted container recreate due to a port number change.

> [!note]
> `signalkAccessiblePorts` sets up networking automatically. Do not combine it with
> a manual `ports` or `networkMode` entry for the same container — the field takes
> full ownership of those concerns.

---

# Developer / plugin-author reference

The sections below are for plugin authors integrating with signalk-container. End users deploying the plugin do not need them.

## How Other Plugins Use It

```typescript
const containers = (globalThis as any).__signalk_containerManager;
if (!containers) {
  app.setPluginError("signalk-container plugin required");
  return;
}

// Wait for runtime detection to settle, then verify a runtime was found.
await containers.whenReady();
if (!containers.getRuntime()) {
  app.setPluginError("No container runtime detected");
  return;
}

// Start a long-running service container. ensureRunning compares this
// config against the live container and recreates on drift — no per-
// plugin hash file or remove() dance needed.
await containers.ensureRunning("my-service", {
  image: "myorg/myimage",
  tag: "latest",
  signalkDataMount: "/data", // resolves to the SignalK data dir, regardless of deployment
  signalkAccessiblePorts: [8080], // port 8080 in the container must be reachable by SignalK
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

| Method                                          | Description                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getRuntime()`                                  | Returns `{ runtime, version, isRootless, socketPath, ... }` (a `ContainerRuntimeInfo`) or `null`                                                                                                                                                                                                                     |
| `whenReady()`                                   | Resolves once runtime detection settles (success OR failure). Replaces the polling-loop pattern; check `getRuntime()` after the await                                                                                                                                                                                |
| `pullImage(image, onProgress?)`                 | Pull a container image (auto-qualifies for Podman)                                                                                                                                                                                                                                                                   |
| `imageExists(image)`                            | Check if image exists locally                                                                                                                                                                                                                                                                                        |
| `getImageDigest(imageOrContainer)`              | Local image ID (sha256) for an image:tag or container                                                                                                                                                                                                                                                                |
| `ensureRunning(name, config, options?)`         | Create and start container if not running; auto-recreates on config drift across `image`, `tag`, `command`, `networkMode`, `env`, `volumes`, `ports`                                                                                                                                                                 |
| `recreate(name, config, options?)`              | Force-recreate: remove (if present) + ensureRunning. Always replaces an existing container (running or stopped) — use this for "update now" / plugin-startup self-heal flows where correctness must not depend on drift detection (1.12.0+)                                                                          |
| `start(name)`                                   | Start a stopped container                                                                                                                                                                                                                                                                                            |
| `stop(name)`                                    | Stop a running container                                                                                                                                                                                                                                                                                             |
| `remove(name)`                                  | Stop and remove a container                                                                                                                                                                                                                                                                                          |
| `getState(name)`                                | Returns `running`, `stopped`, `missing`, or `no-runtime`                                                                                                                                                                                                                                                             |
| `runJob(config)`                                | Execute a one-shot container job                                                                                                                                                                                                                                                                                     |
| `cleanupOrphanedJobs(filter)`                   | Reap `sk-job-*` containers leaked by a previous server lifecycle, filtered by the caller's `ownerPluginId`. Idempotent — returns `{ reaped: OrphanJobInfo[] }` so the plugin can roll back any per-job state it had written                                                                                          |
| `getLogs(name, options?)`                       | One-shot fetch of the last N lines of a container's combined stdout+stderr log. `tail` defaults to 200, max 10000; `since` is unix-epoch seconds                                                                                                                                                                     |
| `prune()`                                       | Remove dangling images                                                                                                                                                                                                                                                                                               |
| `listContainers()`                              | List all `sk-` prefixed containers                                                                                                                                                                                                                                                                                   |
| `execInContainer(name, command)`                | Run a command inside a running container                                                                                                                                                                                                                                                                             |
| `ensureNetwork(name)`                           | Create a Podman/Docker network if it doesn't exist                                                                                                                                                                                                                                                                   |
| `removeNetwork(name)`                           | Remove a network                                                                                                                                                                                                                                                                                                     |
| `connectToNetwork(container, network)`          | Add a container to a network (bridge mode only)                                                                                                                                                                                                                                                                      |
| `disconnectFromNetwork(container, net)`         | Remove a container from a network                                                                                                                                                                                                                                                                                    |
| `updates.register(reg)`                         | Register a container for update detection                                                                                                                                                                                                                                                                            |
| `updates.unregister(pluginId)`                  | Stop tracking updates for a plugin                                                                                                                                                                                                                                                                                   |
| `updates.checkOne(pluginId)`                    | Force a fresh update check (or coalesce with in-flight)                                                                                                                                                                                                                                                              |
| `updates.checkAll()`                            | Force a fresh update check for every registered plugin; resolves to the array of results                                                                                                                                                                                                                             |
| `updates.getLastResult(pluginId)`               | Cached last result, no network                                                                                                                                                                                                                                                                                       |
| `updates.sources`                               | Built-in version-source factories — `sources.githubReleases(repo, options?)` and `sources.dockerHubTags(image, options?)` — convenience for building an `UpdateRegistration.source`                                                                                                                                  |
| `manifest.get(pluginId)`                        | Read the persisted manifest for one consumer plugin, or `null` if none. Writes happen automatically after successful `ensureRunning` calls — this is read-only                                                                                                                                                       |
| `manifest.list()`                               | Return every persisted manifest in the data directory. Order is unspecified                                                                                                                                                                                                                                          |
| `manifest.getContainerHistory(containerName)`   | Bounded history (max 20 entries) of digest changes for a specific container. Throws "Ambiguous container history" if more than one manifest references the same `containerName` — disambiguate via `manifest.get(pluginId)`                                                                                          |
| `updateResources(name, limits)`                 | Apply new resource limits live, fall back to recreate                                                                                                                                                                                                                                                                |
| `getResources(name)`                            | Currently effective limits (plugin defaults ⊕ user override)                                                                                                                                                                                                                                                         |
| `resolveSignalkDataMount()`                     | Resolve the volume name or host path that backs `app.getDataDirPath()` in the current deployment; returns `null` if the runtime is not yet initialised                                                                                                                                                               |
| `resolveHostPath(absPath)`                      | Translate an arbitrary absolute path into the `{ source, subPath }` pair the runtime needs to mount it; handles bare-metal, bind, and named-volume topologies                                                                                                                                                        |
| `resolveContainerAddress(name, port)`           | Return the `host:port` string to reach `port` on a managed container from the SignalK process; call after `ensureRunning()` with `signalkAccessiblePorts` set                                                                                                                                                        |
| `doctor.imageRunsAsUser(image, user?)`          | Probe whether `image` runs cleanly under the host-UID mapping signalk-container will emit (1.8.0+). Never throws — returns `{ ok, output, error? }`                                                                                                                                                                  |
| `doctor.selfDeployment()`                       | Diagnose the Signal K deployment itself: socket resolution, daemon reachability, rootless/rootful detection, and (when containerised) self-container ID. Returns `{ status, remediation, ... }` — see `SelfDeploymentResult` in `src/types.ts`                                                                       |
| `doctor.generateSetupSnippet(format?, result?)` | Generate a ready-to-paste compose fragment (`format: "compose"`, default) or `podman/docker run` command (`format: "run"`) tailored to the detected runtime — wires up the socket bind-mount. Pure templating over `SelfDeploymentResult`; includes a `dockerfile` note (no image change needed) and operator notes. |

## REST Endpoints

All mounted at `/plugins/signalk-container/api/`:

| Method | Path                                     | Description                                                                                                                                                                                                              |
| ------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/runtime`                               | Detected runtime info                                                                                                                                                                                                    |
| GET    | `/containers`                            | List managed containers                                                                                                                                                                                                  |
| GET    | `/containers/:name/state`                | Container state                                                                                                                                                                                                          |
| POST   | `/containers/:name/start`                | Start a stopped container                                                                                                                                                                                                |
| POST   | `/containers/:name/stop`                 | Stop a running container                                                                                                                                                                                                 |
| POST   | `/containers/:name/remove`               | Stop and remove a container                                                                                                                                                                                              |
| GET    | `/containers/:name/logs?tail=N&since=ts` | Last N lines of the container's combined stdout+stderr log (one-shot). `tail` defaults 200, max 10000                                                                                                                    |
| GET    | `/containers/:name/logs/stream`          | Server-Sent Events stream of live log lines. Closes when the container is removed or the client disconnects                                                                                                              |
| POST   | `/prune`                                 | Prune dangling images                                                                                                                                                                                                    |
| GET    | `/updates`                               | List last update-check results                                                                                                                                                                                           |
| GET    | `/updates/:pluginId`                     | Last update-check result for one plugin                                                                                                                                                                                  |
| POST   | `/updates/:pluginId/check`               | Force a fresh update check (HTTP 200 even when offline)                                                                                                                                                                  |
| GET    | `/containers/:name/resources`            | Effective resource limits + user override                                                                                                                                                                                |
| POST   | `/containers/:name/resources`            | Apply new resource limits (live or recreate). Body is a `ContainerResourceLimits` diff against the consumer plugin's default.                                                                                            |
| DELETE | `/containers/:name/resources`            | Clear any user override and restore the consumer plugin's pristine default limits to the running container.                                                                                                              |
| POST   | `/doctor/image`                          | Probe whether an image runs cleanly under the live host-UID mapping. Body: `{ image, tag?, user? }`. Never 5xx for a failed probe — `{ ok: false, error }` is a successful response (1.8.0+).                            |
| GET    | `/doctor/deployment`                     | Diagnose this Signal K deployment: socket resolution, daemon reachability, rootless/rootful detection, self-container ID cascade. Returns a `SelfDeploymentResult` with `status` and copy-pasteable `remediation` lines. |
| GET    | `/doctor/snippet?format=compose\|run`    | Generate a ready-to-paste compose fragment or shell command for setting up Signal K with this runtime. `text/plain` by default; pass `Accept: application/json` for the structured `SetupSnippetResult`.                 |

## Configuration

| Setting                      | Default  | Description                                                                                                                                                                                                                                                                          |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Preferred runtime            | `auto`   | Auto-detect, or force `podman`/`docker`                                                                                                                                                                                                                                              |
| Auto-prune images            | `weekly` | `off`, `weekly`, or `monthly`                                                                                                                                                                                                                                                        |
| Max concurrent jobs          | `2`      | Limit parallel one-shot job executions                                                                                                                                                                                                                                               |
| Update check interval        | `24h`    | How often to check for container image updates (e.g. `24h`, `12h`, `1h`). Min 1h.                                                                                                                                                                                                    |
| Background update checks     | `true`   | Periodically check for updates in the background. Disable on metered connections — manual checks via the UI button still work.                                                                                                                                                       |
| Disable user-namespace remap | `false`  | Suppress rootless-Podman `--userns=keep-id` on filesystems that cannot be id-mapped (ZFS, some encrypted FS). Secondary escape hatch only — the recommended primary fix is host-side `fuse-overlayfs` storage (see [ZFS host notes](#zfs-and-other-idmap-incompatible-filesystems)). |
| Container overrides          | `{}`     | Per-container resource limits (CPU, memory, PIDs). Field-level merged on top of consumer plugin defaults. See dev guide.                                                                                                                                                             |

### ZFS and other idmap-incompatible filesystems

Rootless Podman uses `--userns=keep-id` so files written into bind mounts land owned by the Signal K host user. On filesystems the Linux kernel cannot id-map — ZFS is the canonical case, some encrypted filesystems behave the same way — this mapping either fails at container create or triggers a multi-minute per-file `chown` sweep across the image layers.

The doctor (`GET /plugins/signalk-container/api/doctor/deployment`) flags this proactively when Podman is rootless and the storage root sits on a known-hazard filesystem; the response's `containerStorage.advice` array carries the up-to-date remediation steps. Two fixes exist, in order of preference:

1. **Switch the host's rootless Podman storage driver to `fuse-overlayfs`.** Recommended whenever possible. Avoids the chown sweep entirely while preserving correct bind-mount ownership for every image. See [Podman's storage configuration docs](https://github.com/containers/storage/blob/main/docs/containers-storage.conf.5.md) for the exact `storage.conf` form and migration steps; modern Podman releases also document `fuse-overlayfs` in `man containers-storage.conf`.
2. **Enable the "Disable user-namespace remap" setting** in this plugin's config panel. Escape hatch for hosts that cannot switch storage drivers. Bind-mount ownership stays correct for root-by-default managed containers (questdb, grafana, mayara); non-root images give up host-caller ownership in exchange for being able to start at all.

If the host runs a recent-enough kernel + Podman + ZFS combination that supports kernel-level idmapped mounts natively, neither workaround is required — the doctor advisory will fall silent on its own once the hazard heuristic no longer matches.

## License

MIT

## Acknowledgements

The plugin icon (`icon.svg`) is the **container** glyph from
[Lucide Icons](https://lucide.dev), used under the ISC License. See
[`NOTICE`](NOTICE) for the full attribution.
