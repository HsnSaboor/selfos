import { describe, expect, it } from "vitest";
import { isSafeExternalUrl } from "../src/main/external-url";

/**
 * `shell.openExternal` dispatches any registered URI handler, so the window-open
 * path must not forward arbitrary schemes. These cases pin the allowlist.
 */
describe("isSafeExternalUrl", () => {
  it("allows web links", () => {
    expect(isSafeExternalUrl("https://example.com/a?b=1")).toBe(true);
    expect(isSafeExternalUrl("http://localhost:5173")).toBe(true);
  });

  it("allows obsidian URIs, matching notes.open", () => {
    expect(isSafeExternalUrl("obsidian://open?vault=Notes&file=Seerah")).toBe(true);
  });

  it("refuses local files and OS handlers", () => {
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeExternalUrl("smb://host/share")).toBe(false);
    expect(isSafeExternalUrl("steam://run/123")).toBe(false);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
  });

  it("refuses unparseable input", () => {
    expect(isSafeExternalUrl("")).toBe(false);
    expect(isSafeExternalUrl("not a url")).toBe(false);
  });
});
