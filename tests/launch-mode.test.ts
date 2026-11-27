import { describe, expect, it } from "vitest";
import { isHarnessLaunch } from "../src/main/launch-mode";

const BUNDLE = "/home/u/code/selfos/out/main/index.cjs";
const CWD = "/home/u/code/selfos";

/** Minimal statSync/readFileSync stubs: only the paths we name are known. */
function fsStub(entries: Record<string, "dir" | "file" | { pkg: string }>) {
  return {
    statSync: (p: string) => {
      const e = entries[p];
      if (!e) throw new Error("ENOENT");
      return { isDirectory: () => e === "dir" } as never;
    },
    readFileSync: (p: string) => {
      const e = entries[p];
      if (e === "dir" || e === "file" || !e) throw new Error("ENOENT");
      return e.pkg;
    },
  };
}

function detect(argv: string[], entries: Record<string, "dir" | "file" | { pkg: string }>) {
  const fs = fsStub(entries);
  return isHarnessLaunch(argv, CWD, BUNDLE, fs);
}

describe("isHarnessLaunch", () => {
  it("treats a direct bundle launch as the real app", () => {
    expect(detect(["/electron", BUNDLE, "--no-sandbox"], { [BUNDLE]: "file" })).toBe(false);
  });

  it("treats `electron .` (directory entry via package.json main) as the real app", () => {
    expect(
      detect(["/electron", ".", "--no-sandbox"], {
        [CWD]: "dir",
        [`${CWD}/package.json`]: { pkg: JSON.stringify({ main: "out/main/index.cjs" }) },
        [BUNDLE]: "file",
      }),
    ).toBe(false);
  });

  it("treats an absolute directory entry as the real app", () => {
    expect(
      detect(["/electron", CWD], {
        [CWD]: "dir",
        [`${CWD}/package.json`]: { pkg: JSON.stringify({ main: "out/main/index.cjs" }) },
        [BUNDLE]: "file",
      }),
    ).toBe(false);
  });

  it("ignores Electron flags that arrive before the entry point", () => {
    expect(detect(["/electron", "--no-sandbox", BUNDLE], { [BUNDLE]: "file" })).toBe(false);
  });

  it("detects a verifier that required the bundle", () => {
    expect(
      detect(["/electron", `${CWD}/spikes/verify-time.cjs`, "--no-sandbox"], {
        [`${CWD}/spikes/verify-time.cjs`]: "file",
        [BUNDLE]: "file",
      }),
    ).toBe(true);
  });

  it("detects an ad-hoc probe that required the bundle", () => {
    expect(
      detect(["/electron", "/tmp/probe-warm3.cjs", "--no-sandbox"], {
        "/tmp/probe-warm3.cjs": "file",
        [BUNDLE]: "file",
      }),
    ).toBe(true);
  });

  it("assumes a real launch when the entry cannot be inspected", () => {
    // A packaged asar path, or a directory without package.json, must not be
    // mistaken for a harness — that would hide the app's own window.
    expect(detect(["/electron", "/opt/SelfOS/resources/app.asar"], {})).toBe(false);
    expect(detect(["/electron", "/nowhere"], {})).toBe(false);
  });

  it("assumes a real launch when a directory has no main field", () => {
    expect(
      detect(["/electron", "."], {
        [CWD]: "dir",
        [`${CWD}/package.json`]: { pkg: JSON.stringify({ name: "selfos" }) },
      }),
    ).toBe(false);
  });

  it("returns false when there is no entry argument at all", () => {
    expect(detect(["/electron"], {})).toBe(false);
    expect(detect(["/electron", "--no-sandbox"], {})).toBe(false);
  });
});

describe("isHarnessLaunch switch values", () => {
  it("does not read a switch's value as the entry point", () => {
    // A real launch with a space-separated switch value used to be classified
    // as a harness run: the window stayed unmapped and data went to scratch.
    expect(
      detect(["/electron", "--user-data-dir", "/tmp/x", BUNDLE], {
        [BUNDLE]: "file",
      }),
    ).toBe(false);
    expect(
      detect(["/electron", "--ozone-platform", "wayland", BUNDLE], {
        [BUNDLE]: "file",
      }),
    ).toBe(false);
  });
});
