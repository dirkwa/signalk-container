# Running Signal K (and signalk-container) inside a container

This guide is for operators deploying Signal K **itself** as a container — typical on Raspberry Pi rootless-podman setups and HALOS / Cerbo-style appliances. The complication: the `signalk-container` plugin lives _inside_ that container and needs to spawn _sibling_ containers (questdb, grafana, mayara, backup-server, …) via the **host's** runtime.

Bare-metal Signal K just works — skip to the [main README](../README.md). This page covers the in-container case end to end.

## Recommended image

We build and publish ready-to-use Signal K server images at **<https://github.com/dirkwa/signalk-server-images>**. The in-container `signalk-container` plugin talks to the host daemon over the Docker API on the mounted socket — no podman/docker CLI is needed in the image — so these images stay slim. (Any compatible Signal K image works; the only in-container requirement is the bind-mounted socket below. The published images are simply a convenient, tested baseline.)

Drop one of these references straight into your quadlet `Image=` line or compose `image:` line:

| Image reference                        | Tracks                              |
| -------------------------------------- | ----------------------------------- |
| `ghcr.io/dirkwa/signalk-server:latest` | Latest stable Signal K release      |
| `ghcr.io/dirkwa/signalk-server:beta`   | Latest Signal K beta release        |
| `ghcr.io/dirkwa/signalk-server:master` | Tip of upstream `master`            |
| `ghcr.io/dirkwa/signalk-server:diwa`   | `master` + experimental Dirk addons |

The reference quadlet [below](#a-reference-quadlet-rootless-podman-host) uses one of these directly.

## The architecture in one diagram

```text
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

The plugin is just an API client of the host daemon over the mounted socket; the host daemon owns the lifecycle of every container including signalk-server itself. This means **paths in mounts are host paths**, not in-container paths.

## What you must set up

### 1. Bind-mount the host runtime socket

The in-container plugin reaches the host daemon through `/var/run/docker.sock`. Mount whichever socket your host runs.

**Rootless podman host** (the common Pi / boat-computer case):

```ini
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

### 2. (Optional) point at a non-default socket path

If you mount the socket at `/var/run/docker.sock` (the recommendation above), the plugin discovers it automatically — nothing else to set. Only when you mount it somewhere else do you need to name the endpoint explicitly via `DOCKER_HOST` (or `CONTAINER_HOST`); that endpoint is then used exclusively:

```ini
Environment=DOCKER_HOST=unix:///custom/path/podman.sock
```

### 3. Set `SIGNALK_CONTAINER_ID`

`resolveHostPath` needs to know which container Signal K _itself_ is, so it can read its own mount list and translate in-container paths (`/home/node/.signalk`) to host paths (`/home/dirk/.signalk`) when asking the host daemon to mount the same data into sibling containers.

The plugin's auto-detection cascade (`HOSTNAME` → `/proc/self/cgroup`) fails on two common configurations:

- **`Network=host`** — `HOSTNAME` becomes the host machine name, not the container id.
- **rootless podman on cgroup v2 with `--cgroups=split`** — `/proc/self/cgroup` reads `0::/`, no container path embedded.

Together, these mean the cascade returns null, and `resolveHostPath` falls back to passing the in-container path unchanged. The host daemon then fails with:

```text
Error: statfs /home/node/.signalk: no such file or directory
```

The fix is to set the override explicitly to the container's name:

```ini
Environment=SIGNALK_CONTAINER_ID=signalk-master
```

(Replace `signalk-master` with whatever `ContainerName=` / `container_name:` you use.) `podman inspect <name>` accepts both names and ids, so the name is fine and survives container recreation.

### 4. Align the data-dir mount

A managed container's mount source is resolved by the **host** daemon, not inside the Signal K container. For a bind mount that means the **host path must exist on the host**; where the data is backed by a named volume the source is the volume name instead, and no host path is involved. The standard bind pattern (rootless podman quadlet):

```ini
Volume=%h/.signalk:/home/node/.signalk
```

`%h` expands to the host user's home (`/home/dirk`). On the host the data lives at `/home/dirk/.signalk`; inside SK it appears as `/home/node/.signalk`.

Three distinct APIs sit on top of that, and they expose different trees:

| API                                      | Resolves to                                                                                                                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ContainerConfig.signalkDataMount`       | signalk-container's own plugin data directory, shared by every managed container. Namespace a subdirectory. A named volume attached above that directory is refused, not mounted whole.                        |
| `ContainerConfig.signalkConfigRootMount` | The SignalK config root (`~/.signalk`) — the whole installation config.                                                                                                                                        |
| `ContainerManagerApi.resolveHostPath(p)` | The host source behind any absolute path the SK container can see, including the caller's _own_ plugin directory. This is the one that translates `/home/node/.signalk/...` back to `/home/dirk/.signalk/...`. |

Reaching for `signalkDataMount` when what you wanted was your own plugin's directory mounts the wrong tree — use `resolveHostPath` for that.

## No in-container runtime needed

signalk-container speaks the Docker API directly to the host daemon over the bind-mounted socket — it never spawns a podman/docker process inside the Signal K container. So the image needs **no** runtime CLI and **none** of the rootless infrastructure (`uidmap`, `slirp4netns`, `fuse-overlayfs`, `crun`/`conmon`); only the socket bind-mount has to be present. The plugin records the socket it resolved on `ContainerRuntimeInfo.socketPath` so consumers can inspect what it picked.

## A reference quadlet (rootless podman host)

```ini
[Unit]
Description=Signal K Server
Wants=network-online.target
After=network-online.target

[Container]
Image=ghcr.io/dirkwa/signalk-server:latest
ContainerName=signalk-master
Network=host
UserNS=keep-id
Volume=%h/.signalk:/home/node/.signalk
Volume=%t/podman/podman.sock:/var/run/docker.sock
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

## HaLOS

[HaLOS](https://github.com/halos-org/halos) (Hat Labs OS) installs Signal K as a container app. That app already bind-mounts the host `/run` into the Signal K container — so the docker socket is present — but the container user is not a member of the socket's owning group, and the image runs unprivileged (`privileged: true` does not bypass the socket's unix ACL). The plugin therefore reports `permission-denied` on a stock HaLOS install.

The Doctor recognises HaLOS and, when the socket refuses the connection, replaces the generic advice with a guide tailored to that platform — including the socket's real group id and a copy-paste command. **Open this plugin's config screen, click Doctor, and follow the steps it shows.** Because the packaged app config is owned by HaLOS, a later app update can revert the change; the Doctor detects that and shows the same fix again.

## Troubleshooting cheat-sheet

| Symptom                                                  | Cause                                                                                                                                                                   | Fix                                                                                                                                                                         |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `No container runtime socket answered the Docker API`    | Socket not bind-mounted (absent), or mounted at a non-default path. A socket that exists but rejects the connection is the `permission denied` rows below, not this one | Mount the host socket at `/var/run/docker.sock` (or set `DOCKER_HOST`/`CONTAINER_HOST` to its path); confirm the socket unit is running                                     |
| `statfs /home/node/.signalk: no such file or directory`  | Self-id detection failed; host daemon got an in-container path                                                                                                          | Set `SIGNALK_CONTAINER_ID=<your container name>` in the env                                                                                                                 |
| `permission denied` opening the socket (rootless podman) | Socket reachable but owned by a different host UID                                                                                                                      | Match the SK container user to the socket owner: `--userns=keep-id` (or `--user $(id -u):$(id -g)`) so the in-container UID equals the host UID that owns the podman socket |
| `permission denied` opening the socket (rootful docker)  | SK container user is not in the host `docker` group                                                                                                                     | Add the **host** docker GID via `group_add` — `getent group docker \| cut -d: -f3`. `privileged` and `network_mode: host` do **not** bypass the socket's unix ACL           |
| `permission denied` opening the socket on HaLOS          | Stock HaLOS install: socket mounted, but the container user is not in its owning group                                                                                  | Open the plugin's Doctor and follow the HaLOS guide it shows (see [HaLOS](#halos) above)                                                                                    |
| `could not detect self container id` in Signal K log     | Cascade returned null and no override set                                                                                                                               | Same as the second row — set `SIGNALK_CONTAINER_ID`                                                                                                                         |
| Sibling containers start but can't reach Signal K        | `Network=host` SK + bridge-network siblings                                                                                                                             | Bind SK to the same user-defined bridge as siblings, or have plugins use `host.containers.internal`                                                                         |

## Related docs

- [Plugin developer guide](plugin-developer-guide.md) — for plugin authors using `containers.ensureRunning`, `resolveHostPath`, etc.
- [README — When SignalK runs in a container](../README.md#when-signalk-runs-in-a-container-self-container-detection) — the cascade and override are described in more detail there.
- [Cgroup memory on Raspberry Pi OS](cgroup-memory-on-raspberry-pi-os.md) — separate Pi-specific gotcha that also bites in-container deployments.
