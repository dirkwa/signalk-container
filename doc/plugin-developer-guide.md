# Plugin Developer Guide: Using signalk-container

How to use signalk-container from your Signal K plugin to manage Docker/Podman containers. This guide covers the integration patterns, pitfalls, and solutions discovered during real-world development.

## Quick Start

```typescript
// In your plugin's async startup function:
const containers = (globalThis as any).__signalk_containerManager;
if (!containers) {
  app.setPluginError('signalk-container plugin is required');
  return;
}

await containers.ensureRunning('my-service', {
  image: 'myorg/myimage',
  tag: 'latest',
  ports: { '8080/tcp': '127.0.0.1:8080' },
  volumes: { '/data': app.getDataDirPath() },
  env: { MY_VAR: 'value' },
  restart: 'unless-stopped'
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
app.setPluginStatus(plugin.id, 'Running')  // plugin.id becomes the message!
```

**Correct:**
```typescript
app.setPluginStatus('Running')
app.setPluginError('Connection failed')
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
const containers = (app as any).containerManager;  // undefined!
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
    app.setPluginStatus('Waiting for container runtime...');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!containers || !containers.getRuntime()) {
    app.setPluginError('signalk-container plugin not available');
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
  image: 'questdb/questdb',
  tag: config.version,
  ports: { '9000/tcp': '127.0.0.1:9000' },
  volumes: { '/data': app.getDataDirPath() },
  env: { MY_COMPRESSION: config.compression },
  restart: 'unless-stopped'
};

// Hash the config to detect changes
const configHash = JSON.stringify({
  tag: containerConfig.tag,
  ports: containerConfig.ports,
  env: containerConfig.env,
});

const hashFile = `${app.getDataDirPath()}/container-config-hash`;
let lastHash = '';
try {
  lastHash = readFileSync(hashFile, 'utf8');
} catch { /* first run */ }

const state = await containers.getState('my-service');
if (state !== 'missing' && configHash !== lastHash) {
  // Config changed — remove and recreate
  await containers.remove('my-service');
}

await containers.ensureRunning('my-service', containerConfig);
writeFileSync(hashFile, configHash);
```

Data is safe because volumes live on the host filesystem, not inside the container.

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
await containers.ensureRunning('my-db', {
  image: 'postgres',
  tag: '16',
  ports: { '5432/tcp': '127.0.0.1:5432' },
  volumes: { '/var/lib/postgresql/data': '/host/path' },
  env: { POSTGRES_PASSWORD: 'secret' },
  restart: 'unless-stopped',
  command: ['-c', 'shared_buffers=256MB']  // optional
});
```

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
  image: 'myorg/converter',
  command: ['convert', '/in/data.csv', '/out/data.parquet'],
  inputs: { '/in': '/host/input' },     // read-only mount
  outputs: { '/out': '/host/output' },   // read-write mount
  env: { FORMAT: 'parquet' },
  timeout: 120,                          // seconds
  onProgress: (line) => console.log(line),
  label: 'parquet-export'
});

if (result.status === 'completed') {
  console.log('Exit code:', result.exitCode);
  console.log('Output:', result.log);
}
```

### `prune(): Promise<PruneResult>`
Removes dangling images.
```typescript
{ imagesRemoved: 3, spaceReclaimed: '1.2 GB' }
```

### `listContainers(): Promise<ContainerInfo[]>`
Lists all `sk-` prefixed containers.

---

## TypeScript Types

If you want type safety, define a minimal interface in your plugin:

```typescript
interface ContainerManagerApi {
  getRuntime: () => { runtime: string; version: string } | null;
  ensureRunning: (name: string, config: unknown) => Promise<void>;
  stop: (name: string) => Promise<void>;
  remove: (name: string) => Promise<void>;
  getState: (name: string) => Promise<'running' | 'stopped' | 'missing' | 'no-runtime'>;
  pullImage: (image: string, onProgress?: (msg: string) => void) => Promise<void>;
  imageExists: (image: string) => Promise<boolean>;
  runJob: (config: unknown) => Promise<{ status: string; exitCode?: number; log: string[] }>;
  prune: () => Promise<{ imagesRemoved: number; spaceReclaimed: string }>;
  listContainers: () => Promise<unknown[]>;
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
const { ModuleFederationPlugin } = require('webpack').container;
const pkg = require('./package.json');

module.exports = {
  entry: './src/configpanel/index',
  mode: 'production',
  output: { path: path.resolve(__dirname, 'public'), clean: false },
  module: {
    rules: [{
      test: /\.jsx?$/,
      loader: 'babel-loader',
      exclude: /node_modules/,
      options: { presets: ['@babel/preset-react'] }
    }]
  },
  plugins: [
    new ModuleFederationPlugin({
      name: pkg.name.replace(/[-@/]/g, '_'),
      library: { type: 'var', name: pkg.name.replace(/[-@/]/g, '_') },
      filename: 'remoteEntry.js',
      exposes: {
        './PluginConfigurationPanel': './src/configpanel/PluginConfigurationPanel'
      },
      shared: {
        react: { singleton: true, requiredVersion: '^19' },
        'react-dom': { singleton: true, requiredVersion: '^19' }
      }
    })
  ]
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

## Common Mistakes Summary

| Mistake | Symptom | Fix |
|---------|---------|-----|
| `async start()` without catch | Silent failure, no status | Sync `start()` + `asyncStart().catch()` |
| `app.setPluginStatus(id, msg)` | Status shows plugin id as message | `app.setPluginStatus(msg)` (one arg) |
| Setting property on `app` | Other plugins can't see it | Use `globalThis.__signalk_xxx` |
| Not waiting for runtime detection | `getRuntime()` returns null | Poll until `getRuntime()` is non-null |
| Short Docker image names with Podman | Pull fails with "short-name did not resolve" | signalk-container handles this automatically |
| `DEDUP ENABLED UPSERT KEYS` in QuestDB DDL | Table creation fails | `DEDUP UPSERT KEYS` (no ENABLED) |
| Committing webpack `public/` output | CI fails with "untracked files" | Add `public/*.js` to `.gitignore` |
| `engines.node` missing from package.json | CI validation error | Add `"engines": { "node": ">=22" }` |
