import React, { useState, useEffect, useCallback } from "react";

const S = {
  root: {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: "#333",
    padding: "16px 0",
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    marginBottom: 10,
    marginTop: 24,
  },
  btn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 16px",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  btnPrimary: { background: "#3b82f6", color: "#fff" },
  btnDanger: {
    background: "#ef4444",
    color: "#fff",
    padding: "6px 12px",
    fontSize: 12,
  },
  btnWarning: {
    background: "#f59e0b",
    color: "#fff",
    padding: "6px 12px",
    fontSize: 12,
  },
  btnSave: { background: "#3b82f6", color: "#fff" },
  btnSuccess: { background: "#10b981", color: "#fff" },
  btnDisabled: { opacity: 0.5, cursor: "not-allowed" },
  status: { marginTop: 8, fontSize: 12, minHeight: 18 },
  runtimeCard: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    padding: "14px 18px",
    background: "#f8f9fa",
    border: "1px solid #e0e0e0",
    borderRadius: 10,
    marginBottom: 12,
  },
  runtimeIcon: {
    width: 44,
    height: 44,
    borderRadius: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 22,
    flexShrink: 0,
  },
  runtimeInfo: { flex: 1 },
  runtimeName: { fontSize: 15, fontWeight: 600, color: "#333" },
  runtimeVersion: { fontSize: 12, color: "#888" },
  containerItem: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 14px",
    background: "#f8f9fa",
    border: "1px solid #e0e0e0",
    borderRadius: 10,
    marginBottom: 8,
  },
  stateIndicator: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    flexShrink: 0,
  },
  containerInfo: { flex: 1, minWidth: 0 },
  containerName: { fontSize: 14, fontWeight: 600, color: "#333" },
  containerMeta: {
    fontSize: 11,
    color: "#888",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  containerActions: {
    display: "flex",
    gap: 6,
    flexShrink: 0,
  },
  empty: {
    textAlign: "center",
    padding: "30px 16px",
    color: "#999",
    fontSize: 13,
  },
  fieldRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginBottom: 10,
  },
  label: {
    fontSize: 13,
    fontWeight: 500,
    color: "#555",
    width: 160,
    flexShrink: 0,
  },
  select: {
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid #ccc",
    fontSize: 13,
    background: "#fff",
    color: "#333",
  },
  hint: { fontSize: 11, color: "#aaa", marginLeft: 8 },
  pruneResult: {
    fontSize: 12,
    color: "#10b981",
    marginTop: 6,
  },
};

const stateColors = {
  running: "#10b981",
  stopped: "#f59e0b",
  missing: "#94a3b8",
  "no-runtime": "#ef4444",
};

const stateLabels = {
  running: "Running",
  stopped: "Stopped",
  missing: "Not created",
  "no-runtime": "No runtime",
};

function SelectField({ label, value, options, onChange, hint }) {
  return (
    <div style={S.fieldRow}>
      <span style={S.label}>{label}</span>
      <select
        style={S.select}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <span style={S.hint}>{hint}</span>}
    </div>
  );
}

export default function PluginConfigurationPanel({ configuration, save }) {
  const cfg = configuration || {};
  const [runtime, setRuntime] = useState(cfg.runtime || "auto");
  const [pruneSchedule, setPruneSchedule] = useState(
    cfg.pruneSchedule || "weekly"
  );
  const [runtimeInfo, setRuntimeInfo] = useState(null);
  const [containers, setContainers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionStatus, setActionStatus] = useState("");
  const [statusError, setStatusError] = useState(false);
  const [pruneResult, setPruneResult] = useState(null);

  const fetchStatus = useCallback(async () => {
    try {
      const [rtRes, ctRes] = await Promise.all([
        fetch("/plugins/signalk-container/api/runtime"),
        fetch("/plugins/signalk-container/api/containers"),
      ]);

      if (rtRes.ok) {
        setRuntimeInfo(await rtRes.json());
      } else {
        setRuntimeInfo(null);
      }

      if (ctRes.ok) {
        setContainers(await ctRes.json());
      } else {
        setContainers([]);
      }
    } catch {
      setRuntimeInfo(null);
      setContainers([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const doSave = () => {
    save({ runtime, pruneSchedule, maxConcurrentJobs: cfg.maxConcurrentJobs || 2 });
    setActionStatus("Saved! Plugin will restart.");
    setStatusError(false);
  };

  const stopContainer = async (name) => {
    setActionStatus(`Stopping ${name}...`);
    setStatusError(false);
    try {
      const res = await fetch(
        `/plugins/signalk-container/api/containers/${encodeURIComponent(name)}/stop`,
        { method: "POST" }
      );
      if (res.ok) {
        setActionStatus(`${name} stopped.`);
        fetchStatus();
      } else {
        const data = await res.json();
        setActionStatus(`Failed: ${data.error}`);
        setStatusError(true);
      }
    } catch (e) {
      setActionStatus(`Error: ${e.message}`);
      setStatusError(true);
    }
  };

  const removeContainer = async (name) => {
    setActionStatus(`Removing ${name}...`);
    setStatusError(false);
    try {
      const res = await fetch(
        `/plugins/signalk-container/api/containers/${encodeURIComponent(name)}/remove`,
        { method: "POST" }
      );
      if (res.ok) {
        setActionStatus(`${name} removed.`);
        fetchStatus();
      } else {
        const data = await res.json();
        setActionStatus(`Failed: ${data.error}`);
        setStatusError(true);
      }
    } catch (e) {
      setActionStatus(`Error: ${e.message}`);
      setStatusError(true);
    }
  };

  const doPrune = async () => {
    setActionStatus("Pruning dangling images...");
    setStatusError(false);
    setPruneResult(null);
    try {
      const res = await fetch("/plugins/signalk-container/api/prune", {
        method: "POST",
      });
      if (res.ok) {
        const data = await res.json();
        setPruneResult(data);
        setActionStatus(
          `Pruned ${data.imagesRemoved} image(s), reclaimed ${data.spaceReclaimed}.`
        );
      } else {
        const data = await res.json();
        setActionStatus(`Prune failed: ${data.error}`);
        setStatusError(true);
      }
    } catch (e) {
      setActionStatus(`Error: ${e.message}`);
      setStatusError(true);
    }
  };

  return (
    <div style={S.root}>
      <div style={S.sectionTitle}>Runtime</div>

      {loading ? (
        <div style={S.empty}>Detecting container runtime...</div>
      ) : runtimeInfo ? (
        <div style={S.runtimeCard}>
          <div
            style={{
              ...S.runtimeIcon,
              background:
                runtimeInfo.runtime === "podman" ? "#892ca0" : "#2496ed",
              color: "#fff",
            }}
          >
            {runtimeInfo.runtime === "podman" ? "P" : "D"}
          </div>
          <div style={S.runtimeInfo}>
            <div style={S.runtimeName}>
              {runtimeInfo.runtime.charAt(0).toUpperCase() +
                runtimeInfo.runtime.slice(1)}
              {runtimeInfo.isPodmanDockerShim ? " (via docker shim)" : ""}
            </div>
            <div style={S.runtimeVersion}>
              Version {runtimeInfo.version}
            </div>
          </div>
          <div
            style={{
              ...S.stateIndicator,
              background: "#10b981",
            }}
            title="Runtime available"
          />
        </div>
      ) : (
        <div style={S.runtimeCard}>
          <div
            style={{ ...S.runtimeIcon, background: "#fef2f2", color: "#ef4444" }}
          >
            !
          </div>
          <div style={S.runtimeInfo}>
            <div style={S.runtimeName}>No container runtime found</div>
            <div style={S.runtimeVersion}>
              Install Podman: sudo apt install podman
            </div>
          </div>
        </div>
      )}

      <div style={S.sectionTitle}>Settings</div>

      <SelectField
        label="Preferred runtime"
        value={runtime}
        onChange={setRuntime}
        options={[
          { value: "auto", label: "Auto-detect (Podman preferred)" },
          { value: "podman", label: "Podman" },
          { value: "docker", label: "Docker" },
        ]}
      />

      <SelectField
        label="Auto-prune images"
        value={pruneSchedule}
        onChange={setPruneSchedule}
        options={[
          { value: "off", label: "Off" },
          { value: "weekly", label: "Weekly" },
          { value: "monthly", label: "Monthly" },
        ]}
      />

      <div style={S.sectionTitle}>Managed Containers</div>

      {containers.length === 0 ? (
        <div style={S.empty}>
          {loading
            ? "Loading..."
            : "No managed containers. Other plugins will create them."}
        </div>
      ) : (
        containers.map((ct) => (
          <div key={ct.name} style={S.containerItem}>
            <div
              style={{
                ...S.stateIndicator,
                background: stateColors[ct.state] || "#94a3b8",
              }}
              title={stateLabels[ct.state] || ct.state}
            />
            <div style={S.containerInfo}>
              <div style={S.containerName}>{ct.name}</div>
              <div style={S.containerMeta}>
                {ct.image} &middot; {stateLabels[ct.state] || ct.state}
                {ct.ports && ct.ports.length > 0 && ct.ports[0]
                  ? ` · ${ct.ports.join(", ")}`
                  : ""}
              </div>
            </div>
            <div style={S.containerActions}>
              {ct.state === "running" && (
                <button
                  style={{ ...S.btn, ...S.btnWarning }}
                  onClick={() => stopContainer(ct.name)}
                >
                  Stop
                </button>
              )}
              <button
                style={{ ...S.btn, ...S.btnDanger }}
                onClick={() => removeContainer(ct.name)}
              >
                Remove
              </button>
            </div>
          </div>
        ))
      )}

      <div style={S.sectionTitle}>Maintenance</div>

      <button style={{ ...S.btn, ...S.btnSuccess }} onClick={doPrune}>
        Prune Dangling Images
      </button>

      {actionStatus && (
        <div
          style={{
            ...S.status,
            color: statusError ? "#ef4444" : "#10b981",
          }}
        >
          {actionStatus}
        </div>
      )}

      <div style={{ ...S.sectionTitle, marginTop: 28 }}>&nbsp;</div>
      <button style={{ ...S.btn, ...S.btnSave }} onClick={doSave}>
        Save Configuration
      </button>
    </div>
  );
}
