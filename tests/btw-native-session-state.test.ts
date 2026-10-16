import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
const port = vi.hoisted(() => ({ spawn: vi.fn(), agentDir: "" }));
vi.mock("node-pty", () => ({ spawn: port.spawn }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => port.agentDir, getPackageDir: () => "/TESTONLY/pi", SessionManager: { open: () => ({ buildSessionContext: () => ({ model: { provider: "scripted", modelId: "a" } }) }) } }));
vi.mock("node:child_process", () => ({ spawnSync: (_file: string, args: string[]) => args.includes("-p") ? { status: 0, stderr: "", stdout: `777777 ${process.pid} 777777 ${process.getuid?.()}\n` } : { status: 1, stderr: "", stdout: "" } }));
import { NativeBtwPopup, lastEntryId } from "../extensions/btw-native";
import { ATTENTION_TEXT, ATTENTION_KEY, attentionFile } from "../extensions/btw-attention";
import { sideThreadFromSession } from "../extensions/btw-menu";

const cutBytes = () => JSON.stringify({ version: 1, kind: "pi-conversation-snapshot", source: { header: { type: "session", version: 3 }, cwd: "/project", sessionFile: "/main.jsonl", leafId: "u1" }, branch: [{ type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "MAIN-SECRET-CONTEXT" }] } }], model: { provider: "scripted", id: "a" }, thinkingLevel: "low", runtime: { finalized: [], streamingMessage: null, pendingToolCalls: [], toolObservations: {}, isStreaming: false } });
function harness(withStatus = true) {
  const root = process.env.PI_BTW_TEST_ROOT ?? join(process.cwd(), ".native-test-resources");mkdirSync(root, { recursive: true });port.agentDir = mkdtempSync(join(root, "state-unit-"));port.spawn.mockReset();
  const exits: ((event: { exitCode: number }) => void)[] = [];
  const child = { pid: 777777, write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: vi.fn(), onExit: vi.fn((fn: any) => { exits.push(fn); }) };port.spawn.mockReturnValue(child);
  const handle = { setHidden: vi.fn(), focus: vi.fn(), getBounds: () => ({ width: 80, height: 18 }) };const capture = vi.fn(cutBytes);const setStatus = vi.fn();
  const ctx: any = { cwd: "/project", captureConversationSnapshot: capture, sessionManager: { getSessionFile: () => "/main.jsonl" }, ui: { notify: vi.fn(), ...(withStatus ? { setStatus } : {}), custom: vi.fn(async (factory: any, options: any) => { options.onHandle(handle);await factory({ btwNativeExclusiveInput: true, terminal: { columns: 100, rows: 24, kittyProtocolActive: false }, queryTerminalColors: async () => ({}), requestRender: vi.fn() }, {}, {}, vi.fn());return new Promise(() => {}); }) } };
  const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("TESTONLY absent"), { code: "ESRCH" }); });
  const finish = async (popup: NativeBtwPopup) => { const closing = popup.shutdown();exits.forEach(fn => fn({ exitCode: 0 }));await closing;exits.length = 0; };
  return { ctx, capture, setStatus, finish, kill };
}
const flush = async () => { await Promise.resolve();await Promise.resolve(); };
const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").map(l => JSON.parse(l));
const writeState = (popup: NativeBtwPopup, state: string, seq: number) => writeFileSync(attentionFile(popup.pointer!.controlFile!), JSON.stringify({ state, seq, pid: 1, at: 0 }));

describe("lastEntryId", () => {
  it("is the id of the last JSONL entry; undefined for empty or garbage", () => {
    expect(lastEntryId('{"id":"a"}\n{"id":"b"}\n')).toBe("b");expect(lastEntryId("")).toBeUndefined();expect(lastEntryId("not json\n")).toBeUndefined();expect(lastEntryId('{"id":5}\n')).toBeUndefined();
  });
});

describe("seed boundary persisted in the pointer", () => {
  it("contextual: boundary = the last seed entry, so the side thread starts EMPTY although the file holds the main conversation", async () => {
    const h = harness();const popup = new NativeBtwPopup([], () => {});await popup.open(h.ctx);await flush();
    const file = popup.pointer!.sessionFile;const all = lines(file);
    expect(popup.pointer!.seedLeafId).toBe(all.at(-1).id);expect(readFileSync(file, "utf8")).toContain("MAIN-SECRET-CONTEXT");
    expect(sideThreadFromSession(readFileSync(file, "utf8"), popup.pointer!.seedLeafId)).toEqual({ exchanges: [], scope: "after-seed" });
    await h.finish(popup);h.kill.mockRestore();
  });
  it("blank: boundary = its thinking-level entry; read-only behaves like contextual", async () => {
    for (const mode of ["blank", "readonly"] as const) {
      const h = harness();const popup = new NativeBtwPopup([], () => {});await popup.open(h.ctx, "", mode);await flush();
      expect(popup.pointer!.seedLeafId).toBe(lines(popup.pointer!.sessionFile).at(-1).id);
      await h.finish(popup);h.kill.mockRestore();
    }
  });
  it("a side message appended after open is part of the thread; the boundary survives resume and restore()", async () => {
    const h = harness();const popup = new NativeBtwPopup([], () => {});await popup.open(h.ctx);await flush();
    const boundary = popup.pointer!.seedLeafId!;const file = popup.pointer!.sessionFile;
    writeFileSync(file, readFileSync(file, "utf8") + JSON.stringify({ type: "message", id: "s1", parentId: boundary, message: { role: "user", content: [{ type: "text", text: "side question" }] } }) + "\n" + JSON.stringify({ type: "message", id: "s2", parentId: "s1", message: { role: "assistant", content: [{ type: "text", text: "side answer" }], stopReason: "stop" } }) + "\n");
    expect(sideThreadFromSession(readFileSync(file, "utf8"), boundary).exchanges).toEqual([{ user: "side question", assistant: "side answer" }]);
    await h.finish(popup);
    await popup.open(h.ctx);await flush();expect(popup.pointer!.seedLeafId).toBe(boundary);   // resume keeps it
    const saved = JSON.parse(JSON.stringify(popup.pointer));await h.finish(popup);
    const other = new NativeBtwPopup([], () => {});other.restore(saved);expect(other.pointer!.seedLeafId).toBe(boundary);
    const { seedLeafId: _drop, ...legacy } = saved;const old = new NativeBtwPopup([], () => {});old.restore(legacy);expect(old.pointer!.seedLeafId).toBeUndefined();   // pointer from before this field existed
    h.kill.mockRestore();
  });
});

describe("forget() for 'new session, keep the saved one'", () => {
  it("is refused while a child is live; afterwards it clears the pointer and mode but leaves the session file on disk", async () => {
    const h = harness();const popup = new NativeBtwPopup([], () => {});await popup.open(h.ctx, "", "readonly");await flush();
    expect(() => popup.forget()).toThrow("live");expect(popup.pointer).toBeDefined();expect(popup.currentMode).toBe("readonly");expect(popup.isLive).toBe(true);
    const file = popup.pointer!.sessionFile;await h.finish(popup);
    expect(popup.currentMode).toBe("readonly");expect(popup.isLive).toBe(false);
    popup.forget();expect(popup.pointer).toBeUndefined();expect(popup.currentMode).toBeUndefined();expect(readFileSync(file, "utf8")).toContain("MAIN-SECRET-CONTEXT");
    await popup.open(h.ctx, "", "blank");await flush();expect(popup.pointer!.mode).toBe("blank");expect(popup.pointer!.sessionFile).not.toBe(file);expect(h.capture).toHaveBeenCalledTimes(2);
    await h.finish(popup);h.kill.mockRestore();
  });
});

describe("quiet attention on the host (no focus change, no modal)", () => {
  it("hidden: one compact status per event; visible: status cleared and the event marked seen; opening/reopening never steals focus here", async () => {
    const h = harness();const popup = new NativeBtwPopup([], () => {});await popup.open(h.ctx);await flush();
    popup.attentionTick();expect(h.setStatus).not.toHaveBeenCalled();   // no state file yet
    writeState(popup, "done", 1);popup["visible"] = false;popup.attentionTick();
    expect(h.setStatus).toHaveBeenCalledExactlyOnceWith(ATTENTION_KEY, ATTENTION_TEXT.done);
    popup.attentionTick();popup.attentionTick();expect(h.setStatus).toHaveBeenCalledTimes(1);   // not repeated
    writeState(popup, "needs-input", 2);popup.attentionTick();expect(h.setStatus).toHaveBeenLastCalledWith(ATTENTION_KEY, ATTENTION_TEXT["needs-input"]);
    popup["visible"] = true;popup.attentionTick();expect(h.setStatus).toHaveBeenLastCalledWith(ATTENTION_KEY, undefined);
    popup["visible"] = false;popup.attentionTick();expect(h.setStatus).toHaveBeenCalledTimes(3);   // the needs-input event was seen while visible
    await h.finish(popup);h.kill.mockRestore();
  });
  it("a visible popup is never announced to; without a status line or without a child the tick does nothing", async () => {
    const h = harness();const popup = new NativeBtwPopup([], () => {});expect(() => popup.attentionTick()).not.toThrow();await popup.open(h.ctx);await flush();
    writeState(popup, "failed", 1);popup.attentionTick();expect(h.setStatus).not.toHaveBeenCalled();await h.finish(popup);
    const bare = harness(false);const p2 = new NativeBtwPopup([], () => {});await p2.open(bare.ctx);await flush();writeState(p2, "done", 1);p2["visible"] = false;expect(() => p2.attentionTick()).not.toThrow();await bare.finish(p2);
    h.kill.mockRestore();bare.kill.mockRestore();
  });
  it("a NEW session has its own sequence: its first event is announced even if the previous session reached a higher number", async () => {
    const h = harness();const popup = new NativeBtwPopup([], () => {});await popup.open(h.ctx);await flush();
    writeState(popup, "done", 9);popup["visible"] = false;popup.attentionTick();expect(h.setStatus).toHaveBeenCalledTimes(1);
    await h.finish(popup);popup.forget();await popup.open(h.ctx, "", "blank");await flush();
    popup["visible"] = false;writeState(popup, "failed", 1);popup.attentionTick();
    expect(h.setStatus).toHaveBeenLastCalledWith(ATTENTION_KEY, ATTENTION_TEXT.failed);
    await h.finish(popup);h.kill.mockRestore();
  });
  it("a hidden child that exits clears the status line (review P3-1a)", async () => {
    const h = harness();const popup = new NativeBtwPopup([], () => {});await popup.open(h.ctx);await flush();
    writeState(popup, "done", 1);popup["visible"] = false;popup.attentionTick();expect(h.setStatus).toHaveBeenLastCalledWith(ATTENTION_KEY, ATTENTION_TEXT.done);
    await h.finish(popup);expect(h.setStatus).toHaveBeenLastCalledWith(ATTENTION_KEY, undefined);h.kill.mockRestore();
  });
  it("a resumed child's OLD state is not re-announced when the popup is hidden right after the host restarts (review P3-1b)", async () => {
    const h = harness();const first = new NativeBtwPopup([], () => {});await first.open(h.ctx);await flush();
    writeState(first, "done", 5);const pointer = first.pointer;await h.finish(first);h.setStatus.mockClear();
    const host2 = new NativeBtwPopup([], () => {});host2.restore(pointer);await host2.open(h.ctx);await flush();   // fresh announcer, old state file still says done #5
    host2["visible"] = false;host2.attentionTick();
    expect(h.setStatus).not.toHaveBeenCalledWith(ATTENTION_KEY, ATTENTION_TEXT.done);
    writeState(host2, "done", 6);host2.attentionTick();expect(h.setStatus).toHaveBeenLastCalledWith(ATTENTION_KEY, ATTENTION_TEXT.done);   // a genuinely new event is still announced
    await h.finish(host2);h.kill.mockRestore();
  });
  it("the polling timer exists while the child is live and is gone after shutdown", async () => {
    const h = harness();const popup = new NativeBtwPopup([], () => {});await popup.open(h.ctx);await flush();
    expect(popup["attentionTimer"]).toBeDefined();
    await h.finish(popup);expect(popup["attentionTimer"]).toBeUndefined();h.kill.mockRestore();
  });
});
