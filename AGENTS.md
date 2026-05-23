# signalk-container

Shared container runtime management (Podman/Docker) for Signal K plugins. This plugin runs _inside_ the Signal K server and exposes a cross-plugin API at `globalThis.__signalk_containerManager` so other plugins (questdb, grafana, mayara, etc.) can manage their own containers without each implementing their own dockerode integration.

Key components:

- **`src/index.ts`** — Signal K plugin entrypoint. Wires the runtime probe, exposes the `ContainerManagerApi` on `globalThis`, owns the REST endpoints (`/plugins/signalk-container/api/...`) and the React config panel mount.
- **`src/containers.ts`** — Thin runtime layer. Pure functions over `execRuntime` for lifecycle (`ensureRunning`, `removeContainer`, `getContainerState`), config-drift detection (`getLiveContainerConfig`, `diffContainerConfig`), and live-state probes (`getLiveResources`, `getActualPortBindings`).
- **`src/jobs.ts`** — One-shot helper containers via `runJob`. Used by chart-provider and similar plugins that need short-lived workers (GDAL, tippecanoe, etc.).
- **`src/resources.ts`** — cgroup-limit flag emission + live-update path via `podman/docker update`. The "Bug D" precedent for diff-on-already-running lives here.
- **`src/runtime.ts`** — Runtime detection (`podman` vs `docker`), version probing, `execRuntime`/`execRuntimeLong` dispatch, `isContainerized()` self-detection.
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
- Inject `exec: ExecFn = execRuntime` rather than calling the runtime directly. Tests stub via `fakeExec`. See `src/test/getLiveResources.test.ts` for the canonical pattern: synthetic `{stdout, stderr, exitCode}`, no real podman invocations.
- Container-integration tests (those that actually pull `alpine:3.19`) live under `src/test/integration/` and gate on `hasContainerRuntime()` which returns `null` on Windows. Do not add new tests that pull real Linux images without putting them under `src/test/integration/` AND gating on the helper.
- All tests must pass on every commit. Run `npm run build:all:integration` (= `build && test:all`) locally before opening a PR; CI's `npm test` covers the unit half and you cover the integration half.

## Runtime Invariants

These are non-obvious rules baked into the runtime layer. Breaking them produces silent failures or runtime-specific bugs.

### Podman SELinux flag

`volumeArg(hostPath, containerPath, runtime)` adds `:Z` for podman bind mounts (Fedora/RHEL SELinux relabel). Named volumes — host strings without a leading `/` or `.` — MUST NOT receive `:Z`; podman rejects them with `"invalid option z for named volume"`. Always go through `volumeArg`, never build `-v host:container[:flags]` strings inline.

### Volume source policy

`ContainerConfig.volumes` accepts either a bare host-path string (auto-create — the runtime creates the host dir if missing) or `{ source, ifMissing: 'create' | 'skip' | 'abort' }` for per-volume policy. Classification happens in the API wrapper (`src/index.ts`) via `classifyVolumeSources` before `containers.ensureRunning` is called, so the diff and `buildRunArgs` both see the pre-filtered `Record<string, string>` map. The `lastConfigs` cache stores the post-filter shape — drift detection sees consistent state across calls.

`'skip'` and `'abort'` events fire `onVolumeIssue` in the options arg (`EnsureRunningOptions extends HealthCheckOptions`). Recovery events fire when a previously-missing source reappears and the container is recreated to include it; recovery tracking lives in a module-level `lastVolumeIssues: Map<name, ...>` in the wrapper. Handler errors are caught + logged at error level, never propagate.

Named volumes (source without leading `/`) always pass through; `ifMissing` only applies to host paths. `volumeSource()` in `containers.ts` is the single narrower from the union back to bare-string for the two call sites that consume `config.volumes` after classification (`buildRunArgs`, `diffContainerConfig`).

### Container log streaming

Three-layer structure (`src/runtime.ts` → `src/containers.ts` → `src/log-stream-broker.ts`):

1. `spawnRuntimeStreaming` (`src/runtime.ts`) — primitive that wraps `child_process.spawn(podman/docker, args)` with a `stop()` handle and a `makeLineSplitter`-fed `onLine` callback. Used for any long-running runtime command that needs streaming output; `tailContainerLogs` is its only current caller. Returns synchronously with a stop-handle — unlike `execRuntimeLong` which awaits process exit.
2. `tailContainerLogs` (`src/containers.ts`) — thin helper that composes `["logs", "-f", "--tail", N, prefixedName(name)]` and delegates to `spawnRuntimeStreaming`. `getContainerLogs` is the one-shot sibling (no `-f`, returns a `string[]`).
3. `LogStreamBroker` (`src/log-stream-broker.ts`) — per-container fan-out. First subscribe spawns the tail; last unsubscribe stops it. On tail exit with subscribers still attached the broker auto-respawns with exponential backoff (constants `RESPAWN_DELAY_MS` / `MAX_RESPAWN_DELAY_MS`); a delivered line resets the counter. This is what lets SSE-only consumers recover from auto-recreate or daemon glitches without waiting for a fresh subscribe call. Brokers are keyed by container name on the wrapper and auto-recreate cancels the prior subscription before installing a new one.

Consumer surfaces:

- `EnsureRunningOptions.onContainerLog` — plugin authors wire it into `app.debug`.
- `GET /api/containers/:name/logs/stream` — Server-Sent Events. Frames are `data: <line>\n\n`; `event: end` fires on container removal / plugin stop. Heartbeats keep reverse-proxy idle timeouts at bay. Client disconnect unsubscribes and ref-counts the broker down.
- `GET /api/containers/:name/logs?tail=N&since=ts` — one-shot, used by the UI for initial backfill before opening the SSE stream.

Lifecycle:

- `containers.remove(name)` and `plugin.stop()` force-close brokers; SSE clients get a final `event: end` frame.
- `safeInvokeContainerLog` mirrors `safeInvokeVolumeIssue` — sync throws and async rejections from plugin handlers route to `app.error` and never propagate.
- Combined stdout+stderr (matches `podman logs <name>` semantics). Per-stream separation is out of scope for v1.

See `src/runtime.ts`, `src/containers.ts`, `src/log-stream-broker.ts`, and the tests in `src/test/` for exact timing and lifecycle mechanics.

### Podman image qualification

`qualifyImage("foo/bar:tag", podmanRuntime)` prefixes `docker.io/` when needed (podman requires fully qualified names unless `unqualified-search-registries` is set). Docker passes through. Use this everywhere we feed an image string to a runtime command.

### Inspect-format diff pattern

When we need to read live container state, we use a single `inspect --format` call with a pipe-delimited Go-template format string:

```gotemplate
{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|...
```

This works uniformly across podman and docker, parses cheaply, and avoids the JSON-shape divergence between the two runtimes. `getLiveResources` and `getLiveContainerConfig` are the canonical examples. Do not introduce new live-state probes that parse full `inspect` JSON output.

### networkMode canonicalization

Docker reports `HostConfig.NetworkMode` as `"default"` or `"bridge"` when no `--network` was passed. Podman rootless reports `"slirp4netns"` or `"pasta"`. These are runtime defaults equivalent to "user did not request a specific network." `canonicalNetworkMode()` in `src/containers.ts` normalizes all of them to `""` so comparison against a requested `undefined`/`""` is correct. Any new comparison of `networkMode` between requested and live state must go through this helper.

### `disableUserNamespaceRemap` (rootless-Podman + idmap-incompatible storage)

Some filesystems (ZFS is the canonical case) cannot be id-mapped by the kernel. `--userns=keep-id` either fails outright on container create or triggers Podman's `storage-chown-by-maps` sweep, which is catastrophically slow on CoW metadata. The README's user-facing section documents the host-side primary fix (storage driver swap to `fuse-overlayfs`); the plugin-side escape hatch below covers the case where the operator cannot or will not change storage drivers.

Invariants:

- `disableUserNamespaceRemap` is a plugin-config boolean; default `false` preserves the historical `keep-id` behaviour for every existing deployment.
- The flag affects **only** the rootless-Podman branch of `userMappingFlags()`. Docker and rootful-Podman paths are untouched because they never emit `keep-id` to begin with.
- When the flag is active, `userMappingFlags()` returns `[]` for rootless-Podman — no `--userns` and no `--user`. The default rootless mapping (in-image UID 0 → host caller's UID) then drives bind-mount ownership for root-by-default images. Non-root images lose host-caller ownership; that's the documented trade-off.
- The toggle lives in module state in `src/runtime.ts`, set by `setDisableUserns()` from `plugin.start()` and reset to `false` in `plugin.stop()`. Stop/start cycles must not strand a previous run's setting.
- Drift detection in `ensureRunning` composes through `userMappingFlags()`, so the toggle is automatically reflected; never add a parallel codepath that re-derives the same decision.

Discoverability — `selfDeployment().containerStorage` reports the filesystem backing the rootless-Podman storage root and emits `advice` lines when the filesystem is in `IDMAP_HAZARD_FSTYPES`. Advisory only; never escalates `status`.

### Auto-recreate on config drift

`ensureRunning` compares the requested `ContainerConfig` against the live container's effective config on every call. On drift across `image+tag`, `command`, `networkMode`, `env`, `volumes`, or `ports`, it removes and recreates the container transparently. `resources` follows the existing live-update path. Consumer plugins do not need (and should remove) per-plugin `${dataDir}.container-hash` files — this is centralized.

The diff has an optional `prior?: ContainerConfig` parameter for detecting "unset" drift (an env key previously set is now absent, a `command` previously set is now `undefined`). The wrapper in `src/index.ts` reads it from `lastConfigs` before overwriting.

### Recursion guard in ensureRunning

After auto-recreate, `ensureRunning` recursively re-enters itself with `_postRecreate=true`. The underscore prefix marks this as an internal-use-only parameter — do not document it for consumer plugins, do not move it earlier in the signature. The guard breaks the loop if state somehow stays `running` or `stopped` after the `remove`.

### Cross-plugin API surface

`ContainerManagerApi` in `src/types.ts` is the public contract. Adding methods is fine (additive). Removing or changing signatures is a semver-major change. Anything new on the interface must have a JSDoc comment so consumer plugins see it via TypeScript intellisense — the consumer side accesses it via `(globalThis as any).__signalk_containerManager` so JSDoc is its only documentation.

`whenReady()` (added in 1.6.0) is the canonical "wait for runtime detection to settle" call. Consumer plugins should use it instead of polling `getRuntime()` in a loop. Tests and code in this repo do not need it — they have direct access to the detection result.

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

The signalk-universal-installer's deployment runs signalk-server itself as a Podman container, with the host's rootless podman socket bind-mounted to `/var/run/docker.sock` inside. The in-container side ships both `podman` and `docker` CLIs (the latter is what consumer plugins effectively reach, since the bind socket is on the docker path). This topology has five sharp edges the runtime detection layer must handle. Future contributors maintaining the runtime layer should know about them as one story:

| Concern                                                                                                                                                                                                                                                                                                                                                                          | Code                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rootless Podman daemon discovery under system-scoped systemd units (no `XDG_RUNTIME_DIR` in the inherited env), without breaking the in-container case where `/run/user` doesn't exist at all (podman `lstat`s `XDG_RUNTIME_DIR` at startup before honouring `--url <socket>`, so pointing it at a missing directory makes every `podman --remote` probe fail before it can run) | `cleanEnv()` in `runtime.ts` backfills `XDG_RUNTIME_DIR=/run/user/<uid>` only when that path exists                                                                  |
| Detecting that the in-container `docker` CLI is actually talking to a host-side podman daemon (default `docker --version` doesn't reveal it)                                                                                                                                                                                                                                     | `tryRuntime()` probes `docker info --format {{.DefaultRuntime}}` — `crun` → reclassify to podman                                                                     |
| Keeping podman-flag semantics (`--userns=keep-id:uid=X,gid=Y`, etc.) once we've reclassified a docker-shim to podman — the in-container docker CLI client-validates podman-specific values and rejects them before forwarding to the daemon                                                                                                                                      | `tryRuntime()` promotes the shim to `podman --remote --url <socket>` when the bind-mounted socket is reachable; `runtimeCmd()` then flips the binary back to podman  |
| Finding our own container id when HOSTNAME is empty, cgroup is `0::/`, and `Network=host` makes `/etc/hostname` return the host machine name                                                                                                                                                                                                                                     | `parseSelfContainerIdsFromMountinfo()` matches the 64-hex id the runtime stamps into bindfs source paths (`/etc/hostname`, `/etc/resolv.conf`, `/run/.containerenv`) |
| Detecting rootless mode when `podman info --format {{.Host.Security.Rootless}}` fails (in-container podman can't reach a daemon at its default socket)                                                                                                                                                                                                                           | `probeRootless()` falls back to `docker info --format {{.SecurityOptions}}` and looks for the `name=rootless` token                                                  |

The thread that runs through all five: **the in-container signalk-server has no native podman channel back to the host daemon**. Every detection that worked on bare-metal has to be re-derived from artefacts that survive the bind-mount-only topology — env vars set by the runtime, mountinfo paths, the docker compat API, the bind-mounted socket via `podman --remote --url`. When debugging future "signalk-container thinks we're not rootless" / "thinks we're not in a container" / "can't find our own id" / "consumer plugin still failing on `--userns=keep-id`" reports, check whether you're in this deployment shape first.

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
