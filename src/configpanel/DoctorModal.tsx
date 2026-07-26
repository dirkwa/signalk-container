import React, {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { SelfDeploymentResult } from "../types";
import { copyTextToClipboard } from "../clipboard";
import {
  formatDoctorReport,
  headlineForStatus,
  isSelfDeploymentResult,
} from "../doctorReport";

interface DoctorModalProps {
  onClose: () => void;
}

const DOCTOR_URL = "/plugins/signalk-container/api/doctor/deployment";

const S: Record<string, CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 99999,
  },
  modal: {
    background: "#fff",
    borderRadius: 8,
    boxShadow: "0 10px 25px rgba(0,0,0,0.2)",
    width: "min(90vw, 760px)",
    maxHeight: "85vh",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  header: {
    padding: "12px 16px",
    borderBottom: "1px solid #e5e7eb",
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  title: { fontSize: 16, fontWeight: 600, color: "#111", flex: 1 },
  statusDot: { width: 10, height: 10, borderRadius: "50%", flexShrink: 0 },
  statusGreen: { background: "#10b981" },
  statusAmber: { background: "#f59e0b" },
  statusRed: { background: "#ef4444" },
  toolbarBtn: {
    padding: "5px 10px",
    fontSize: 12,
    background: "#fff",
    color: "#374151",
    border: "1px solid #d1d5db",
    borderRadius: 4,
    cursor: "pointer",
  },
  body: {
    flex: 1,
    overflow: "auto",
    padding: "16px",
    color: "#111",
    fontSize: 13,
  },
  headline: { fontSize: 15, fontWeight: 600, marginBottom: 12 },
  row: {
    display: "flex",
    gap: 12,
    padding: "4px 0",
    borderBottom: "1px solid #f3f4f6",
  },
  rowLabel: { width: 150, flexShrink: 0, color: "#6b7280" },
  rowValue: { color: "#111", wordBreak: "break-word" },
  rowValueMissing: { color: "#b45309", fontWeight: 600 },
  dim: { color: "#9ca3af" },
  sectionLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: "#374151",
    marginTop: 16,
    marginBottom: 6,
  },
  pre: {
    background: "#1f2937",
    color: "#e5e7eb",
    fontFamily: '"SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
    fontSize: 12,
    lineHeight: 1.5,
    padding: "12px",
    margin: 0,
    borderRadius: 6,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  toggle: {
    marginTop: 16,
    fontSize: 12,
    background: "none",
    border: "none",
    color: "#3b82f6",
    cursor: "pointer",
    padding: 0,
  },
  message: { color: "#6b7280", padding: "8px 0" },
  error: { color: "#ef4444", padding: "8px 0" },
};

function statusStyle(status: SelfDeploymentResult["status"]): CSSProperties {
  if (status === "ok") return S.statusGreen;
  if (
    status === "self-id-unresolved" ||
    status === "cgroup-controllers-incomplete"
  )
    return S.statusAmber;
  return S.statusRed;
}

function Row({
  label,
  value,
  missing,
}: {
  label: string;
  value: React.ReactNode;
  missing?: boolean;
}) {
  return (
    <div style={S.row}>
      <span style={S.rowLabel}>{label}</span>
      <span style={{ ...S.rowValue, ...(missing ? S.rowValueMissing : {}) }}>
        {value}
      </span>
    </div>
  );
}

function dash(value: string | null | undefined): React.ReactNode {
  if (value == null || value === "") return <span style={S.dim}>—</span>;
  return value;
}

export default function DoctorModal({ onClose }: DoctorModalProps) {
  const [result, setResult] = useState<SelfDeploymentResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);

  const modalRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocusedRef = useRef<Element | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(DOCTOR_URL);
        if (cancelled) return;
        if (!res.ok) {
          setError(
            res.status === 401 || res.status === 403
              ? `HTTP ${res.status} — not authorized. Are you logged in to the admin UI?`
              : `HTTP ${res.status} fetching the deployment doctor.`,
          );
          setLoading(false);
          return;
        }
        const data: unknown = await res.json();
        if (cancelled) return;
        if (!isSelfDeploymentResult(data)) {
          setError("Unexpected response shape from the deployment doctor.");
          setLoading(false);
          return;
        }
        setResult(data);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(
          e instanceof Error ? e.message : "Failed to reach the server.",
        );
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ESC to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Focus the Close button on mount, restore focus on unmount.
  useEffect(() => {
    previouslyFocusedRef.current =
      typeof document !== "undefined" ? document.activeElement : null;
    const t = setTimeout(() => closeBtnRef.current?.focus(), 0);
    return () => {
      clearTimeout(t);
      const prev = previouslyFocusedRef.current;
      if (prev instanceof HTMLElement) {
        try {
          prev.focus();
        } catch {
          /* element may have been removed */
        }
      }
    };
  }, []);

  const onModalKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "Tab") return;
      const root = modalRef.current;
      if (!root) return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [],
  );

  const onOverlayClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const doCopy = useCallback(async () => {
    if (!result) return;
    if (await copyTextToClipboard(formatDoctorReport(result))) setCopied(true);
  }, [result]);

  // Reset the "Copied!" label, clearing the timer on unmount so we never
  // set state on an unmounted component.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const cg = result?.cgroupControllers;

  return (
    <div
      style={S.overlay}
      onClick={onOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-label="Deployment Doctor"
    >
      <div style={S.modal} ref={modalRef} onKeyDown={onModalKeyDown}>
        <div style={S.header}>
          {result && (
            <span style={{ ...S.statusDot, ...statusStyle(result.status) }} />
          )}
          <span style={S.title}>Deployment Doctor</span>
          {result && (
            <button
              type="button"
              style={S.toolbarBtn}
              onClick={doCopy}
              title="Copy the full report to the clipboard"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          )}
          <button
            type="button"
            ref={closeBtnRef}
            style={S.toolbarBtn}
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <div style={S.body}>
          {loading && <div style={S.message}>Running diagnostics…</div>}
          {error && <div style={S.error}>{error}</div>}
          {result && (
            <>
              <div style={S.headline}>{headlineForStatus(result.status)}</div>

              <Row
                label="Containerized"
                value={result.isContainerized ? "yes" : "no"}
              />
              <Row
                label="Runtime"
                value={
                  result.binary.name
                    ? `${result.binary.name} ${result.binary.version ?? ""}`.trim()
                    : dash(null)
                }
              />
              <Row
                label="Daemon reachable"
                value={result.daemon.reachable ? "yes" : "no"}
              />
              <Row
                label="Rootless"
                value={
                  result.daemon.rootless == null
                    ? "unknown"
                    : result.daemon.rootless
                      ? "yes"
                      : "no"
                }
              />
              <Row label="Socket" value={dash(result.daemon.socketPath)} />
              {result.daemon.error && (
                <Row label="Daemon error" value={result.daemon.error} missing />
              )}

              {result.isContainerized && (
                <Row
                  label="Self container ID"
                  value={
                    result.selfId.value
                      ? `${result.selfId.value}${result.selfId.source ? ` (via ${result.selfId.source})` : ""}`
                      : dash(null)
                  }
                  missing={!result.selfId.value}
                />
              )}

              <Row
                label="cgroup controllers"
                value={dash(cg?.available?.join(" ") ?? null)}
              />
              {cg && cg.missing.length > 0 && (
                <Row
                  label="cgroup MISSING"
                  value={cg.missing.join(" ")}
                  missing
                />
              )}
              {cg?.kernelDisabledMemory && (
                <Row
                  label="Kernel cmdline"
                  value="disables the memory controller"
                  missing
                />
              )}

              {result.containerStorage && (
                <Row
                  label="Storage"
                  value={`${result.containerStorage.fstype ?? "?"} at ${result.containerStorage.storagePath ?? "?"}${result.containerStorage.idmapHazard ? " (idmap hazard)" : ""}`}
                  missing={result.containerStorage.idmapHazard}
                />
              )}

              {result.linger && (
                <Row
                  label="systemd linger"
                  value={`${result.linger.enabled ? "enabled" : "NOT enabled"}${result.linger.user ? ` for ${result.linger.user}` : ""}`}
                  missing={!result.linger.enabled}
                />
              )}

              {result.devicePassthrough &&
                result.devicePassthrough.issues.map((issue) =>
                  issue.action === "group-skipped" ? (
                    <Row
                      key={`${issue.container}:group:${issue.entry}`}
                      label={`Group (${issue.container})`}
                      value={`${issue.entry} ${issue.action}`}
                      missing={true}
                    />
                  ) : (
                    <Row
                      key={`${issue.container}:${issue.hostPath}:${issue.entry}:${issue.action}`}
                      label={`Device (${issue.container})`}
                      value={`${issue.hostPath} ${issue.action}`}
                      missing={issue.action !== "optimistic"}
                    />
                  ),
                )}

              <div style={S.sectionLabel}>Remediation</div>
              {result.remediation.length > 0 ? (
                <pre style={S.pre}>{result.remediation.join("\n")}</pre>
              ) : (
                // "No action needed" would contradict a non-empty advisory
                // block (storage/linger/network-DNS/device advice can be
                // actionable while status stays ok). Mirror the identical
                // hasAdvisoryAdvice guard in formatDoctorReport exactly —
                // including networkDns, or the modal claims "No action needed"
                // for a payload the copyable report flags as actionable.
                !(
                  (result.containerStorage?.advice.length ?? 0) > 0 ||
                  (result.linger?.advice.length ?? 0) > 0 ||
                  (result.networkDns?.advice.length ?? 0) > 0 ||
                  (result.devicePassthrough?.advice.length ?? 0) > 0
                ) && <div style={S.message}>No action needed (status ok).</div>
              )}

              {result.containerStorage &&
                result.containerStorage.advice.length > 0 && (
                  <>
                    <div style={S.sectionLabel}>Storage advice</div>
                    <pre style={S.pre}>
                      {result.containerStorage.advice.join("\n")}
                    </pre>
                  </>
                )}

              {result.linger && result.linger.advice.length > 0 && (
                <>
                  <div style={S.sectionLabel}>Linger advice</div>
                  <pre style={S.pre}>{result.linger.advice.join("\n")}</pre>
                </>
              )}

              {result.networkDns && result.networkDns.advice.length > 0 && (
                <>
                  <div style={S.sectionLabel}>Network DNS advice</div>
                  <pre style={S.pre}>{result.networkDns.advice.join("\n")}</pre>
                </>
              )}

              {result.devicePassthrough &&
                result.devicePassthrough.advice.length > 0 && (
                  <>
                    <div style={S.sectionLabel}>Device passthrough advice</div>
                    <pre style={S.pre}>
                      {result.devicePassthrough.advice.join("\n")}
                    </pre>
                  </>
                )}

              <button
                type="button"
                style={S.toggle}
                onClick={() => setShowRaw((v) => !v)}
              >
                {showRaw ? "▾ Hide raw JSON" : "▸ Show raw JSON"}
              </button>
              {showRaw && (
                <pre style={{ ...S.pre, marginTop: 8 }}>
                  {JSON.stringify(result, null, 2)}
                </pre>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
