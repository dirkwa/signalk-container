import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  diffContainerConfig,
  ensureRunning,
  getLiveContainerConfig,
  removeContainer,
} from "../../containers.js";
import { detectRuntime, setDisableUserns } from "../../runtime.js";
import type { ContainerConfig } from "../../types.js";

/**
 * A container brought up with keep-id must compare as unchanged on the next
 * `ensureRunning`. Podman reports `Config.User` `0:0` for an image without a
 * USER run as `keep-id:uid=0,gid=0`, while the image's own user is empty; a
 * drift rule that compared only with the image's user recreated such a
 * container on every start.
 */
const NAME = "keepid-user-drift";
const CONFIG: ContainerConfig = {
  image: "docker.io/library/alpine",
  tag: "3.19",
  command: ["sh", "-c", "trap exit TERM; sleep 60 & wait"],
};

describe("keep-id user drift — real runtime", () => {
  after(async () => {
    const runtime = await detectRuntime("auto");
    if (runtime) await removeContainer(runtime, NAME).catch(() => {});
    setDisableUserns(false);
  });

  it("reports no user drift for a container it just created", async (t) => {
    const runtime = await detectRuntime("auto");
    if (
      !runtime ||
      runtime.runtime !== "podman" ||
      runtime.isRootless !== true
    ) {
      t.skip("needs rootless podman");
      return;
    }
    setDisableUserns(false);
    try {
      await ensureRunning(runtime, NAME, CONFIG, () => {});
    } catch (err) {
      // Hosts whose storage cannot be id-mapped reject keep-id outright
      // (GitHub's rootless runners among them); that is not this test's
      // subject.
      if (/gid_map|uid_map/.test(String(err))) {
        t.skip(`keep-id unsupported here: ${String(err)}`);
        return;
      }
      throw err;
    }
    const live = await getLiveContainerConfig(runtime, NAME);
    assert.ok(live, "the container should be inspectable");
    const { drifted } = diffContainerConfig(CONFIG, live, runtime);
    assert.ok(
      !drifted.includes("user"),
      `user drift on a fresh keep-id container (Config.User "${live.user}", image "${live.imageUser}")`,
    );
  });
});
