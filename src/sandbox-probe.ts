/**
 * Executed only as fixed trusted probe code through a separate exec stream.
 * It never receives job input. Keep this function self-contained: its emitted
 * JavaScript is sent to the image's trusted Node executable.
 */
async function probe(): Promise<void> {
  const fs = await import("node:fs");
  const cp = await import("node:child_process");
  const assert = (condition: boolean) => {
    if (!condition) throw new Error("Sandbox isolation unavailable");
  };
  assert(["arm64", "x64"].includes(process.arch));
  // The exec helper's runtime parent must be outside this PID namespace.
  assert(process.ppid === 0);
  const read = (path: string) => fs.readFileSync(path, "utf8").trim();
  const status = read("/proc/self/status");
  for (const name of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
    assert(new RegExp("^" + name + ":\\s+0+$", "m").test(status));
  }
  assert(/^NoNewPrivs:\s+1$/m.test(status));
  assert(/^Seccomp:\s+2$/m.test(status));
  assert(/^Uid:\s+65534\s+65534\s+65534\s+65534$/m.test(status));
  assert(/^Gid:\s+65534\s+65534\s+65534\s+65534$/m.test(status));
  assert(read("/proc/self/cgroup") === "0::/");
  for (const [name, expected] of Object.entries({
    "memory.max": "268435456",
    "memory.swap.max": "0",
    "cpu.max": "50000 100000",
    "pids.max": "32",
  }))
    assert(read("/sys/fs/cgroup/" + name) === expected);
  const mounts = read("/proc/self/mountinfo")
    .split("\n")
    .map((line) => {
      const [left, right] = line.split(" - ");
      const fields = left.split(" ");
      return {
        path: fields[4],
        flags: fields[5].split(","),
        fs: right.split(" ")[0],
        superFlags: right.split(" ")[2].split(","),
      };
    });
  const root = mounts.find((m) => m.path === "/");
  assert(!!root?.flags.includes("ro"));
  const temporary = mounts.find((m) => m.path === "/tmp");
  assert(
    temporary?.fs === "tmpfs" &&
      ["rw", "nosuid", "nodev", "noexec"].every((flag) =>
        temporary.flags.includes(flag),
      ),
  );
  const size = fs.statfsSync("/tmp");
  assert(size.bsize * size.blocks === 16777216);
  assert(
    mounts.some(
      (m) =>
        m.path === "/sys/fs/cgroup" &&
        m.fs === "cgroup2" &&
        m.flags.includes("ro"),
    ),
  );
  assert(mounts.some((m) => m.path === "/proc/1" && m.flags.includes("ro")));
  assert(mounts.some((m) => m.path === "/dev/shm" && m.flags.includes("ro")));
  assert(fs.readdirSync("/proc/1").length === 0);
  const interfaces = read("/proc/net/dev")
    .split("\n")
    .slice(2)
    .map((line) => line.split(":")[0].trim());
  for (const name of interfaces) {
    if (name !== "lo")
      assert((Number(read("/sys/class/net/" + name + "/flags")) & 1) === 0);
  }
  assert(read("/proc/net/route").split("\n").length === 1);
  const net = await import("node:net");
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: 9 });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("Internet socket allowed"));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "EPERM") resolve();
      else reject(error);
    });
  });
  for (const path of [
    "/proc/1/mem",
    "/dev/shm/sandbox-probe",
    "/sandbox-probe",
  ]) {
    let denied = false;
    try {
      const fd = fs.openSync(path, "w");
      fs.closeSync(fd);
    } catch {
      denied = true;
    }
    assert(denied);
  }
  // The pinned image is trusted. BusyBox timeout has different semantics.
  const version = cp.execFileSync("/usr/bin/timeout", ["--version"], {
    encoding: "utf8",
    timeout: 500,
    maxBuffer: 4096,
  });
  assert(version.startsWith("timeout (GNU coreutils) 9.1\n"));
  process.stdout.write("sandbox-isolation-v1\n");
}
export const SANDBOX_PROBE = `(${probe.toString()})().catch(() => process.exit(1))`;
