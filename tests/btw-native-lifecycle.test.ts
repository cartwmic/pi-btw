import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
const port = vi.hoisted(() => ({ spawn: vi.fn(), agentDir: "" }));
vi.mock("node-pty", () => ({ spawn: port.spawn }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => port.agentDir, getPackageDir: () => "/TESTONLY/pi", SessionManager: { open: () => ({ buildSessionContext: () => ({ model: { provider: "scripted", modelId: "b" } }) }) } }));
vi.mock("node:child_process", () => ({ spawnSync: (_file: string, args: string[]) => args.includes("-p") ? { status: 0, stderr: "", stdout: `777777 ${process.pid} 777777 ${process.getuid?.()}\n` } : { status: 1, stderr: "", stdout: "" } }));
import { NativeBtwPopup } from "../extensions/btw-native";

it("uses one normal child, retains it across hide/reopen, and closes through its control service", async () => {
  const root = process.env.PI_BTW_TEST_ROOT ?? join(process.cwd(), ".native-test-resources");
  mkdirSync(root, { recursive: true });port.agentDir = mkdtempSync(join(root, "lifecycle-unit-"));
  let exited: ((event: { exitCode: number; signal?: number }) => void) | undefined;let data: ((text: string) => void) | undefined;
  const child = { pid: 777777, write: vi.fn(), resize: vi.fn(), onData: vi.fn((fn: any) => { data = fn; }), onExit: vi.fn((fn: any) => { exited = fn; }) };
  port.spawn.mockReturnValue(child);
  const handle = { setHidden: vi.fn(), focus: vi.fn(), getBounds: () => ({ width: 80, height: 18 }) };
  const capture = vi.fn(() => JSON.stringify({ version: 1, kind: "pi-conversation-snapshot", source: { header: { type: "session", version: 3 }, cwd: "/project", leafId: null }, branch: [], model: { provider: "scripted", id: "a" }, thinkingLevel: "low", runtime: { finalized: [], streamingMessage: null, pendingToolCalls: [], toolObservations: {}, isStreaming: false } }));
  let view: any;const done = vi.fn();
  const ctx: any = { cwd: "/project", captureConversationSnapshot: capture, sessionManager: { getSessionFile: () => "/main.jsonl" }, ui: { notify: vi.fn(), custom: vi.fn(async (factory: any, options: any) => { options.onHandle(handle);view = await factory({ btwNativeExclusiveInput: true, terminal: { columns: 100, rows: 24, kittyProtocolActive: false }, queryTerminalColors: async () => ({}), requestRender: vi.fn() }, {}, {}, done);return new Promise(() => {}); }) } };
  const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("TESTONLY absent"), { code: "ESRCH" }); });
  vi.useFakeTimers();
  const parentImageProtocol = process.env.PI_IMAGE_PROTOCOL;
  const popup = new NativeBtwPopup([], () => {});await popup.open(ctx);await Promise.resolve();
  expect(process.env.PI_IMAGE_PROTOCOL).toBe(parentImageProtocol);
  expect(capture).toHaveBeenCalledTimes(1);expect(port.spawn).toHaveBeenCalledTimes(1);
  const [, argv, options] = port.spawn.mock.calls[0];expect(options.cwd).toBe("/project");expect(options.env.PI_IMAGE_PROTOCOL).toBe("none");expect(options.env).not.toBe(process.env);
  expect(argv).toContain("scripted/a");expect(argv).not.toContain("--no-extensions");expect(argv).not.toContain("--no-mcp");expect(argv).not.toContain("--no-skills");
  view.handleInput("draft");expect(child.write).toHaveBeenCalledWith("draft");
  popup.toggle();expect(handle.setHidden).not.toHaveBeenCalled();
  const ack = () => writeFileSync(options.env.PI_BTW_NATIVE_CONTROL + ".ack", JSON.stringify({ revision: JSON.parse(readFileSync(options.env.PI_BTW_NATIVE_CONTROL, "utf8")).revision, pid: child.pid, sessionId: popup.pointer!.id }));
  ack();await vi.advanceTimersByTimeAsync(20);expect(handle.setHidden).toHaveBeenLastCalledWith(true);expect(done).not.toHaveBeenCalled();
  await expect(popup.open(ctx, "must not disappear")).rejects.toThrow("native editor");
  data!("hidden progress");const reopening = popup.open(ctx);ack();await vi.advanceTimersByTimeAsync(20);await reopening;expect(handle.setHidden).toHaveBeenLastCalledWith(false);expect(capture).toHaveBeenCalledTimes(1);expect(port.spawn).toHaveBeenCalledTimes(1);
  const changedFile = join(port.agentDir, "switched-session.jsonl");writeFileSync(changedFile, readFileSync(popup.pointer!.sessionFile));
  writeFileSync(options.env.PI_BTW_NATIVE_CONTROL + ".session", JSON.stringify({ sessionFile: changedFile, id: "switched-id", cwd: "/project" }));
  const shutting = popup.shutdown();expect(JSON.parse(readFileSync(options.env.PI_BTW_NATIVE_CONTROL, "utf8")).close).toBe(true);
  exited!({ exitCode: 0 });await shutting;expect(popup.lastExit).toEqual({ pid: 777777, exitCode: 0 });expect(done).toHaveBeenCalledTimes(1);expect(popup.hasSession()).toBe(false);
  await popup.open(ctx);await Promise.resolve();expect(port.spawn).toHaveBeenCalledTimes(2);expect(capture).toHaveBeenCalledTimes(1);
  const resumedArgs = port.spawn.mock.calls[1][1];expect(popup.pointer!.sessionFile).toBe(changedFile);expect(popup.pointer!.id).toBe("switched-id");expect(resumedArgs).toContain(popup.pointer!.sessionFile);expect(resumedArgs).not.toContain("--thinking");expect(resumedArgs).not.toContain("--model");
  expect(JSON.parse(readFileSync(port.spawn.mock.calls[1][2].env.PI_BTW_NATIVE_CONTROL, "utf8")).expectedModel).toBe("scripted/b");
  const closeAgain = popup.shutdown();exited!({ exitCode: 0 });await closeAgain;kill.mockRestore();vi.useRealTimers();
});

it("rejects absent managed snapshot before creating a child", async () => {
  const popup = new NativeBtwPopup([], () => {});const before = port.spawn.mock.calls.length;
  await expect(popup.open({ cwd: "/project" } as any)).rejects.toThrow("atomic conversation-capture patch");expect(port.spawn.mock.calls.length).toBe(before);
});

function failureHarness() {
 const root = process.env.PI_BTW_TEST_ROOT ?? join(process.cwd(), ".native-test-resources");mkdirSync(root, { recursive: true });port.agentDir = mkdtempSync(join(root, "failure-unit-"));
 let exit!: (event: { exitCode: number }) => void;let data!: (text: string) => void;
 const child = { pid: 777777, write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: vi.fn((fn: any) => { data = fn; }), onExit: vi.fn((fn: any) => { exit = fn; }) };port.spawn.mockReturnValue(child);
 let view: any;const done = vi.fn();const notify = vi.fn();
 const ctx: any = { cwd: "/project", captureConversationSnapshot: () => JSON.stringify({ version: 1, kind: "pi-conversation-snapshot", source: { header: { type: "session", version: 3 }, cwd: "/project" }, branch: [], model: { provider: "scripted", id: "a" }, thinkingLevel: "low", runtime: { finalized: [], pendingToolCalls: [], toolObservations: {} } }), sessionManager: { getSessionFile: () => "/main.jsonl" }, ui: { notify, custom: async (factory: any) => { view = await factory({ btwNativeExclusiveInput: true, terminal: { columns: 100, rows: 24 }, queryTerminalColors: async () => ({}), requestRender: vi.fn() }, {}, {}, done);return new Promise(() => {}); } } };
 const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("TESTONLY absent"), { code: "ESRCH" }); });
 return { child, ctx, done, notify, kill, view: () => view, exit: () => exit({ exitCode: 0 }), data: (text: string) => data(text) };
}
it.each([false, true])("collects failed constructor startup after original-handle termination (kill failure: %s)", async (killFailure) => {
 const h = failureHarness();if (killFailure) h.child.kill.mockImplementation(() => { throw Error("TESTONLY handle termination failure"); });let constructed!: () => void;const construction = new Promise<void>(resolve => { constructed = resolve; });
 const popup = new NativeBtwPopup([], () => {}, () => { expect(h.child.onExit).toHaveBeenCalledTimes(1);constructed();throw Error("TESTONLY constructor failure"); });
 const opening = popup.open(h.ctx);const observed = opening.catch(error => error);const rejected = expect(opening).rejects.toThrow("constructor failure");await construction;
 expect(popup.pointer).toBeUndefined();expect(popup.hasSession()).toBe(true);
 // Successful control publication is not startup-cleanup initiation.
 expect(h.child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
 const control = port.spawn.mock.calls.at(-1)![2].env.PI_BTW_NATIVE_CONTROL;expect(JSON.parse(readFileSync(control, "utf8")).close).toBe(true);
 h.exit();await rejected;
 if (killFailure) { const error = await observed;expect(error).toBeInstanceOf(AggregateError);expect(error.errors.map(String)).toEqual(["Error: TESTONLY constructor failure", "Error: TESTONLY handle termination failure"]); }
 expect(popup.lastExit).toEqual({ pid: 777777, exitCode: 0 });expect(popup.hasSession()).toBe(false);h.kill.mockRestore();
});
it("awaits final decode/disposal and preserves original exit when notification and modal completion throw", async () => {
 const h = failureHarness();let drain!: () => void;const pending = new Promise<void>(resolve => { drain = resolve; });
 const terminal: any = { write: () => pending, dispose: vi.fn(() => pending) };
 const popup = new NativeBtwPopup([], () => {}, () => terminal);await popup.open(h.ctx);
 const control = port.spawn.mock.calls.at(-1)![2].env.PI_BTW_NATIVE_CONTROL;mkdirSync(control + ".error"); // TESTONLY EISDIR read failure.
 h.kill.mockImplementation(() => { throw Object.assign(new Error("TESTONLY unknown"), { code: "EPERM" }); });
 h.done.mockImplementation(() => { throw Error("TESTONLY done failure"); });h.notify.mockImplementation(() => { throw Error("TESTONLY notify failure"); });h.data("final queued output");
 let settled = false;const shutting = popup.shutdown().finally(() => { settled = true; });const rejected = expect(shutting).rejects.toThrow("exit collection failed");h.exit();
 await Promise.resolve();await Promise.resolve();expect(settled).toBe(false);expect(popup.hasSession()).toBe(true);
 drain();await rejected;expect(terminal.dispose).toHaveBeenCalledTimes(1);expect(popup.lastExit).toEqual({ pid: 777777, exitCode: 0 });expect(popup.hasSession()).toBe(false);h.kill.mockRestore();
});

it("preserves the live child when unsupported image text is displayed", async () => {
 const h = failureHarness();const terminal: any = { resize: vi.fn(), render: () => ["[Unsupported child image 1: iTerm]"], dispose: async () => {} };
 const popup = new NativeBtwPopup([], () => {}, () => terminal);await popup.open(h.ctx);
 expect(h.view().render(80).join("")).toContain("Unsupported child image");expect(popup.hasSession()).toBe(true);
 const control = port.spawn.mock.calls.at(-1)![2].env.PI_BTW_NATIVE_CONTROL;expect(JSON.parse(readFileSync(control, "utf8")).close).toBe(false);
 const shutting = popup.shutdown();h.exit();await shutting;h.kill.mockRestore();
});
it("collects the outgoing view without clearing a different current child/view", async () => {
 const h = failureHarness();const outgoing: any = { dispose: vi.fn(async () => {}) };
 const popup = new NativeBtwPopup([], () => {}, () => outgoing);await popup.open(h.ctx);
 const collection = (popup as any).exit;const currentChild = { pid: 888888 },currentView = { dispose: vi.fn() },currentRender = vi.fn();
 (popup as any).child = currentChild;(popup as any).terminal = currentView;(popup as any).render = currentRender;
 h.exit();await collection;expect(outgoing.dispose).toHaveBeenCalledTimes(1);expect(currentView.dispose).not.toHaveBeenCalled();expect((popup as any).child).toBe(currentChild);expect((popup as any).terminal).toBe(currentView);expect((popup as any).render).toBe(currentRender);
 h.kill.mockRestore();
});
