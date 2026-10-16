import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
const port = vi.hoisted(() => ({ spawn: vi.fn(), agentDir: "" }));
vi.mock("node-pty", () => ({ spawn: port.spawn }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => port.agentDir, getPackageDir: () => "/TESTONLY/pi", SessionManager: { open: () => ({ buildSessionContext: () => ({ model: { provider: "scripted", modelId: "a" } }) }) } }));
vi.mock("node:child_process", () => ({ spawnSync: (_file: string, args: string[]) => args.includes("-p") ? { status: 0, stderr: "", stdout: `777777 ${process.pid} 777777 ${process.getuid?.()}\n` } : { status: 1, stderr: "", stdout: "" } }));
import { NativeBtwPopup, nativeChildArgs, NATIVE_MODE_COMMAND, READONLY_TOOL_ARGS } from "../extensions/btw-native";
import { blankNativeSession, seedNativeSession } from "../extensions/btw-seed";

const cutBytes = () => JSON.stringify({ version: 1, kind: "pi-conversation-snapshot", source: { header: { type: "session", version: 3, parentSession: "/older.jsonl" }, cwd: "/project", sessionFile: "/main.jsonl", leafId: "u1" }, branch: [{ type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "MAIN-SECRET-CONTEXT" }] } }], model: { provider: "scripted", id: "a" }, thinkingLevel: "low", runtime: { finalized: [], streamingMessage: null, pendingToolCalls: [], toolObservations: {}, isStreaming: false } });
const lines = (jsonl: string) => jsonl.trim().split("\n").map(s => JSON.parse(s));

describe("blank native session seed", () => {
  it("keeps the cut's cwd, model and thinking level and nothing of the main conversation or parent link", () => {
    const blank = blankNativeSession(cutBytes());const [header, ...entries] = lines(blank.jsonl);
    expect(header).toMatchObject({ type: "session", version: 3, id: blank.id, cwd: "/project" });expect(header.parentSession).toBeUndefined();
    expect(blank.jsonl).not.toContain("MAIN-SECRET-CONTEXT");expect(entries.map(e => e.type)).toEqual(["model_change", "thinking_level_change"]);
    expect(entries[0]).toMatchObject({ provider: "scripted", modelId: "a", parentId: null });expect(entries[1]).toMatchObject({ thinkingLevel: "low", parentId: entries[0].id });
    expect(blank.cut.model.id).toBe("a");
  });
  it("negative control: the contextual seed from the same cut DOES carry the main conversation and the parent link", () => {
    const seeded = seedNativeSession(cutBytes());expect(seeded.jsonl).toContain("MAIN-SECRET-CONTEXT");expect(lines(seeded.jsonl)[0].parentSession).toBe("/main.jsonl");
  });
  it("rejects a missing snapshot contract instead of guessing a model", () => { expect(() => blankNativeSession("{}")).toThrow(); });
});

describe("native child argv", () => {
  const fresh = { provider: "scripted", id: "a", thinkingLevel: "low" };
  it("contextual and blank first starts pass model and thinking and no tool restriction", () => {
    for (const mode of ["contextual", "blank"] as const) { const argv = nativeChildArgs("cli.js", "/s.jsonl", mode, fresh, "");
      expect(argv).toEqual(["cli.js", "--session", "/s.jsonl", "--model", "scripted/a", "--thinking", "low"]);expect(argv).not.toContain("--tools"); }
  });
  it("read-only first start AND resume both carry the allowlist and MCP/codemode exclusion; initial text stays last", () => {
    const first = nativeChildArgs("cli.js", "/s.jsonl", "readonly", fresh, "why");const resumed = nativeChildArgs("cli.js", "/s.jsonl", "readonly", undefined, "");
    expect(first).toEqual(["cli.js", "--session", "/s.jsonl", "--model", "scripted/a", "--thinking", "low", ...READONLY_TOOL_ARGS, "why"]);
    expect(resumed).toEqual(["cli.js", "--session", "/s.jsonl", ...READONLY_TOOL_ARGS]);
    expect(READONLY_TOOL_ARGS[1]).toBe("read,grep,find,ls");for (const banned of ["bash", "edit", "write"]) expect(READONLY_TOOL_ARGS[1].split(",")).not.toContain(banned);
    expect(READONLY_TOOL_ARGS[3]).toContain("mcp__*");expect(READONLY_TOOL_ARGS[3]).toContain("codemode");
  });
  it("negative control: a contextual resume has no tool flags", () => { expect(nativeChildArgs("cli.js", "/s.jsonl", "contextual", undefined, "")).toEqual(["cli.js", "--session", "/s.jsonl"]); });
});

function harness() {
  const root = process.env.PI_BTW_TEST_ROOT ?? join(process.cwd(), ".native-test-resources");mkdirSync(root, { recursive: true });port.agentDir = mkdtempSync(join(root, "modes-unit-"));port.spawn.mockReset();
  let exit!: (event: { exitCode: number }) => void;
  const child = { pid: 777777, write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: vi.fn(), onExit: vi.fn((fn: any) => { exit = fn; }) };port.spawn.mockReturnValue(child);
  const handle = { setHidden: vi.fn(), focus: vi.fn(), getBounds: () => ({ width: 80, height: 18 }) };const capture = vi.fn(cutBytes);
  const ctx: any = { cwd: "/project", captureConversationSnapshot: capture, sessionManager: { getSessionFile: () => "/main.jsonl" }, ui: { notify: vi.fn(), custom: vi.fn(async (factory: any, options: any) => { options.onHandle(handle);await factory({ btwNativeExclusiveInput: true, terminal: { columns: 100, rows: 24, kittyProtocolActive: false }, queryTerminalColors: async () => ({}), requestRender: vi.fn() }, {}, {}, vi.fn());return new Promise(() => {}); }) } };
  const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("TESTONLY absent"), { code: "ESRCH" }); });
  return { ctx, capture, child, kill, exit: () => exit({ exitCode: 0 }) };
}
const sessionOf = (popup: NativeBtwPopup) => lines(readFileSync(popup.pointer!.sessionFile, "utf8"));

describe("native popup modes", () => {
  it("blank: one atomic capture, no inherited conversation or parent in the saved session or pointer, plain child args", async () => {
    const h = harness();const popup = new NativeBtwPopup([], () => {});await popup.open(h.ctx, "", "blank");await Promise.resolve();
    expect(h.capture).toHaveBeenCalledTimes(1);const argv = port.spawn.mock.calls[0][1];expect(argv).toContain("scripted/a");expect(argv).not.toContain("--tools");
    const saved = readFileSync(popup.pointer!.sessionFile, "utf8");expect(saved).not.toContain("MAIN-SECRET-CONTEXT");expect(sessionOf(popup)[0].parentSession).toBeUndefined();
    expect(popup.pointer).toMatchObject({ mode: "blank", cwd: "/project" });expect(popup.pointer!.parentSession).toBeUndefined();
    const closing = popup.shutdown();h.exit();await closing;h.kill.mockRestore();
  });
  it("read-only: inherited context kept, tool restriction on the first start and again on resume, pointer records the mode", async () => {
    const h = harness();const popup = new NativeBtwPopup([], () => {});await popup.open(h.ctx, "", "readonly");await Promise.resolve();
    expect(readFileSync(popup.pointer!.sessionFile, "utf8")).toContain("MAIN-SECRET-CONTEXT");
    expect(port.spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(READONLY_TOOL_ARGS));expect(popup.pointer!.mode).toBe("readonly");
    const closing = popup.shutdown();h.exit();await closing;
    // Resume from the saved pointer; plain /btw (no requested mode) reopens it as read-only.
    await popup.open(h.ctx);await Promise.resolve();expect(h.capture).toHaveBeenCalledTimes(1);
    const resumed = port.spawn.mock.calls[1][1];expect(resumed).toEqual(expect.arrayContaining(READONLY_TOOL_ARGS));expect(resumed).not.toContain("--model");
    const again = popup.shutdown();h.exit();await again;h.kill.mockRestore();
  });
  it("restore() from a persisted pointer keeps its mode; an old pointer without a mode is contextual", async () => {
    const h = harness();const first = new NativeBtwPopup([], () => {});await first.open(h.ctx, "", "readonly");await Promise.resolve();const saved = { ...first.pointer! };const closing = first.shutdown();h.exit();await closing;
    const second = new NativeBtwPopup([], () => {});second.restore(JSON.parse(JSON.stringify(saved)));expect(second.pointer!.mode).toBe("readonly");
    const { mode: _drop, ...legacy } = saved;const third = new NativeBtwPopup([], () => {});third.restore(legacy);expect(third.pointer!.mode).toBe("contextual");
    await second.open(h.ctx);await Promise.resolve();expect(port.spawn.mock.calls.at(-1)![1]).toEqual(expect.arrayContaining(READONLY_TOOL_ARGS));
    const again = second.shutdown();h.exit();await again;h.kill.mockRestore();
  });
  it("a mode-specific command never reopens a different mode (live or saved), and creates no second child", async () => {
    const h = harness();const popup = new NativeBtwPopup([], () => {});await popup.open(h.ctx, "", "blank");await Promise.resolve();
    await expect(popup.open(h.ctx, "", "readonly")).rejects.toThrow("already exists in blank mode; use /btw:tangent or /btw");
    await expect(popup.open(h.ctx, "", "contextual")).rejects.toThrow("blank mode");expect(port.spawn).toHaveBeenCalledTimes(1);expect(h.capture).toHaveBeenCalledTimes(1);
    const closing = popup.shutdown();h.exit();await closing;
    await expect(popup.open(h.ctx, "", "readonly")).rejects.toThrow("blank mode");expect(port.spawn).toHaveBeenCalledTimes(1);
    expect(NATIVE_MODE_COMMAND).toEqual({ contextual: "/btw", blank: "/btw:tangent", readonly: "/btw:ask" });h.kill.mockRestore();
  });
  it("default (plain /btw) is contextual: negative control against the blank path", async () => {
    const h = harness();const popup = new NativeBtwPopup([], () => {});await popup.open(h.ctx);await Promise.resolve();
    expect(readFileSync(popup.pointer!.sessionFile, "utf8")).toContain("MAIN-SECRET-CONTEXT");expect(popup.pointer!.mode).toBe("contextual");expect(port.spawn.mock.calls[0][1]).not.toContain("--tools");
    const closing = popup.shutdown();h.exit();await closing;h.kill.mockRestore();
  });
});
