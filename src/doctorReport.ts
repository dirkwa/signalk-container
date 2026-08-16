import type {
  HostPlatform,
  SelfDeploymentResult,
  SelfDeploymentStatus,
} from "./types.js";

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
  // `platform` is absent in payloads from older servers; a present value
  // must be null or a recognised platform token. Accepting an arbitrary
  // string would let `platformLabel` (exhaustive over HostPlatform) render
  // `undefined` in the report and modal.
  if (
    "platform" in value &&
    value.platform !== null &&
    value.platform !== "halos"
  ) {
    return false;
  }
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
  // `devicePassthrough` may be absent (older server) or null (no device
  // issues); a present object must carry the arrays the renderers walk —
  // and every element must be the shape they dereference: the report
  // formatter and DoctorModal read `issue.container/hostPath/action`
  // directly (no optional chaining) and `advice.join("\n")` coerces each
  // entry. A stray `null` issue or non-string advice line would crash the
  // render, so validate the elements, not just the arrays.
  if ("devicePassthrough" in value && value.devicePassthrough != null) {
    if (!isObj(value.devicePassthrough)) return false;
    const dp = value.devicePassthrough;
    if (!Array.isArray(dp.issues) || !dp.issues.every(isDeviceIssueEntry)) {
      return false;
    }
    if (!Array.isArray(dp.advice) || !dp.advice.every(isString)) return false;
  }
  return true;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Valid `action` values a device-passthrough issue may carry. */
const DEVICE_ISSUE_ACTIONS: ReadonlySet<string> = new Set([
  "skipped",
  "optimistic",
  "unresolved",
  "group-skipped",
]);

/**
 * Element validator for `devicePassthrough.issues`. Requires the fields
 * the renderers read (`container`, `hostPath`, `action`) plus the
 * remaining declared string fields; `action` must be one of the known
 * dispositions the UI keys `missing` off.
 */
function isDeviceIssueEntry(value: unknown): boolean {
  if (!isObj(value)) return false;
  return (
    isString(value.container) &&
    isString(value.entry) &&
    isString(value.hostPath) &&
    isString(value.reason) &&
    typeof value.action === "string" &&
    DEVICE_ISSUE_ACTIONS.has(value.action)
  );
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

/** Human label for a recognised host platform. */
export function platformLabel(platform: HostPlatform): string {
  switch (platform) {
    case "halos":
      return "HaLOS";
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
  if (r.platform) lines.push(`platform: ${platformLabel(r.platform)}`);
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

  if (r.networkDns) {
    const d = r.networkDns;
    lines.push(
      `network DNS helper (${or(d.backend)}): ${d.dnsBroken ? "MISSING — user-defined-network DNS is broken" : or(d.helperPath)}`,
    );
  }

  if (r.devicePassthrough) {
    for (const issue of r.devicePassthrough.issues) {
      // group-skipped concerns a supplementary group (empty hostPath), so
      // print the group name from `entry` instead of the blank path.
      lines.push(
        issue.action === "group-skipped"
          ? `group passthrough (${issue.container}): ${issue.entry} ${issue.action}`
          : `device passthrough (${issue.container}): ${issue.hostPath} ${issue.action}`,
      );
    }
  }

  const envEntries = Object.entries(r.env).filter(([, v]) => v != null);
  if (envEntries.length > 0) {
    lines.push("");
    lines.push("env:");
    for (const [k, v] of envEntries) lines.push(`  ${k}=${v}`);
  }

  // "No action needed" would contradict a non-empty advisory block below
  // (storage/linger/network-DNS advice can be actionable while status
  // stays ok), so it only renders when there is truly nothing to do.
  const hasAdvisoryAdvice =
    (r.containerStorage?.advice.length ?? 0) > 0 ||
    (r.linger?.advice.length ?? 0) > 0 ||
    (r.networkDns?.advice.length ?? 0) > 0 ||
    (r.devicePassthrough?.advice.length ?? 0) > 0;
  if (r.remediation.length > 0) {
    lines.push("");
    lines.push("Remediation:");
    for (const line of r.remediation) lines.push(line);
  } else if (!hasAdvisoryAdvice) {
    lines.push("");
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

  if (r.networkDns && r.networkDns.advice.length > 0) {
    lines.push("");
    lines.push("Network DNS advice:");
    for (const line of r.networkDns.advice) lines.push(line);
  }

  if (r.devicePassthrough && r.devicePassthrough.advice.length > 0) {
    lines.push("");
    lines.push("Device passthrough advice:");
    for (const line of r.devicePassthrough.advice) lines.push(line);
  }

  return lines.join("\n");
}
