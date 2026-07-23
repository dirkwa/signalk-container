import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  ContainerConfig,
  ContainerManagerApi,
  ContainerRuntimeInfo,
  ContainerState,
  EnsureRunningOptions,
} from "../types.js";
// Import through the PUBLISHED subpath ("signalk-container/types"), not the
// source path — this is what consumer plugins and signalk-container-helper
// use. Resolving it here (dist is built before `npm test`) makes removing
// the export, or drifting the manifest shapes, a compile-time CI failure.
import type {
  ConsumerManifest as PublishedConsumerManifest,
  ContainerManifestEntry as PublishedContainerManifestEntry,
  HistoryEntry as PublishedHistoryEntry,
  ContainerManagerApi as PublishedContainerManagerApi,
  UpdateServiceApi as PublishedUpdateServiceApi,
  UpdateRegistration as PublishedUpdateRegistration,
  UpdateCheckResult as PublishedUpdateCheckResult,
  UpdateReason as PublishedUpdateReason,
  VersionSource as PublishedVersionSource,
  VersionSourceResult as PublishedVersionSourceResult,
  TagKind as PublishedTagKind,
} from "signalk-container/types";
import type {
  ConsumerManifest as SourceConsumerManifest,
  ContainerManagerApi as SourceContainerManagerApi,
} from "../types.js";

describe("type contracts", () => {
  it("ContainerConfig accepts valid config", () => {
    const config: ContainerConfig = {
      image: "questdb/questdb",
      tag: "9.2.0",
      ports: { "9000/tcp": "127.0.0.1:9000" },
      volumes: {
        "/var/lib/questdb": "/tmp/plugin-config-data/questdb",
      },
      env: { QDB_TELEMETRY_ENABLED: "false" },
      restart: "unless-stopped",
    };
    assert.equal(config.image, "questdb/questdb");
    assert.equal(config.tag, "9.2.0");
    assert.equal(config.restart, "unless-stopped");
  });

  it("ContainerConfig accepts signalkDataMount and signalkConfigRootMount together", () => {
    const config: ContainerConfig = {
      image: "example/tool",
      tag: "latest",
      signalkDataMount: "/data",
      signalkConfigRootMount: "/signalk",
      signalkAccessiblePorts: [3010],
    };
    assert.equal(config.signalkDataMount, "/data");
    assert.equal(config.signalkConfigRootMount, "/signalk");
  });

  it("ContainerState enum values are correct", () => {
    const states: ContainerState[] = [
      "running",
      "stopped",
      "missing",
      "no-runtime",
    ];
    assert.equal(states.length, 4);
  });

  it("ContainerRuntimeInfo has required fields", () => {
    const info: ContainerRuntimeInfo = {
      runtime: "podman",
      version: "5.2.1",
      isPodmanDockerShim: false,
    };
    assert.equal(info.runtime, "podman");
    assert.equal(info.isPodmanDockerShim, false);
  });

  it("ContainerManagerApi shape is complete", () => {
    const methods: (keyof ContainerManagerApi)[] = [
      "getRuntime",
      "pullImage",
      "imageExists",
      "ensureRunning",
      "recreate",
      "stop",
      "remove",
      "getState",
      "runJob",
      "prune",
      "listContainers",
      "resolveSignalkDataMount",
      "resolveHostPath",
      "manifest",
    ];
    assert.equal(methods.length, 14);
  });

  it("ContainerConfig accepts digest and updateChannel", () => {
    const config: ContainerConfig = {
      image: "questdb/questdb",
      tag: "9.0.0",
      digest: "sha256:" + "a".repeat(64),
      updateChannel: "digest:explicit",
    };
    assert.equal(config.updateChannel, "digest:explicit");
  });

  it("EnsureRunningOptions accepts pluginId and pluginVersion", () => {
    const opts: EnsureRunningOptions = {
      pluginId: "signalk-questdb",
      pluginVersion: "1.0.0",
    };
    assert.equal(opts.pluginId, "signalk-questdb");
  });
});

describe("published subpath: signalk-container/types", () => {
  // Assignable in both directions ⇒ the subpath type and the source type
  // are the same contract. A drift or an export change fails compilation.
  it("the subpath ContainerManagerApi equals the source one", () => {
    const fromSource = (v: SourceContainerManagerApi): void => void v;
    const fromPublished = (v: PublishedContainerManagerApi): void => void v;
    const check: [typeof fromSource, typeof fromPublished] = [
      fromPublished,
      fromSource,
    ];
    assert.equal(check.length, 2);
  });

  it("the subpath manifest types resolve and are usable", () => {
    const history: PublishedHistoryEntry = {
      ts: "2026-01-01T00:00:00Z",
      from: null,
      to: "sha256:" + "a".repeat(64),
      reason: "plugin-install",
    };
    const entry: PublishedContainerManifestEntry = {
      image: "questdb/questdb",
      declaredTag: "9.0.0",
      declaredDigest: null,
      resolvedDigest: history.to,
      resolvedAt: history.ts,
      updateChannel: "tag:latest",
      history: [history],
    };
    const manifest: PublishedConsumerManifest = {
      schemaVersion: 1,
      pluginId: "signalk-questdb",
      pluginVersion: "1.0.0",
      registeredAt: history.ts,
      containers: { questdb: entry },
    };
    // Cross-assign both directions to prove they are one contract — a
    // wider or narrower published declaration fails compilation either way.
    const asSource: SourceConsumerManifest = manifest;
    const asPublished: PublishedConsumerManifest = asSource;
    assert.equal(
      asPublished.containers.questdb.history[0].reason,
      "plugin-install",
    );
  });

  it("the subpath exposes the update-service types via ContainerManagerApi", async () => {
    // These live in ./updates/types.ts. They are reachable through
    // `ContainerManagerApi.updates`, so they must be nameable through the
    // subpath too — a consumer plugin declaring its update wiring needs them.
    // Building a real mock typed as the published shapes is the check: the
    // file fails to compile if any of these types stop being exported, and
    // the assertions exercise the wiring at runtime.
    // Annotate the return so VersionSourceResult must resolve; the tagKind
    // and reason locals do the same for TagKind and UpdateReason — all three
    // are re-exports with no other reference in this file.
    const source: PublishedVersionSource = {
      fetch: async (): Promise<PublishedVersionSourceResult> => ({
        kind: "version",
        latest: "9.2.0",
      }),
    };
    const tagKind: PublishedTagKind = "semver";
    const reason: PublishedUpdateReason = "up-to-date";
    const result: PublishedUpdateCheckResult = {
      pluginId: "signalk-questdb",
      containerName: "questdb",
      runningTag: "9.2.0",
      tagKind,
      currentVersion: "9.2.0",
      latestVersion: "9.2.0",
      updateAvailable: false,
      reason,
      checkedAt: "2026-01-01T00:00:00Z",
      lastSuccessfulCheckAt: "2026-01-01T00:00:00Z",
      fromCache: false,
    };
    const registered: string[] = [];
    const updatesImpl: PublishedUpdateServiceApi = {
      register: (reg: PublishedUpdateRegistration) =>
        void registered.push(reg.pluginId),
      unregister: () => {},
      checkOne: async () => result,
      checkAll: async () => [result],
      getLastResult: () => result,
      sources: {
        githubReleases: () => source,
        dockerHubTags: () => source,
      },
    };

    // Drive the calls through `ContainerManagerApi.updates` specifically:
    // this only compiles if that member is typed as UpdateServiceApi, so the
    // test covers the "reachable via ContainerManagerApi" contract, not just
    // a standalone stub. Assigning the impl to the member's type is the
    // boundary check; a partial cast avoids mocking every unrelated method.
    const updates: PublishedContainerManagerApi["updates"] = updatesImpl;
    const managerUpdates = (
      { updates } as Pick<PublishedContainerManagerApi, "updates">
    ).updates;

    managerUpdates.register({
      pluginId: "signalk-questdb",
      containerName: "questdb",
      image: "questdb/questdb",
      currentTag: () => "9.2.0",
      versionSource: managerUpdates.sources.githubReleases("questdb/questdb"),
    });

    assert.deepEqual(registered, ["signalk-questdb"]);
    assert.equal(
      (await managerUpdates.checkOne("signalk-questdb")).updateAvailable,
      false,
    );
  });
});
