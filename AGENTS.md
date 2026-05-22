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

- Test runner is `node:test`. Tests in `src/test/*.ts`, compiled to `dist/test/*.js`, run via `node --test "dist/test/**/*.test.js"`. The glob **must** be double-quoted so Windows expands it.
- All new code requires tests. Test behavior at the function boundary, not internal control flow.
- Inject `exec: ExecFn = execRuntime` rather than calling the runtime directly. Tests stub via `fakeExec`. See `src/test/getLiveResources.test.ts` for the canonical pattern: synthetic `{stdout, stderr, exitCode}`, no real podman invocations.
- Container-integration tests (those that actually pull `alpine:3.19`) gate on `hasContainerRuntime()` which returns `null` on Windows. Do not add new tests that pull real Linux images without the same guard.
- All tests must pass on every commit. Run `npm test` after `npm run build` (or `npm run build:all` to do both); `node --test` runs the compiled `dist/test/**/*.test.js` glob, so a fresh build is required before testing.

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

### `disableUserNamespaceRemap` (rootless-Podman + ZFS escape hatch)

`userMappingFlags()` emits `--userns=keep-id` for rootless Podman by default. On hosts whose backing filesystem cannot be id-mapped by the kernel — ZFS is the canonical case; some encrypted filesystems behave the same way — the kernel either rejects the flag outright (`crun: writing file /proc/<pid>/gid_map: Invalid argument`) or accepts it but triggers a per-file `chown` sweep across the image layers (Podman's `storage-chown-by-maps`) that is catastrophically slow on CoW filesystems.

The recommended primary fix is **host-side**: configure rootless Podman to use `fuse-overlayfs` as its storage `mount_program`. `fuse-overlayfs` stores virtual ownership in xattrs instead of materializing chowns, which makes `--keep-id` cheap on ZFS. Edit `~/.config/containers/storage.conf` on the host running Signal K (or `/etc/containers/storage.conf` system-wide) and add:

```toml
[storage]
driver = "overlay"

[storage.options.overlay]
mount_program = "/usr/bin/fuse-overlayfs"
```

Then `podman system reset && podman system migrate` to re-stage existing images under the new driver. The dirkwa/signalk-server-images Docker image ships the `fuse-overlayfs` binary so it is available inside the SignalK container too if Signal K itself runs rootless in a container on a ZFS host.

The plugin-config flag `disableUserNamespaceRemap` is a **secondary escape hatch** for users who cannot or do not want to switch storage drivers (older Podman, restricted hosts, etc.). It flips a module-level toggle (`setDisableUserns(true)` in `src/runtime.ts`) that makes `userMappingFlags()` emit no flag at all on the rootless-Podman branch. Root-by-default images (most managed containers: questdb, grafana, mayara) keep correct bind-mount file ownership because in-image UID 0 maps to the host caller's UID under the default rootless mapping; non-root images (`charts-toolbox` at UID 1001) trade host-caller ownership for the ability to start at all.

Invariants:

- The toggle is reset to `false` in `plugin.stop()` so a stop/start cycle does not strand the previous run's setting.
- The toggle only affects the rootless-Podman branch. Docker and rootful-Podman paths still emit `--user host:host` as before, because they do not use `keep-id`.
- Drift detection in the `ensureRunning` path composes through `userMappingFlags()`, so when the toggle is active no `--user` drift is reported for live containers running without explicit `--user` — automatic, no extra wiring.
- Tests live in `src/test/userMappingFlags.test.ts` under `describe("disableUserNamespaceRemap toggle", …)`. They wrap each `setDisableUserns(true)` in `try/finally` to restore the default so unrelated suites stay deterministic.

Discoverability — the doctor probes the backing filesystem for rootless-Podman storage (`SelfDeploymentResult.containerStorage`) and emits a `containerStorage.advice` block when the filesystem is in `IDMAP_HAZARD_FSTYPES` (currently `{ "zfs" }`). The advice points operators at `fuse-overlayfs` as the primary fix and the `disableUserNamespaceRemap` toggle as the secondary escape hatch. Advisory only — does **not** escalate `status`, because the host is not in a broken state until they actually try to use `--keep-id` against a non-trivial image. Tests are in `src/test/selfDeployment.test.ts` under `describe("selfDeployment — containerStorage probe (rootless podman)", …)`.

### Auto-recreate on config drift

`ensureRunning` compares the requested `ContainerConfig` against the live container's effective config on every call. On drift across `image+tag`, `command`, `networkMode`, `env`, `volumes`, or `ports`, it removes and recreates the container transparently. `resources` follows the existing live-update path. Consumer plugins do not need (and should remove) per-plugin `${dataDir}.container-hash` files — this is centralized.

The diff has an optional `prior?: ContainerConfig` parameter for detecting "unset" drift (an env key previously set is now absent, a `command` previously set is now `undefined`). The wrapper in `src/index.ts` reads it from `lastConfigs` before overwriting.

### Recursion guard in ensureRunning

After auto-recreate, `ensureRunning` recursively re-enters itself with `_postRecreate=true`. The underscore prefix marks this as an internal-use-only parameter — do not document it for consumer plugins, do not move it earlier in the signature. The guard breaks the loop if state somehow stays `running` or `stopped` after the `remove`.

### Cross-plugin API surface

`ContainerManagerApi` in `src/types.ts` is the public contract. Adding methods is fine (additive). Removing or changing signatures is a semver-major change. Anything new on the interface must have a JSDoc comment so consumer plugins see it via TypeScript intellisense — the consumer side accesses it via `(globalThis as any).__signalk_containerManager` so JSDoc is its only documentation.

`whenReady()` (added in 1.6.0) is the canonical "wait for runtime detection to settle" call. Consumer plugins should use it instead of polling `getRuntime()` in a loop. Tests and code in this repo do not need it — they have direct access to the detection result.

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
2. `npm run build:all` — `build && test`, where `build` = `clean && build:server (tsc) && build:configpanel (vite build)`. All tests must pass.
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
