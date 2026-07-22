/**
 * Test helpers for building a mock `ContainerClient` (the dockerode-over-
 * socket injection seam). A test supplies only the behaviour its subject
 * needs via `MockClientSpec`; anything unspecified returns a benign default
 * (e.g. `inspect()` on an unlisted container throws a 404, `version()`
 * resolves to a stub, `wait()` resolves `{StatusCode: 0}`).
 */
import { PassThrough } from "node:stream";
import type { ContainerClient } from "../../client.js";

type Json = Record<string, unknown>;

export interface MockContainerBehaviour {
  inspect?: Json | (() => Promise<Json>) | Error;
  start?: () => Promise<unknown>;
  stop?: () => Promise<unknown>;
  remove?: () => Promise<unknown>;
  update?: () => Promise<unknown>;
  wait?: Json | (() => Promise<Json>);
  logs?: Buffer | NodeJS.ReadableStream | (() => Promise<unknown>);
  /**
   * Behaviour for `container.exec()`. The mock returns a real dockerode-shaped
   * exec object (`start()` → a finished stream carrying `output`, `inspect()`
   * → `{ ExitCode }`), so `runExec` works without the test hand-rolling it.
   * Each invocation's `Cmd` is recorded under the `exec` calls key.
   */
  exec?: { output?: string; exitCode?: number };
}

export interface MockClientSpec {
  /** Per-container behaviour keyed by the (prefixed) container name/id. */
  containers?: Record<string, MockContainerBehaviour>;
  /** Default behaviour for any container id not explicitly listed. */
  defaultContainer?: MockContainerBehaviour;
  images?: Record<string, Json | Error>;
  networks?: Record<string, { inspect?: Json | Error }>;
  version?: Json;
  info?: Json;
  /** Container summaries for `listContainers()`; an `Error` rejects. */
  listContainers?: Json[] | Error;
  /** Image summaries for `listImages()`; an `Error` rejects the call. */
  listImages?: Json[] | Error;
  /** Per-image-id `remove()` result, keyed by id. An `Error` rejects. */
  imageRemove?: Record<string, Json | Error>;
  /** Result for `pruneImages()`; an `Error` rejects the call. */
  pruneImages?: Json | Error;
  /** Records calls for assertions: `calls.get("stop")` etc. */
  calls?: Map<string, unknown[]>;
}

function notFound(msg: string): Error {
  const err = new Error(msg) as Error & { statusCode?: number };
  err.statusCode = 404;
  return err;
}

function record(spec: MockClientSpec, op: string, arg: unknown): void {
  if (!spec.calls) return;
  const list = spec.calls.get(op) ?? [];
  list.push(arg);
  spec.calls.set(op, list);
}

async function resolveInspect(
  b: MockContainerBehaviour | undefined,
  id: string,
) {
  if (!b || b.inspect === undefined) throw notFound(`no such container ${id}`);
  if (b.inspect instanceof Error) throw b.inspect;
  if (typeof b.inspect === "function") return b.inspect();
  return b.inspect;
}

/**
 * Build a mock `ContainerClient`. Cast through `unknown` because the mock
 * implements only the surface the subject under test exercises.
 */
export function makeMockClient(spec: MockClientSpec = {}): ContainerClient {
  const containerBehaviour = (id: string): MockContainerBehaviour | undefined =>
    spec.containers?.[id] ?? spec.defaultContainer;

  const mock = {
    getContainer(id: string) {
      const b = containerBehaviour(id);
      return {
        id,
        inspect: () => resolveInspect(b, id),
        start: () => {
          record(spec, "start", id);
          return b?.start?.() ?? Promise.resolve();
        },
        stop: (opts?: unknown) => {
          record(spec, "stop", { id, opts });
          return b?.stop?.() ?? Promise.resolve();
        },
        remove: (opts?: unknown) => {
          record(spec, "remove", { id, opts });
          return b?.remove?.() ?? Promise.resolve();
        },
        update: (payload?: unknown) => {
          record(spec, "update", { id, payload });
          return b?.update?.() ?? Promise.resolve();
        },
        wait: () => {
          record(spec, "wait", id);
          if (typeof b?.wait === "function") return b.wait();
          return Promise.resolve(b?.wait ?? { StatusCode: 0 });
        },
        logs: (opts?: unknown) => {
          record(spec, "logs", { id, opts });
          if (typeof b?.logs === "function") return b.logs();
          return Promise.resolve(b?.logs ?? Buffer.from(""));
        },
        exec: (execOpts?: { Cmd?: string[] }) => {
          record(spec, "exec", { id, cmd: execOpts?.Cmd ?? [] });
          const output = b?.exec?.output ?? "";
          const exitCode = b?.exec?.exitCode ?? 0;
          return Promise.resolve({
            start: () => {
              const stream = new PassThrough();
              stream.end(Buffer.from(output));
              return Promise.resolve(stream);
            },
            inspect: () => Promise.resolve({ ExitCode: exitCode }),
          });
        },
      };
    },
    getImage(name: string) {
      return {
        inspect: () => {
          const img = spec.images?.[name];
          if (img === undefined) throw notFound(`no such image ${name}`);
          if (img instanceof Error) throw img;
          return Promise.resolve(img);
        },
        remove: (opts?: unknown) => {
          record(spec, "image.remove", { name, opts });
          const r = spec.imageRemove?.[name];
          if (r instanceof Error) return Promise.reject(r);
          return Promise.resolve(r ?? { Untagged: name });
        },
      };
    },
    getNetwork(name: string) {
      return {
        inspect: () => {
          const n = spec.networks?.[name];
          if (!n || n.inspect === undefined) {
            throw notFound(`no such network ${name}`);
          }
          if (n.inspect instanceof Error) throw n.inspect;
          return Promise.resolve(n.inspect);
        },
        remove: () => {
          record(spec, "network.remove", name);
          return Promise.resolve();
        },
        connect: (opts: unknown) => {
          record(spec, "network.connect", { name, opts });
          return Promise.resolve();
        },
        disconnect: (opts: unknown) => {
          record(spec, "network.disconnect", { name, opts });
          return Promise.resolve();
        },
      };
    },
    createContainer: (opts: unknown) => {
      record(spec, "createContainer", opts);
      const id = (opts as { name?: string }).name ?? "created";
      return Promise.resolve(makeMockClient(spec).getContainer(id));
    },
    createNetwork: (opts: unknown) => {
      record(spec, "createNetwork", opts);
      return Promise.resolve({});
    },
    listContainers: (opts?: { all?: boolean; filters?: unknown }) => {
      record(spec, "listContainers", opts);
      if (spec.listContainers instanceof Error) {
        return Promise.reject(spec.listContainers);
      }
      const containers = spec.listContainers ?? [];
      // Mirror the real daemon: without `all`, only non-exited containers
      // are returned. The reaper relies on `all: true` to see stopped
      // containers; this makes a regression that drops the flag fail here.
      return Promise.resolve(
        opts?.all
          ? containers
          : containers.filter(
              (c) => (c as { State?: string }).State !== "exited",
            ),
      );
    },
    listImages: () =>
      spec.listImages instanceof Error
        ? Promise.reject(spec.listImages)
        : Promise.resolve(spec.listImages ?? []),
    pull: () => Promise.resolve(streamFrom("")),
    pruneImages: () =>
      spec.pruneImages instanceof Error
        ? Promise.reject(spec.pruneImages)
        : Promise.resolve(
            spec.pruneImages ?? { ImagesDeleted: [], SpaceReclaimed: 0 },
          ),
    version: () => Promise.resolve(spec.version ?? { Version: "5.4.2" }),
    info: () => Promise.resolve(spec.info ?? {}),
    modem: {
      followProgress: (
        _stream: NodeJS.ReadableStream,
        onFinished: (e: Error | null, r: unknown[]) => void,
      ) => onFinished(null, []),
      // Minimal demux: forward the source stream's data to stdout sink
      // unchanged (mock logs streams are not frame-wrapped).
      demuxStream: (
        source: NodeJS.ReadableStream,
        stdout: NodeJS.WritableStream,
      ) => {
        source.on("data", (c: Buffer) => stdout.write(c));
        source.on("end", () => stdout.end());
      },
    },
  };
  return mock as unknown as ContainerClient;
}

/** A finished Readable carrying `text`, for mocking one-shot/follow logs. */
export function streamFrom(text: string): NodeJS.ReadableStream {
  const s = new PassThrough();
  s.end(Buffer.from(text));
  return s;
}
