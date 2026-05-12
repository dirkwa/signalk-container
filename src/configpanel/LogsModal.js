import React, { useState, useEffect, useRef, useCallback } from "react";

/**
 * Modal that streams a managed container's stdout/stderr log
 * (combined) via SSE from `/plugins/signalk-container/api/containers/<name>/logs/stream`,
 * after first painting an initial backfill from
 * `/plugins/signalk-container/api/containers/<name>/logs?tail=<n>`.
 *
 * Lifecycle:
 *   - Mount → fetch backfill → open EventSource.
 *   - Unmount (or `event: end`) → close EventSource; the broker's
 *     ref-count drops on the server side and it stops the tail
 *     when no other subscribers remain.
 *   - The user can toggle auto-scroll, copy the visible text, or
 *     download a `<name>-<ts>.log` file.  `name` is whatever the
 *     server returned for the container; today it's already
 *     `sk-`-prefixed because that's the convention but the modal
 *     doesn't depend on the prefix.
 *
 * Capped at MAX_LINES in memory so a chatty container left open
 * for hours doesn't pin a noticeable amount of DOM.
 */

const MAX_LINES = 10000;
const INITIAL_TAIL = 200;

const S = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  modal: {
    background: "#fff",
    borderRadius: 8,
    boxShadow: "0 10px 25px rgba(0,0,0,0.2)",
    width: "min(90vw, 1100px)",
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
  title: {
    fontSize: 16,
    fontWeight: 600,
    color: "#111",
    flex: 1,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    flexShrink: 0,
  },
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
  toolbarBtnActive: {
    background: "#3b82f6",
    color: "#fff",
    borderColor: "#3b82f6",
  },
  closeBtn: {
    padding: "5px 12px",
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
    background: "#1f2937",
    color: "#e5e7eb",
    fontFamily: '"SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
    fontSize: 12,
    lineHeight: 1.5,
    padding: "12px 16px",
    margin: 0,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  endBanner: {
    padding: "8px 16px",
    background: "#fef3c7",
    color: "#92400e",
    fontSize: 12,
    borderTop: "1px solid #fde68a",
  },
  metaLine: {
    fontSize: 11,
    color: "#6b7280",
  },
};

export default function LogsModal({ name, onClose }) {
  const [lines, setLines] = useState([]);
  // 'connecting' | 'backfill' | 'streaming' | 'disconnected'
  const [status, setStatus] = useState("connecting");
  const [endReason, setEndReason] = useState(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);

  const bodyRef = useRef(null);
  const esRef = useRef(null);
  const userScrolledUpRef = useRef(false);
  const modalRef = useRef(null);
  const closeBtnRef = useRef(null);
  const previouslyFocusedRef = useRef(null);

  // Append helper — caps the buffer so unbounded growth can't pin
  // the DOM.
  const append = useCallback((newLines) => {
    setLines((prev) => {
      const combined = prev.concat(newLines);
      if (combined.length > MAX_LINES) {
        return combined.slice(combined.length - MAX_LINES);
      }
      return combined;
    });
  }, []);

  // Backfill + open SSE on mount.
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        const res = await fetch(
          `/plugins/signalk-container/api/containers/${encodeURIComponent(name)}/logs?tail=${INITIAL_TAIL}`,
        );
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          append(Array.isArray(data.lines) ? data.lines : []);
        } else {
          append([`[error] backfill failed: HTTP ${res.status}`]);
        }
        setStatus("backfill");
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        append([`[error] backfill failed: ${msg}`]);
      }

      if (cancelled) return;
      const es = new EventSource(
        `/plugins/signalk-container/api/containers/${encodeURIComponent(name)}/logs/stream`,
      );
      esRef.current = es;

      es.addEventListener("hello", () => {
        if (cancelled) return;
        setStatus("streaming");
      });

      es.onmessage = (ev) => {
        if (cancelled) return;
        if (ev.data) append([ev.data]);
      };

      es.addEventListener("end", (ev) => {
        if (cancelled) return;
        setEndReason(ev.data || "stream ended");
        setStatus("disconnected");
        es.close();
      });

      es.onerror = () => {
        if (cancelled) return;
        // EventSource will auto-reconnect; surface as 'connecting'
        // so the dot turns amber instead of green. Only flip to
        // 'disconnected' when we explicitly receive the 'end' event.
        setStatus((s) => (s === "streaming" ? "connecting" : s));
      };
    };

    init();

    return () => {
      cancelled = true;
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [name, append]);

  // Auto-scroll: when lines grow and the user hasn't scrolled away,
  // pin to bottom.
  useEffect(() => {
    if (!autoScroll) return;
    if (userScrolledUpRef.current) return;
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, autoScroll]);

  // Detect manual scroll-up so we stop pinning. Reset when the user
  // toggles auto-scroll back on.
  const onBodyScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8; // ~one line
    userScrolledUpRef.current = !atBottom;
  }, []);

  const toggleAutoScroll = useCallback(() => {
    setAutoScroll((prev) => {
      const next = !prev;
      if (next) {
        // Re-pin to bottom immediately.
        userScrolledUpRef.current = false;
        const el = bodyRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }
      return next;
    });
  }, []);

  const doCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard API may be unavailable; ignore silently */
    }
  }, [lines]);

  const doDownload = useCallback(() => {
    const blob = new Blob([lines.join("\n") + "\n"], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    a.download = `${name}-${ts}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [lines, name]);

  // ESC to close.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Focus management: remember the element that had focus before
  // the modal opened, move focus to the Close button on mount,
  // restore focus on unmount.
  useEffect(() => {
    previouslyFocusedRef.current =
      typeof document !== "undefined" ? document.activeElement : null;
    // Defer to after paint so the button exists in the DOM.
    const t = setTimeout(() => {
      closeBtnRef.current?.focus();
    }, 0);
    return () => {
      clearTimeout(t);
      const prev = previouslyFocusedRef.current;
      if (prev && typeof prev.focus === "function") {
        try {
          prev.focus();
        } catch {
          /* element may have been removed */
        }
      }
    };
  }, []);

  // Focus trap: keep Tab cycling within the modal's focusable
  // elements so keyboard users can't tab out into the config panel
  // behind.  Listen on the modal container; let other keys bubble
  // (ESC is handled by the window listener above).
  const onModalKeyDown = useCallback((e) => {
    if (e.key !== "Tab") return;
    const root = modalRef.current;
    if (!root) return;
    // Visible, focusable elements only.  Buttons + the <pre> are
    // sufficient for this modal — no inputs or links.
    const focusable = Array.from(
      root.querySelectorAll(
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
    } else {
      if (active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, []);

  // Close on overlay click (but not when clicking inside the modal).
  const onOverlayClick = useCallback(
    (e) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const statusStyle = (() => {
    if (status === "streaming") return S.statusGreen;
    if (status === "disconnected") return S.statusRed;
    return S.statusAmber;
  })();

  const statusText = (() => {
    if (status === "connecting") return "Connecting…";
    if (status === "backfill") return "Backfilled — opening live stream…";
    if (status === "streaming") return "Live";
    return "Disconnected";
  })();

  return (
    <div
      style={S.overlay}
      onClick={onOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-label={`Logs for ${name}`}
    >
      <div style={S.modal} ref={modalRef} onKeyDown={onModalKeyDown}>
        <div style={S.header}>
          <span style={{ ...S.statusDot, ...statusStyle }} title={statusText} />
          <span style={S.title}>{name}</span>
          <span style={S.metaLine}>{statusText}</span>
          <span style={S.metaLine}>· {lines.length} lines</span>
          <button
            type="button"
            style={{
              ...S.toolbarBtn,
              ...(autoScroll ? S.toolbarBtnActive : {}),
            }}
            onClick={toggleAutoScroll}
            title="Auto-scroll to bottom on new lines"
          >
            Auto-scroll
          </button>
          <button
            type="button"
            style={S.toolbarBtn}
            onClick={doCopy}
            title="Copy visible log to clipboard"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
          <button
            type="button"
            style={S.toolbarBtn}
            onClick={doDownload}
            title="Download log as text file"
          >
            Download
          </button>
          <button
            type="button"
            style={S.closeBtn}
            onClick={onClose}
            ref={closeBtnRef}
          >
            Close
          </button>
        </div>
        <pre
          ref={bodyRef}
          style={S.body}
          onScroll={onBodyScroll}
          aria-label="Container log output"
        >
          {lines.length === 0 ? "(no log lines yet)" : lines.join("\n")}
        </pre>
        {endReason && <div style={S.endBanner}>Stream ended: {endReason}</div>}
      </div>
    </div>
  );
}
