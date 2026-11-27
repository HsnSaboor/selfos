/**
 * Scheme allowlist for URLs handed to the operating system.
 *
 * `shell.openExternal` dispatches any registered URI handler, so forwarding an
 * arbitrary URL is an escape primitive: a `file:` or `smb:` target reaches the
 * desktop. The URL can originate from browser-history page titles or note
 * bodies, so it is treated as untrusted input. `notes.open` applies the same
 * rule for `obsidian://` before calling `shell.openExternal`.
 *
 * Kept as a pure module (no Electron import) so it is unit-testable.
 */
export function isSafeExternalUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === "http:" || protocol === "https:" || protocol === "obsidian:";
  } catch {
    return false;
  }
}
