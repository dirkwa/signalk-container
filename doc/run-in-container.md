# Running Signal K (and signalk-container) inside a container

This guide is for operators deploying Signal K **itself** as a container — typical on Raspberry Pi rootless-podman setups and HALOS / Cerbo-style appliances. The complication: the `signalk-container` plugin lives _inside_ that container and needs to spawn _sibling_ containers (questdb, grafana, mayara, backup-server, …) via the **host's** runtime.

Bare-metal Signal K just works — skip to the [main README](../README.md). This page covers the in-container case end to end.

## The architecture in one diagram

```
host (rootless podman as uid 1000)
  │
  ├─ podman.sock  ◄── bind-mounted as /var/run/docker.sock into signalk-server
  │
  ├─ signalk-server (container)
  │     │
  │     ├─ signalk-server process
  │     └─ signalk-container plugin
  │           │
  │           └─ talks to /var/run/docker.sock  ──► host daemon
  │                                                       │
  └─ sibling containers ◄────────────────────────────────┘
        sk-signalk-backup-server
        sk-signalk-questdb
        sk-signalk-grafana
        sk-mayara-server
        ...
```

The in-container `docker` / `podman` CLI is a thin client; the host daemon owns the lifecycle of every container including signalk-server itself. This means **paths in mounts are host paths**, not in-container paths.

## What you must set up

### 1. Bind-mount the host runtime socket

The in-container plugin reaches the host daemon through `/var/run/docker.sock`. Mount whichever socket your host runs.

**Rootless podman host** (the common Pi / boat-computer case):

```
Volume=%t/podman/podman.sock:/var/run/docker.sock
```

`%t` is the systemd-quadlet expansion of `/run/user/$UID`. For docker-compose hosts:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

**Rootful podman host:**

```yaml
volumes:
  - /run/podman/podman.sock:/var/run/docker.sock
```

### 2. Tell the in-container clients where to talk

`docker` reads `DOCKER_HOST`; podman in remote mode reads `CONTAINER_HOST` or the `--url` flag. Set whichever your image's primary CLI uses:

```
Environment=DOCKER_HOST=unix:///var/run/docker.sock
```

This is what makes a vanilla `docker ps` (or any plugin command) inside the container reach the host daemon without extra flags.

### 3. Set `SIGNALK_CONTAINER_ID`

`resolveHostPath` needs to know which container Signal K _itself_ is, so it can read its own mount list and translate in-container paths (`/home/node/.signalk`) to host paths (`/home/dirk/.signalk`) when asking the host daemon to mount the same data into sibling containers.

The plugin's auto-detection cascade (`HOSTNAME` → `/proc/self/cgroup`) fails on two common configurations:

- **`Network=host`** — `HOSTNAME` becomes the host machine name, not the container id.
- **rootless podman on cgroup v2 with `--cgroups=split`** — `/proc/self/cgroup` reads `0::/`, no container path embedded.

Together, these mean the cascade returns null, and `resolveHostPath` falls back to passing the in-container path unchanged. The host daemon then fails with:

```
Error: statfs /home/node/.signalk: no such file or directory
```

The fix is to set the override explicitly to the container's name:

```
Environment=SIGNALK_CONTAINER_ID=signalk-master
```

(Replace `signalk-master` with whatever `ContainerName=` / `container_name:` you use.) `podman inspect <name>` accepts both names and ids, so the name is fine and survives container recreation.

### 4. Align the data-dir mount

`signalkDataMount` is the source-of-truth for where consumer plugins read SK data. The destination inside sibling containers is fine as `/home/node/.signalk`, but the **host source path must exist on the host** — `resolveHostPath` rewrites the source via inspect of the SK container.

The standard pattern (rootless podman quadlet):

```
Volume=%h/.signalk:/home/node/.signalk
```

`%h` expands to the host user's home (`/home/dirk`). On the host the data lives at `/home/dirk/.signalk`; inside SK it appears as `/home/node/.signalk`; consumer plugins request `/home/node/.signalk` as the data mount and `resolveHostPath` translates back to `/home/dirk/.signalk` when calling the host daemon.

## What works automatically since 1.9.4

Older versions failed at runtime detection when the in-container podman binary couldn't operate locally:

```
Error: command required for rootless mode with multiple IDs:
exec: "newuidmap": executable file not found in $PATH
```

This happens because many slim Signal K images ship the podman CLI but not the full rootless infrastructure (`uidmap`, `slirp4netns`, `fuse-overlayfs`). The in-container podman fails its first real call.

**As of 1.9.4**, `tryRuntime` probes `podman info` after the version check. If it fails inside a container with a socket bind-mounted in, the plugin transparently switches to `podman --remote --url <socket>` for every invocation — every command routes to the host daemon, the in-container binary is just a client. No image changes required.

The same logic also picks up `CONTAINER_HOST` if you've set it.

## A reference quadlet (rootless podman host)

```ini
[Unit]
Description=Signal K Server
Wants=network-online.target
After=network-online.target

[Container]
Image=ghcr.io/your-org/signalk-server:latest
ContainerName=signalk-master
Network=host
UserNS=keep-id
Volume=%h/.signalk:/home/node/.signalk
Volume=%t/podman/podman.sock:/var/run/docker.sock
Environment=DOCKER_HOST=unix:///var/run/docker.sock
Environment=SIGNALK_CONTAINER_ID=signalk-master
Environment=SKIP_ADMINUI_VERSION_CHECK=true
PodmanArgs=--init

[Service]
Restart=always
RestartSec=5
TimeoutStartSec=900

[Install]
WantedBy=default.target
```

Install at `~/.config/containers/systemd/signalk-master.container`, then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now signalk-master
loginctl enable-linger $USER   # so the user session (and the podman socket) survives logout
```

## Troubleshooting cheat-sheet

| Symptom                                                 | Cause                                                                      | Fix                                                                                                                          |
| ------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `newuidmap: executable file not found in $PATH`         | In-container podman trying to do rootless mapping without `uidmap` package | Upgrade `signalk-container` to ≥ 1.9.4 — remote-mode fallback kicks in automatically                                         |
| `statfs /home/node/.signalk: no such file or directory` | Self-id detection failed; host daemon got an in-container path             | Set `SIGNALK_CONTAINER_ID=<your container name>` in the env                                                                  |
| `permission denied` opening the socket                  | UID mapping mismatch                                                       | Use `--userns=keep-id` (podman) or `--user $(id -u):$(id -g)` (docker), and confirm the host socket is owned by the same UID |
| `could not detect self container id` in Signal K log    | Cascade returned null and no override set                                  | Same as the second row — set `SIGNALK_CONTAINER_ID`                                                                          |
| Sibling containers start but can't reach Signal K       | `Network=host` SK + bridge-network siblings                                | Bind SK to the same user-defined bridge as siblings, or have plugins use `host.containers.internal`                          |

## Related docs

- [Plugin developer guide](plugin-developer-guide.md) — for plugin authors using `containers.ensureRunning`, `resolveHostPath`, etc.
- [README — When SignalK runs in a container](../README.md#when-signalk-runs-in-a-container-self-container-detection) — the cascade and override are described in more detail there.
- [Cgroup memory on Raspberry Pi OS](cgroup-memory-on-raspberry-pi-os.md) — separate Pi-specific gotcha that also bites in-container deployments.
