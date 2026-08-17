import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { probeCgroupControllers } from "../runtime.js";

/** Fake sysfs: path → file content; missing paths reject like ENOENT. */
function reader(files: Record<string, string>) {
  return async (path: string): Promise<string> => {
    if (path in files) return files[path];
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  };
}

const ROOT = "/sys/fs/cgroup/cgroup.controllers";
const USER_MANAGER =
  "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/cgroup.controllers";

describe("probeCgroupControllers", () => {
  it("returns null for docker (not probed)", async () => {
    const read = reader({ [ROOT]: "cpuset cpu io memory pids" });
    assert.equal(
      await probeCgroupControllers("docker", false, read, 1000),
      null,
    );
  });

  it("rootless podman: reads the user manager's delegated set, not the root", async () => {
    // systemd < 252 default Delegate=pids memory — the root file still
    // lists cpu, but a container asking for it would fail to create.
    const read = reader({
      [ROOT]: "cpuset cpu io memory hugetlb pids rdma misc",
      [USER_MANAGER]: "memory pids",
    });
    assert.deepEqual(await probeCgroupControllers("podman", true, read, 1000), [
      "memory",
      "pids",
    ]);
  });

  it("rootless podman without a user manager file falls back to the root file", async () => {
    // Inside a container (cgroupns) the root file IS the delegated set.
    const read = reader({ [ROOT]: "cpu memory pids" });
    assert.deepEqual(await probeCgroupControllers("podman", true, read, 1000), [
      "cpu",
      "memory",
      "pids",
    ]);
  });

  it("rootful podman reads the root file", async () => {
    const read = reader({
      [ROOT]: "cpuset cpu io memory pids",
      [USER_MANAGER]: "memory pids",
    });
    assert.deepEqual(
      await probeCgroupControllers("podman", false, read, 1000),
      ["cpuset", "cpu", "io", "memory", "pids"],
    );
  });

  it("returns null when nothing is readable (cgroup v1, non-Linux)", async () => {
    assert.equal(
      await probeCgroupControllers("podman", true, reader({}), 1000),
      null,
    );
  });
});
