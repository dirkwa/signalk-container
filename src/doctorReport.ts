import type { SelfDeploymentResult, SelfDeploymentStatus } from "./types.js";

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Boundary validator for the `/doctor/deployment` REST response. The
 * config-panel fetch trusts the server, but a stale plugin version or a
 * proxy returning an error page could deliver a different shape. Validate
 * the nested fields `formatDoctorReport`/`DoctorModal` dereference without
 * optional chaining (notably `env`'s entries and `cgroupControllers.missing`)
 * so a malformed payload shows an error instead of crashing the render.
 */
export function isSelfDeploymentResult(
  value: unknown,
): value is SelfDeploymentResult {
  if (!isObj(value)) return false;
  if (typeof value.status !== "string") return false;
  if (typeof value.isContainerized !== "boolean") return false;
  if (!Array.isArray(value.remediation)) return false;
  if (!isObj(value.binary)) return false;
  if (!isObj(value.daemon) || typeof value.daemon.reachable !== "boolean")
    return false;
  if (!isObj(value.selfId)) return false;
  if (!isObj(value.env)) return false;
  if (!isObj(value.cgroupControllers)) return false;
  const cg = value.cgroupControllers;
  if (!Array.isArray(cg.missing)) return false;
  if (cg.available !== null && !Array.isArray(cg.available)) return false;
  // `linger` may be absent entirely (payload from an older server) or
  // null (probe skipped); both render fine. A present object must have
  // the shape the renderers dereference without optional chaining.
  if ("linger" in value && value.linger != null) {
    if (!isObj(value.linger)) return false;
    const lg = value.linger;
    if (lg.user !== null && typeof lg.user !== "string") return false;
    if (typeof lg.enabled !== "boolean") return false;
    if (!Array.isArray(lg.advice)) return false;
  }
  return true;
}

/**
 * Short, single-line headline for a deployment-doctor status. Mirrors
 * `headlineForDoctorStatus` in src/index.ts (server-side) — both must list
 * all six statuses. Shared by the Doctor popup and the copy-able report.
 */
export function headlineForStatus(status: SelfDeploymentStatus): string {
  switch (status) {
    case "ok":
      return "Runtime ready";
    case "no-runtime":
      return "No container runtime found";
    case "socket-unreachable":
      return "Runtime socket unreachable";
    case "permission-denied":
      return "Runtime socket: permission denied";
    case "self-id-unresolved":
      return "Signal K container ID unresolved";
    case "cgroup-controllers-incomplete":
      return "Host cgroup controllers not fully delegated";
  }
}

function or(value: string | null | undefined, dash = "—"): string {
  return value == null || value === "" ? dash : value;
}

function yesNo(value: boolean | null | undefined): string {
  if (value == null) return "unknown";
  return value ? "yes" : "no";
}

/**
 * Render a `SelfDeploymentResult` as a plain-text report suitable for the
 * clipboard or a support thread. One labelled fact per line, then the
 * remediation block. No markup — copy-pasteable as-is.
 */
export function formatDoctorReport(r: SelfDeploymentResult): string {
  const lines: string[] = [];
  lines.push(`Deployment Doctor — ${headlineForStatus(r.status)}`);
  lines.push(`status: ${r.status}`);
  lines.push("");

  lines.push(`containerized: ${yesNo(r.isContainerized)}`);
  lines.push(
    `runtime: ${or(r.binary.name)} ${or(r.binary.version, "")}`.trimEnd(),
  );
  lines.push(`daemon reachable: ${yesNo(r.daemon.reachable)}`);
  lines.push(`rootless: ${yesNo(r.daemon.rootless)}`);
  lines.push(`socket: ${or(r.daemon.socketPath)}`);
  if (r.daemon.error) lines.push(`daemon error: ${r.daemon.error}`);

  if (r.isContainerized) {
    const src = r.selfId.source ? ` (via ${r.selfId.source})` : "";
    lines.push(`self container id: ${or(r.selfId.value)}${src}`);
  }

  const cg = r.cgroupControllers;
  lines.push(`cgroup controllers: ${or(cg.available?.join(" ") ?? null)}`);
  if (cg.missing.length > 0) {
    lines.push(`cgroup controllers MISSING: ${cg.missing.join(" ")}`);
  }
  if (cg.kernelDisabledMemory) {
    lines.push("kernel cmdline disables the memory controller");
  }

  if (r.containerStorage) {
    const s = r.containerStorage;
    const hazard = s.idmapHazard ? " (idmap hazard)" : "";
    lines.push(`storage: ${or(s.fstype)} at ${or(s.storagePath)}${hazard}`);
  }

  if (r.linger) {
    const who = r.linger.user ? ` for ${r.linger.user}` : "";
    lines.push(
      `systemd linger: ${r.linger.enabled ? "enabled" : "NOT enabled"}${who}`,
    );
  }

  const envEntries = Object.entries(r.env).filter(([, v]) => v != null);
  if (envEntries.length > 0) {
    lines.push("");
    lines.push("env:");
    for (const [k, v] of envEntries) lines.push(`  ${k}=${v}`);
  }

  lines.push("");
  if (r.remediation.length > 0) {
    lines.push("Remediation:");
    for (const line of r.remediation) lines.push(line);
  } else {
    lines.push("No action needed (status ok).");
  }

  if (r.containerStorage && r.containerStorage.advice.length > 0) {
    lines.push("");
    lines.push("Storage advice:");
    for (const line of r.containerStorage.advice) lines.push(line);
  }

  if (r.linger && r.linger.advice.length > 0) {
    lines.push("");
    lines.push("Linger advice:");
    for (const line of r.linger.advice) lines.push(line);
  }

  return lines.join("\n");
}
