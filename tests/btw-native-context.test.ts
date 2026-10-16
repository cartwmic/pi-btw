import { describe, expect, it } from "vitest";
import { seedNativeSession } from "../extensions/btw-seed";
import { BtwTerminal } from "../extensions/btw-terminal";

function cut() { return { version: 1, kind: "pi-conversation-snapshot", source: { header: { type: "session", version: 3 }, cwd: "/project", sessionFile: "/main.jsonl", leafId: "a" }, branch: [{ type: "message", id: "a", parentId: null, message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "bash", arguments: { command: "work" } }] } }], model: { provider: "scripted", id: "a" }, thinkingLevel: "low", runtime: { finalized: [], streamingMessage: { role: "assistant", content: [{ type: "text", text: "partial" }] }, pendingToolCalls: ["call"], toolObservations: { call: { status: "running" } }, isStreaming: true } }; }
describe("native context seed", () => {
 it("preserves the synchronous cut and records unfinished work as nonexecuting history", () => {
  const original = cut();const bytes = JSON.stringify(original);const seeded = seedNativeSession(bytes);
  original.model.id = "later";const entries = seeded.jsonl.trim().split("\n").map(s => JSON.parse(s));
  expect(seeded.cut.model.id).toBe("a");expect(entries[0].id).not.toBe("main");
  expect(entries.some(e => e.type === "context_edit" && e.targetId === "a" && e.replacement === null)).toBe(true);
  const observation = entries.find(e => e.customType === "btw-snapshot-frontier");expect(observation.details.status).toContain("not executing");
  expect(entries.filter(e => e.message?.role === "toolResult")).toHaveLength(0);
  expect(entries.at(-2)).toMatchObject({ type: "model_change", modelId: "a" });
 });
 it("rejects missing snapshot contracts instead of reconstructing SDK context", () => { expect(() => seedNativeSession("{}")).toThrow(); });
});
describe("native terminal cells", () => {
 it("decodes child control output into styled cells without leaking cursor movement", async () => {
  const replies: string[] = [];const view = new BtwTerminal(12, 3, s => replies.push(s), { width: 9, height: 18 }, true);
  await view.write("\x1b[31mΩ🙂\x1b[0m\r\nnext\x1b[18t");
  expect(view.render().join("\n")).toContain("Ω");expect(view.render().join("\n")).toContain("🙂");
  expect(replies).toContain("\x1b[8;3;12t");view.resize(9, 4);expect(view.terminal.cols).toBe(9);expect(view.render()).toHaveLength(4);await view.dispose();
 });
});
