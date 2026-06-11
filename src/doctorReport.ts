import type { SelfDeploymentResult, SelfDeploymentStatus } from "./types.js";

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

  return lines.join("\n");
}
