import { describe, expect, it } from "vitest";
import { ErrorBoundary } from "../src/renderer/src/components/ErrorBoundary";

/**
 * The boundary's own state machine. React's server renderer does not support
 * error boundaries (they are a client-only mechanism), so the DOM-level
 * "throws -> fallback" behaviour cannot be exercised without a DOM environment;
 * these cover the logic the boundary owns.
 */
describe("ErrorBoundary state machine", () => {
  it("starts with no error, so children render", () => {
    const b = new ErrorBoundary({ resetKey: "a", children: null });
    expect(b.state.error).toBeNull();
  });

  it("getDerivedStateFromError stores the thrown error", () => {
    const e = new Error("kaboom from a module");
    expect(ErrorBoundary.getDerivedStateFromError(e)).toEqual({ error: e });
  });

  it("clears the error when resetKey changes to a different module", () => {
    const b = new ErrorBoundary({ resetKey: "Reading", children: null });
    b.state = { error: new Error("boom") };
    const applied: Array<Partial<{ error: Error | null }>> = [];
    b.setState = ((u: Partial<{ error: Error | null }>) => applied.push(u)) as never;
    b.componentDidUpdate({ resetKey: "Habits", children: null });
    expect(applied).toEqual([{ error: null }]);
  });

  it("keeps the error when the same module re-renders", () => {
    const b = new ErrorBoundary({ resetKey: "Reading", children: null });
    const err = new Error("boom");
    b.state = { error: err };
    let called = false;
    b.setState = (() => {
      called = true;
    }) as never;
    b.componentDidUpdate({ resetKey: "Reading", children: null });
    expect(called).toBe(false);
  });

  /**
   * `main.tsx` mounts the same component at the root with its own fallback,
   * because at that level there is no sidebar to point at — the default
   * in-shell message would be misleading. These pin that the prop is honoured
   * and that the default still applies when it is absent.
   */
  it("renders children via render() when there is no error", () => {
    const b = new ErrorBoundary({ children: "child", fallback: () => "FALLBACK" });
    // Call render() itself: the previous version asserted only the initial
    // state, which never executes the fallback-vs-default branch this test
    // names. render() returns plain React elements, so no DOM is needed.
    expect(b.render()).toBe("child");
  });

  it("render() uses the supplied fallback when there is an error", () => {
    const err = new Error("shell exploded");
    const b = new ErrorBoundary({ children: "child", fallback: (e: Error) => `custom:${e.message}` });
    b.state = { error: err };
    // The old test invoked the arrow function it had just passed in, proving
    // nothing about render(). This exercises the branch that chooses it.
    expect(b.render()).toBe("custom:shell exploded");
  });

  it("render() falls back to the in-shell module error when no fallback is given", () => {
    const b = new ErrorBoundary({ children: "child" });
    b.state = { error: new Error("module blew up") };
    const el = b.render() as { type: string; props: { className: string; children: unknown[] } };
    expect(el.type).toBe("div");
    expect(el.props.className).toBe("module-error");
    // The message reaches the user, and a retry control exists (the fallback
    // used to tell the user to "reopen this one", which does not work).
    const flat = JSON.stringify(el.props.children);
    expect(flat).toContain("module blew up");
    expect(flat).toContain("Try again");
  });
});

/**
 * The fallback used to advise "reopen this one", which cannot work: `App`
 * navigates with `setActive(m)`, and re-selecting the already-active module
 * bails out of the state update, so `resetKey` never changes and the error
 * never clears. These pin the real behaviour and the retry that replaces the
 * false advice.
 */
describe("ErrorBoundary recovery is actually reachable", () => {
  it("re-selecting the SAME module does not clear the error", () => {
    const b = new ErrorBoundary({ resetKey: "Reading", children: null });
    b.state = { error: new Error("boom") };
    let cleared = false;
    b.setState = ((u: { error: Error | null }) => {
      if (u.error === null) cleared = true;
    }) as never;
    b.componentDidUpdate({ resetKey: "Reading", children: null });
    expect(cleared).toBe(false);
  });

  it("switching to a DIFFERENT module clears it", () => {
    const b = new ErrorBoundary({ resetKey: "Reading", children: null });
    b.state = { error: new Error("boom") };
    let cleared = false;
    b.setState = ((u: { error: Error | null }) => {
      if (u.error === null) cleared = true;
    }) as never;
    b.componentDidUpdate({ resetKey: "Habits", children: null });
    expect(cleared).toBe(true);
  });
});
