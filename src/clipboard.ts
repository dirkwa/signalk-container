/**
 * Copy `text` to the clipboard, returning whether it succeeded.
 *
 * Prefers the modern async Clipboard API. It only works in a secure
 * context (HTTPS / localhost) — Signal K servers are commonly served over
 * plain HTTP on a LAN, where `navigator.clipboard` is undefined. Falls back
 * to the legacy `execCommand("copy")` trick (deprecated but still
 * universally supported) so the button does something useful instead of
 * silently failing on older browsers or non-SSL deployments.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  const tryAsync = async (): Promise<boolean> => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return false;
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
    let ok: boolean;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  };
  return (await tryAsync()) || tryLegacy();
}
