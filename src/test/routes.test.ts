import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerUpdateRoutes } from "../updates/routes.js";
import { UpdateService } from "../updates/service.js";
import { MemoryUpdateCache } from "../updates/cache.js";
import type { ContainerRuntimeInfo, ContainerState } from "../types.js";
import type { VersionSource, VersionSourceResult } from "../updates/types.js";

// ---------- minimal Express stub ----------

type Handler = (req: FakeRequest, res: FakeResponse) => void | Promise<void>;

interface FakeRequest {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

class FakeResponse {
  statusCode = 200;
  body: unknown = null;
  ended = false;
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  json(value: unknown): this {
    this.body = value;
    this.ended = true;
    return this;
  }
}

class FakeRouter {
  private routes = new Map<string, Handler>();
  get(path: string, handler: Handler): void {
    this.routes.set(`GET ${path}`, handler);
  }
  post(path: string, handler: Handler): void {
    this.routes.set(`POST ${path}`, handler);
  }
  use(): void {}
  async dispatch(
    method: "GET" | "POST",
    path: string,
    params: Record<string, string> = {},
  ): Promise<FakeResponse> {
    // Match exact path first.
    let handler = this.routes.get(`${method} ${path}`);
    // If not found, try parameterized matches: replace :param with regex.
    if (!handler) {
      for (const [key, h] of this.routes.entries()) {
        if (!key.startsWith(`${method} `)) continue;
        const route = key.slice(method.length + 1);
        const regex = new RegExp(
          "^" + route.replace(/:(\w+)/g, "([^/]+)") + "$",
        );
        const match = path.match(regex);
        if (match) {
          const paramNames = Array.from(route.matchAll(/:(\w+)/g)).map(
            (m) => m[1],
          );
          paramNames.forEach((name, i) => {
            params[name] = match[i + 1];
          });
          handler = h;
          break;
        }
      }
    }
    if (!handler) {
      const res = new FakeResponse();
      res.statusCode = 404;
      res.body = { error: "no route" };
      return res;
    }
    const req: FakeRequest = { params, query: {}, body: {} };
    const res = new FakeResponse();
    await handler(req, res);
    return res;
  }
}

// ---------- service helpers ----------

const dummyRuntime: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.0.0",
  isPodmanDockerShim: false,
};

function makeService(
  opts: {
    runtime?: ContainerRuntimeInfo | null;
    state?: ContainerState;
    versionSourceResult?: VersionSourceResult;
    versionSourceThrows?: () => Error;
  } = {},
): UpdateService {
  const versionSource: VersionSource = {
    fetch: async () => {
      if (opts.versionSourceThrows) throw opts.versionSourceThrows();
      return opts.versionSourceResult ?? { kind: "version", latest: "1.0.0" };
    },
  };
  const service = new UpdateService({
    app: { debug: () => {}, error: () => {} },
    containers: {
      getRuntime: () => opts.runtime ?? dummyRuntime,
      getState: async () => opts.state ?? "running",
      pullImage: async () => {},
      getImageDigest: async () => "sha256:abc",
    },
    clock: {
      now: () => Date.now(),
      setTimer: () => null,
      clearTimer: () => {},
    },
    cache: new MemoryUpdateCache(),
    backgroundChecks: false,
  });
  service.register({
    pluginId: "test-plugin",
    containerName: "test-plugin",
    image: "foo/bar",
    currentTag: () => "1.0.0",
    versionSource,
  });
  return service;
}

// ---------- tests ----------

describe("routes", () => {
  it("GET /api/updates returns 503 when runtime missing", async () => {
    const router = new FakeRouter();
    const service = makeService();
    registerUpdateRoutes(router as any, service, () => false);
    const res = await router.dispatch("GET", "/api/updates");
    assert.equal(res.statusCode, 503);
  });

  it("GET /api/updates returns list of last results", async () => {
    const router = new FakeRouter();
    const service = makeService();
    await service.checkOne("test-plugin"); // populate lastResult
    registerUpdateRoutes(router as any, service, () => true);
    const res = await router.dispatch("GET", "/api/updates");
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.body));
    assert.equal((res.body as unknown[]).length, 1);
  });

  it("GET /api/updates/:pluginId returns last result", async () => {
    const router = new FakeRouter();
    const service = makeService();
    await service.checkOne("test-plugin");
    registerUpdateRoutes(router as any, service, () => true);
    const res = await router.dispatch("GET", "/api/updates/test-plugin");
    assert.equal(res.statusCode, 200);
    const body = res.body as { pluginId: string };
    assert.equal(body.pluginId, "test-plugin");
  });

  it("GET /api/updates/:pluginId returns 404 for unknown plugin", async () => {
    const router = new FakeRouter();
    const service = makeService();
    registerUpdateRoutes(router as any, service, () => true);
    const res = await router.dispatch("GET", "/api/updates/nope");
    assert.equal(res.statusCode, 404);
  });

  it("POST /api/updates/:pluginId/check runs a fresh check", async () => {
    const router = new FakeRouter();
    const service = makeService();
    registerUpdateRoutes(router as any, service, () => true);
    const res = await router.dispatch("POST", "/api/updates/test-plugin/check");
    assert.equal(res.statusCode, 200);
    const body = res.body as { reason: string };
    assert.equal(body.reason, "up-to-date");
  });

  it("POST /api/updates/:pluginId/check returns HTTP 200 with reason=offline when offline", async () => {
    const router = new FakeRouter();
    const service = makeService({
      versionSourceThrows: () => {
        const err = new Error("fetch failed") as Error & { cause?: unknown };
        const cause = new Error("ENETUNREACH") as NodeJS.ErrnoException;
        cause.code = "ENETUNREACH";
        err.cause = cause;
        return err;
      },
    });
    registerUpdateRoutes(router as any, service, () => true);
    const res = await router.dispatch("POST", "/api/updates/test-plugin/check");
    assert.equal(
      res.statusCode,
      200,
      "offline must NEVER produce 5xx — captain-at-sea UX",
    );
    const body = res.body as { reason: string };
    assert.equal(body.reason, "offline");
  });

  it("POST /api/updates/:pluginId/check returns 404 for unknown plugin", async () => {
    const router = new FakeRouter();
    const service = makeService();
    registerUpdateRoutes(router as any, service, () => true);
    const res = await router.dispatch("POST", "/api/updates/nope/check");
    assert.equal(res.statusCode, 404);
  });
});
