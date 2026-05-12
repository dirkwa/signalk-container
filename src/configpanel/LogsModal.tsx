import React, {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  UIEvent as ReactUIEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

interface LogsModalProps {
  /** Container name as it appears in the `/api/containers` listing
   *  (already `sk-`-prefixed by convention; the modal does not
   *  add/strip the prefix). */
  name: string;
  /** Called when the user dismisses the modal (close button, ESC,
   *  or overlay click). */
  onClose: () => void;
}

type ConnectionStatus =
  | "connecting"
  | "backfill"
  | "streaming"
  | "disconnected";

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
 *     download a `<name>-<ts>.log` file.  `name` is the prop passed
 *     in by the parent panel — the container name as it appears in
 *     the `/api/containers` listing.  The modal never adds or strips
 *     the `sk-` prefix itself; whatever it receives is used as-is in
 *     the URL paths and in the download filename.
 *
 * Capped at MAX_LINES in memory so a chatty container left open
 * for hours doesn't pin a noticeable amount of DOM.
 */

const MAX_LINES = 10000;
const INITIAL_TAIL = 200;

const S: Record<string, CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    // SK admin UI's left sidebar uses a high z-index for its docked
    // panel.  1000 wasn't enough — the sidebar bled through the
    // overlay.  Stay below the max int but well above anything
    // Bootstrap/MUI/Ant ever ship.
    zIndex: 99999,
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

export default function LogsModal({ name, onClose }: LogsModalProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [endReason, setEndReason] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);

  const bodyRef = useRef<HTMLPreElement | null>(null);
  // Sentinel at the end of the log buffer.  `scrollIntoView` on
  // this element is the standard React chat-window pattern for
  // reliable auto-scroll — it survives text-content replacement,
  // works even when content arrives faster than React effects can
  // run, and doesn't depend on us reading `scrollHeight` at the
  // right moment.
  const endSentinelRef = useRef<HTMLDivElement | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const userScrolledUpRef = useRef(false);
  // True only for the brief window after our auto-scroll effect
  // wrote `el.scrollTop` / called `scrollIntoView`.  Lets the
  // `onScroll` handler ignore the resulting synthetic scroll event
  // so it doesn't misclassify our own pin-to-bottom as a manual
  // user scroll-up.
  const programmaticScrollRef = useRef(false);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocusedRef = useRef<Element | null>(null);

  // Append helper — caps the buffer so unbounded growth can't pin
  // the DOM.
  const append = useCallback((newLines: string[]) => {
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
      let backfillFatal = false;
      try {
        const res = await fetch(
          `/plugins/signalk-container/api/containers/${encodeURIComponent(name)}/logs?tail=${INITIAL_TAIL}`,
        );
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          append(Array.isArray(data.lines) ? data.lines : []);
          setStatus("backfill");
        } else if (res.status === 404) {
          // Container doesn't exist — the SSE endpoint would also
          // 404, and EventSource auto-retries on initial errors
          // forever.  Surface the failure and stop here.
          append([`[error] container not found (HTTP 404)`]);
          setEndReason("container not found");
          setStatus("disconnected");
          backfillFatal = true;
        } else {
          append([`[error] backfill failed: HTTP ${res.status}`]);
          setStatus("backfill");
        }
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        append([`[error] backfill failed: ${msg}`]);
      }

      if (cancelled || backfillFatal) return;
      const es = new EventSource(
        `/plugins/signalk-container/api/containers/${encodeURIComponent(name)}/logs/stream`,
      );
      esRef.current = es;

      es.addEventListener("hello", () => {
        if (cancelled) return;
        setStatus("streaming");
      });

      es.onmessage = (ev: MessageEvent<string>) => {
        if (cancelled) return;
        // Preserve empty lines — the container really did print
        // `\n`, and the modal should mirror what `podman logs` shows.
        if (ev.data != null) append([ev.data]);
      };

      es.addEventListener("end", (ev) => {
        if (cancelled) return;
        // Custom SSE event types come through as plain `Event`; the
        // `data` field is present on the underlying MessageEvent.
        const data = (ev as MessageEvent<string>).data;
        setEndReason(data || "stream ended");
        setStatus("disconnected");
        es.close();
      });

      es.onerror = () => {
        if (cancelled) return;
        // EventSource will auto-reconnect; surface as 'connecting'
        // so the dot turns amber instead of green.  Cover both the
        // mid-stream drop ('streaming' → 'connecting') and the
        // initial-failure case where the stream never reached
        // 'streaming' after backfill — otherwise the banner would
        // stay on "Backfilled — opening live stream…" forever while
        // the browser silently retries.  Only 'disconnected' is
        // sticky (set when we receive an explicit 'end' event).
        setStatus((s) => (s === "disconnected" ? s : "connecting"));
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
  // pin to bottom.  `useLayoutEffect` runs synchronously after the
  // DOM is updated but BEFORE the browser paints — so the user
  // never sees the brief "scroll-top reset → re-pin" flash a plain
  // `useEffect` could produce when React replaces the `<pre>`'s
  // text content.
  //
  // Scroll the sentinel into view rather than poking
  // `el.scrollTop` directly — the latter depends on the browser
  // having committed the new content's height to `scrollHeight` at
  // the exact moment we read it, which can race with React's text-
  // node replacement on the `<pre>`.  `scrollIntoView` on a
  // post-content sentinel is layout-agnostic.
  useLayoutEffect(() => {
    if (!autoScroll) return;
    if (userScrolledUpRef.current) return;
    const sentinel = endSentinelRef.current;
    if (!sentinel) return;
    programmaticScrollRef.current = true;
    sentinel.scrollIntoView({ block: "end", inline: "nearest" });
    // Fail-safe: if scrollIntoView is a no-op (the sentinel was
    // already in view) no scroll event fires, and the flag would
    // otherwise stay set until the user's first manual scroll —
    // which would then get ignored.  Clear on the next frame so
    // the flag's "consume one scroll event" window doesn't outlive
    // a single render.
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, [lines, autoScroll]);

  // Detect manual scroll-up so we stop pinning. Reset when the user
  // toggles auto-scroll back on.
  const onBodyScroll = useCallback((_e: ReactUIEvent<HTMLPreElement>) => {
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false;
      return;
    }
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8; // ~one line
    userScrolledUpRef.current = !atBottom;
  }, []);

  const toggleAutoScroll = useCallback(() => {
    setAutoScroll((prev) => {
      const next = !prev;
      if (next) {
        // Re-pin to bottom immediately via the sentinel.
        userScrolledUpRef.current = false;
        const sentinel = endSentinelRef.current;
        if (sentinel) {
          programmaticScrollRef.current = true;
          sentinel.scrollIntoView({ block: "end", inline: "nearest" });
          // Same fail-safe as the layout effect — clear the flag
          // on the next frame in case scrollIntoView was a no-op.
          requestAnimationFrame(() => {
            programmaticScrollRef.current = false;
          });
        }
      }
      return next;
    });
  }, []);

  const doCopy = useCallback(async () => {
    const text = lines.join("\n");
    // Prefer the modern async Clipboard API.  It only works in a
    // secure context (HTTPS / localhost) — Signal K servers are
    // commonly served over plain HTTP on a LAN, where
    // `navigator.clipboard` is undefined.  Fall back to the legacy
    // `execCommand("copy")` trick (deprecated but still universally
    // supported) so the button does something useful instead of
    // silently failing.
    const tryAsync = async (): Promise<boolean> => {
      if (typeof navigator === "undefined" || !navigator.clipboard)
        return false;
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    };
    const tryLegacy = (): boolean => {
      if (typeof document === "undefined") return false;
      const ta = document.createElement("textarea");
      ta.value = text;
      // Keep it off-screen + unfocused so the page doesn't visibly jump.
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.left = "-1000px";
      ta.setAttribute("readonly", "");
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      document.body.removeChild(ta);
      return ok;
    };
    const ok = (await tryAsync()) || tryLegacy();
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
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
    const onKey = (e: KeyboardEvent) => {
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
      if (prev instanceof HTMLElement) {
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
  const onModalKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "Tab") return;
      const root = modalRef.current;
      if (!root) return;
      // Visible, focusable elements only.  Buttons + the <pre> are
      // sufficient for this modal — no inputs or links.
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
      } else {
        if (active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [],
  );

  // Close on overlay click (but not when clicking inside the modal).
  const onOverlayClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
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
          tabIndex={0}
        >
          {lines.length === 0 ? "(no log lines yet)" : lines.join("\n")}
          {/* Sentinel for auto-scroll-to-bottom — see the
              useLayoutEffect above.  `aria-hidden` because it's a
              layout-only element with no semantic meaning to
              screen readers. */}
          <div ref={endSentinelRef} aria-hidden="true" />
        </pre>
        {endReason && <div style={S.endBanner}>Stream ended: {endReason}</div>}
      </div>
    </div>
  );
}
