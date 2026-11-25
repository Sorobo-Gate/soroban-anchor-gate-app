/**
 * Copies text to the clipboard using modern Navigator Clipboard API,
 * with graceful fallback to document.execCommand('copy') for legacy or unsupported browsers.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof window === "undefined") {
    return false;
  }

  if (!text) {
    return false;
  }

  // 1. Modern Navigator Clipboard API
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to legacy fallback if writeText fails (e.g. security permissions)
    }
  }

  // 2. Legacy fallback for browsers without modern Clipboard API
  try {
    const document = window.document;
    if (!document || typeof document.createElement !== "function") {
      return false;
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "-9999px";
    textarea.style.opacity = "0";

    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    let success = false;
    if (typeof document.execCommand === "function") {
      success = document.execCommand("copy");
    }

    document.body.removeChild(textarea);
    return success;
  } catch {
    return false;
  }
}
