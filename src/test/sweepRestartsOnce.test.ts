import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sweepRestartsOnce } from "../index.js";
import type { ContainerStateDetail } from "../types.js";

interface Observed {
  name: string;
  count: number | undefined;
}

function makeDeps(
  names: string[],
  inspect: (name: string) => Promise<ContainerStateDetail>,
) {
  const observed: Observed[] = [];
  const forgotten: string[] = [];
  const epochs = new Map<string, number>();
  const errors: { name: string; err: unknown }[] = [];
  let retired = false;
  const deps = {
    names: () => names,
    inspect,
    emitter: {
      observeRestarts: (
        name: string,
        count: number | undefined,
        _now?: number,
        epoch?: number,
      ) => {
        // Mirror the real emitter: an observation carrying a stale epoch
        // describes a container that has since been removed.
        if (epoch !== undefined && epoch !== (epochs.get(name) ?? 0)) return;
        observed.push({ name, count });
      },
      forgetRestarts: (name: string) => {
        forgotten.push(name);
        epochs.set(name, (epochs.get(name) ?? 0) + 1);
      },
      restartEpoch: (name: string) => epochs.get(name) ?? 0,
    },
    retired: () => retired,
    onError: (name: string, err: unknown) => {
      errors.push({ name, err });
    },
  };
  return {
    deps,
    observed,
    forgotten,
    errors,
    retire: () => {
      retired = true;
    },
    /** Simulate afterContainerRemoved dropping a container's history. */
    removeContainer: (name: string) => {
      epochs.set(name, (epochs.get(name) ?? 0) + 1);
    },
  };
}

const running = (restartCount?: number): ContainerStateDetail => ({
  state: "running",
  ...(restartCount === undefined ? {} : { restartCount }),
});

describe("sweepRestartsOnce", () => {
  it("observes every managed container", async () => {
    const { deps, observed } = makeDeps(["a", "b", "c"], async (name) =>
      running(name === "b" ? 7 : 0),
    );
    await sweepRestartsOnce(deps);
    assert.deepEqual(observed, [
      { name: "a", count: 0 },
      { name: "b", count: 7 },
      { name: "c", count: 0 },
    ]);
  });

  it("isolates a failing inspect from the rest of the sweep", async () => {
    const { deps, observed, errors } = makeDeps(
      ["a", "boom", "c"],
      async (name) => {
        if (name === "boom") throw new Error("socket blip");
        return running(1);
      },
    );
    await sweepRestartsOnce(deps);
    // The failure must neither abort the sweep nor record an observation:
    // a missing sample is not evidence of a loop.
    assert.deepEqual(
      observed.map((o) => o.name),
      ["a", "c"],
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0].name, "boom");
  });

  it("drops restart history for a container that has vanished", async () => {
    const { deps, observed, forgotten } = makeDeps(
      ["gone", "here"],
      async (name) => (name === "gone" ? { state: "missing" } : running(2)),
    );
    await sweepRestartsOnce(deps);
    assert.deepEqual(forgotten, ["gone"]);
    assert.deepEqual(
      observed.map((o) => o.name),
      ["here"],
    );
  });

  it("abandons the sweep once it has been retired mid-flight", async () => {
    const seen: string[] = [];
    const ctl = makeDeps(["a", "b", "c"], async (name) => {
      seen.push(name);
      return running(1);
    });
    // A stop() lands while the first inspect is in flight.
    const deps = {
      ...ctl.deps,
      inspect: async (name: string) => {
        const detail = await ctl.deps.inspect(name);
        if (name === "a") ctl.retire();
        return detail;
      },
    };
    await sweepRestartsOnce(deps);
    // "a" was inspected but must not be recorded against the history a
    // reset has already dropped, and the sweep must stop there.
    assert.deepEqual(ctl.observed, []);
    assert.deepEqual(seen, ["a"]);
  });

  it("discards an inspect for a container removed while it was in flight", async () => {
    const ctl = makeDeps(["questdb"], async () => running(9));
    const deps = {
      ...ctl.deps,
      inspect: async (name: string) => {
        const detail = await ctl.deps.inspect(name);
        // The container is removed (and recreated under the same name)
        // while this inspect is in flight.
        ctl.removeContainer(name);
        return detail;
      },
    };
    await sweepRestartsOnce(deps);
    // Seeding the new container's history with the old one's count would
    // let a later sample compare two different container identities.
    assert.deepEqual(ctl.observed, []);
  });

  it("discards a stale `missing` for a container already replaced", async () => {
    const ctl = makeDeps(["questdb"], async () => ({
      state: "missing" as const,
    }));
    const deps = {
      ...ctl.deps,
      inspect: async (name: string) => {
        const detail = await ctl.deps.inspect(name);
        // Removed and recreated under the same name while this inspect
        // was in flight: the `missing` describes the OLD container.
        ctl.removeContainer(name);
        return detail;
      },
    };
    await sweepRestartsOnce(deps);
    // Acting on it would delete the live replacement's history and clear
    // a crash-loop alert that belongs to it.
    assert.deepEqual(ctl.forgotten, []);
  });

  it("passes an absent restart count through untouched", async () => {
    // The emitter owns the "runtime did not report it" rule; the sweep
    // must not substitute a zero that would read as a real observation.
    const { deps, observed } = makeDeps(["a"], async () => running(undefined));
    await sweepRestartsOnce(deps);
    assert.deepEqual(observed, [{ name: "a", count: undefined }]);
  });

  it("snapshots the container set before iterating", async () => {
    const names = ["a", "b"];
    const { deps, observed } = makeDeps(names, async () => {
      // A concurrent ensureRunning/remove mutating the live map must not
      // derail an in-progress sweep.
      names.push("late");
      return running(0);
    });
    await sweepRestartsOnce(deps);
    assert.deepEqual(
      observed.map((o) => o.name),
      ["a", "b"],
    );
  });
});
