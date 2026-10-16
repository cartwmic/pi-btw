import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
const port = vi.hoisted(() => ({ spawn: vi.fn(), agentDir: "" }));
vi.mock("node-pty", () => ({ spawn: port.spawn }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => port.agentDir, getPackageDir: () => "/TESTONLY/pi", SessionManager: { open: () => ({ buildSessionContext: () => ({ model: { provider: "scripted", modelId: "a" } }) }) } }));
vi.mock("node:child_process", () => ({ spawnSync: (_file: string, args: string[]) => args.includes("-p") ? { status: 0, stderr: "", stdout: `777777 ${process.pid} 777777 ${process.getuid?.()}\n` } : { status: 1, stderr: "", stdout: "" } }));
import { BtwTerminal } from "../extensions/btw-terminal";
import { NativeBtwPopup, resizeChildPty, isClosedPtyResizeError, CLOSED_PTY_RESIZE_MESSAGE } from "../extensions/btw-native";

const cut = () => JSON.stringify({ version: 1, kind: "pi-conversation-snapshot", source: { header: { type: "session", version: 3 }, cwd: "/project", sessionFile: "/main.jsonl", leafId: null }, branch: [], model: { provider: "scripted", id: "a" }, thinkingLevel: "low", runtime: { finalized: [], streamingMessage: null, pendingToolCalls: [], toolObservations: {}, isStreaming: false } });
const ebadf = () => new Error("ioctl(2) failed, EBADF");
function harness(bounds = { width: 80, height: 18 }) {
  const root = process.env.PI_BTW_TEST_ROOT ?? join(process.cwd(), ".native-test-resources");mkdirSync(root, { recursive: true });port.agentDir = mkdtempSync(join(root, "closedpty-unit-"));port.spawn.mockReset();
  let exit!: (event: { exitCode: number }) => void;
  const state = { closed: false, failWith: undefined as Error | undefined };
  const child = { pid: 777777, write: vi.fn(), kill: vi.fn(), onData: vi.fn(), onExit: vi.fn((fn: any) => { exit = fn; }),
    resize: vi.fn(() => { if (state.failWith) throw state.failWith; if (state.closed) throw ebadf(); }) };port.spawn.mockReturnValue(child);
  const handle = { setHidden: vi.fn(), focus: vi.fn(), getBounds: () => bounds };
  let view: any;
  const ctx: any = { cwd: "/project", captureConversationSnapshot: cut, sessionManager: { getSessionFile: () => "/main.jsonl" }, ui: { notify: vi.fn(), custom: vi.fn(async (factory: any, options: any) => { options.onHandle(handle);view = await factory({ btwNativeExclusiveInput: true, terminal: { columns: 100, rows: 24, kittyProtocolActive: false }, queryTerminalColors: async () => ({}), requestRender: vi.fn() }, {}, {}, vi.fn());return new Promise(() => {}); }) } };
  const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("TESTONLY absent"), { code: "ESRCH" }); });
  return { ctx, child, state, view: () => view, exit: () => exit({ exitCode: 0 }), kill };
}
const flush = async () => { await Promise.resolve();await Promise.resolve(); };

// Every message node-pty 1.1.0 can raise from resize (src/unix/pty.cc pty_resize, lib/unixTerminal.js), plus near-miss shapes.
const SWALLOWED: [string, unknown][] = [
  ["node-pty EBADF (Error)", new Error("ioctl(2) failed, EBADF")],
  ["node-pty EBADF (foreign-realm plain object with the same message)", { message: "ioctl(2) failed, EBADF" }],
];
const RETHROWN: [string, unknown][] = [
  ["node-pty EFAULT", new Error("ioctl(2) failed, EFAULT")],
  ["node-pty EINVAL", new Error("ioctl(2) failed, EINVAL")],
  ["node-pty ENOTTY (fd may have been recycled: must surface)", new Error("ioctl(2) failed, ENOTTY")],
  ["node-pty bare ioctl failure", new Error("ioctl(2) failed")],
  ["node-pty JS dimension check", new Error("resizing must be done using positive cols and rows")],
  ["Node fs-style EBADF text", new Error("EBADF: bad file descriptor, ioctl")],
  ["EBADF substring only", new Error("write EBADF")],
  ["extra trailing text", new Error("ioctl(2) failed, EBADF (again)")],
  ["leading text", new Error("xioctl(2) failed, EBADF")],
  ["lowercase", new Error("ioctl(2) failed, ebadf")],
  ["code property without the message", Object.assign(new Error("boom"), { code: "EBADF" })],
  ["thrown string with the message (node-pty never throws strings)", "ioctl(2) failed, EBADF"],
  ["null", null],
  ["undefined", undefined],
  ["number", 9],
];

describe("closed-PTY predicate against the real node-pty error shapes", () => {
  it("the constant is the exact message", () => { expect(CLOSED_PTY_RESIZE_MESSAGE).toBe("ioctl(2) failed, EBADF"); });
  it.each(SWALLOWED)("swallows: %s", (_name, thrown) => {
    expect(isClosedPtyResizeError(thrown)).toBe(true);
    expect(() => resizeChildPty({ resize: () => { throw thrown; } }, 80, 18)).not.toThrow();
  });
  it.each(RETHROWN)("rethrows: %s", (_name, thrown) => {
    expect(isClosedPtyResizeError(thrown)).toBe(false);
    let caught: unknown = Symbol("none");try { resizeChildPty({ resize: () => { throw thrown; } }, 80, 18); } catch (error) { caught = error; }
    expect(caught).toBe(thrown);   // the identical value, not a wrapper
  });
  it("passes the dimensions through and returns normally on a live PTY", () => {
    const ok = vi.fn();resizeChildPty({ resize: ok }, 80, 18);expect(ok).toHaveBeenCalledExactlyOnceWith(80, 18);
  });
});

describe("closed child PTY between PTY close and exit collection (r11 HOLD)", () => {
  it("render() on a popup whose PTY already closed does not throw; the session stays registered until the exit collection finishes, then it is collected normally", async () => {
    const h = harness();const popup = new NativeBtwPopup([], () => {});await popup.open(h.ctx);await flush();
    expect(() => h.view().render(80)).not.toThrow();expect(h.child.resize).toHaveBeenCalled();   // live PTY: still resized
    h.state.closed = true;                                   // PTY EOF; onExit has NOT fired yet (the r11 window)
    for (let i = 0; i < 5; i++) expect(() => h.view().render(80)).not.toThrow();
    expect(popup.hasSession()).toBe(true);                   // this.child is still set: that is exactly why render kept running
    const calls = h.child.resize.mock.calls.length;
    h.exit();await vi.waitFor(() => expect(popup.hasSession()).toBe(false));expect(popup.lastExit).toMatchObject({ pid: 777777, exitCode: 0 });
    expect(h.view().render(80)).toEqual([]);expect(h.child.resize.mock.calls.length).toBe(calls);   // after collection render() no longer touches the child
    h.kill.mockRestore();
  });
  it("the deferred bounds re-sync (queueMicrotask) is guarded too", async () => {
    const h = harness({ width: 70, height: 10 });const popup = new NativeBtwPopup([], () => {});await popup.open(h.ctx);await flush();
    h.state.closed = true;const errors: unknown[] = [];const onUnhandled = (e: unknown) => errors.push(e);process.on("unhandledRejection", onUnhandled);process.on("uncaughtException", onUnhandled);
    h.view().render(80);await flush();await new Promise(r => setTimeout(r, 0));
    process.off("unhandledRejection", onUnhandled);process.off("uncaughtException", onUnhandled);expect(errors).toEqual([]);
    expect(h.child.resize.mock.calls.length).toBeGreaterThanOrEqual(2);   // both call sites ran against the closed PTY
    h.exit();await vi.waitFor(() => expect(popup.hasSession()).toBe(false));h.kill.mockRestore();
  });
  it("a different resize failure is NOT hidden at either call site (negative controls)", async () => {
    for (const message of ["boom", "ioctl(2) failed, ENOTTY", "ioctl(2) failed, EINVAL"]) {
      const h = harness();const popup = new NativeBtwPopup([], () => {});await popup.open(h.ctx);await flush();
      h.state.failWith = new Error(message);expect(() => h.view().render(80)).toThrow(message);
      h.state.failWith = undefined;h.exit();await vi.waitFor(() => expect(popup.hasSession()).toBe(false));h.kill.mockRestore();
    }
  });
});

describe("input after the child PTY reported exit but before the exit collection finished (review: child.write hardening)", () => {
  it("live: keys and terminal replies reach the child; after the exit event none of them does (ordinary key, escape, reply callback)", async () => {
    const h = harness();let reply!: (data: string) => void;
    const popup = new NativeBtwPopup([], () => {}, (...args: ConstructorParameters<typeof BtwTerminal>) => { reply = args[2];return new BtwTerminal(...args); });
    await popup.open(h.ctx);await flush();
    h.view().handleInput("x");reply("REPLY-LIVE");expect(h.child.write.mock.calls.map(c => c[0])).toEqual(["x", "REPLY-LIVE"]);
    h.child.write.mockClear();
    h.exit();                                                    // synchronous: the exit collection has not finished, so this.child is still set
    expect(popup.hasSession()).toBe(true);
    h.view().handleInput("y");h.view().handleInput("\x1b");reply("REPLY-LATE");
    expect(h.child.write).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(popup.hasSession()).toBe(false));h.kill.mockRestore();
  });
});
