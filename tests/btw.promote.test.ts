import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { findBalancedLeafId, writePromotedBtwSession } from "../extensions/btw";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
const assistant = (text: string): AssistantMessage => ({
  role: "assistant", content: [{ type: "text", text }], provider: "test", model: "m", api: "openai-responses", usage, stopReason: "stop", timestamp: Date.now(),
});

function readEntries(file: string): any[] {
  return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

describe("findBalancedLeafId", () => {
  const msg = (id: string, message: any) => ({ id, type: "message", message });
  const toolCall = (id: string) => ({ ...assistant(""), content: [{ type: "toolCall", id, name: "read", arguments: {} }] });
  const toolResult = (id: string) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [], isError: false, timestamp: 0 });

  it("returns the leaf when the branch is balanced", () => {
    expect(findBalancedLeafId([msg("u", user("q")), msg("a", assistant("a")), { id: "c", type: "custom" }])).toBe("c");
  });

  it("backs off past a tool call that has no result yet", () => {
    expect(findBalancedLeafId([msg("u", user("q")), msg("a", assistant("a")), msg("u2", user("q2")), msg("t", toolCall("x"))])).toBe("a");
  });

  it("accepts the point after every tool result arrives", () => {
    expect(findBalancedLeafId([msg("u", user("q")), msg("t", toolCall("x")), msg("r", toolResult("x"))])).toBe("r");
  });

  it("backs off past an unanswered user prompt", () => {
    expect(findBalancedLeafId([msg("u", user("q")), msg("a", assistant("a")), msg("u2", user("q2"))])).toBe("a");
  });

  it("returns null for an empty branch", () => {
    expect(findBalancedLeafId([])).toBeNull();
  });
});

describe("writePromotedBtwSession", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function mainSession() {
    dir = mkdtempSync(join(tmpdir(), "btw-promote-"));
    const main = SessionManager.create(dir, dir);
    main.appendMessage(user("main question"));
    const keep = main.appendMessage(assistant("main answer"));
    main.appendCustomEntry("btw-thread-entry", { question: "side q", answer: "side a" });
    main.branch(keep);
    main.appendMessage(user("abandoned branch"));
    main.appendMessage(assistant("abandoned answer"));
    main.branch(keep);
    const leaf = main.appendCustomEntry("btw-thread-entry", { question: "side q", answer: "side a" });
    return { main, leaf };
  }

  it("forks the main branch, resets the hidden BTW thread, and appends the side messages", () => {
    const { main, leaf } = mainSession();
    const file = writePromotedBtwSession({
      cwd: dir, sessionDir: dir, mainSessionFile: main.getSessionFile()!, mainLeafId: leaf,
      messages: [user("side q"), assistant("side a")],
    });

    const entries = readEntries(file);
    expect(entries[0]).toMatchObject({ type: "session", parentSession: main.getSessionFile() });
    const texts = entries.filter((e) => e.type === "message").map((e) => e.message.content[0].text);
    expect(texts).toEqual(["main question", "main answer", "side q", "side a"]);

    const reopened = SessionManager.open(file);
    const branch = reopened.getBranch();
    const lastEntry = branch.findLastIndex((e: any) => e.type === "custom" && e.customType === "btw-thread-entry");
    const reset = branch.findLastIndex((e: any) => e.type === "custom" && e.customType === "btw-thread-reset");
    expect(reset).toBeGreaterThan(lastEntry);
    expect(reopened.buildSessionContext().messages.map((m: any) => m.content[0].text)).toEqual(["main question", "main answer", "side q", "side a"]);
  });

  it("writes only the side thread when there is no main leaf (tangent)", () => {
    const { main } = mainSession();
    const file = writePromotedBtwSession({
      cwd: dir, sessionDir: dir, mainSessionFile: main.getSessionFile()!, mainLeafId: null,
      messages: [user("tangent q"), assistant("tangent a")],
    });
    const entries = readEntries(file);
    expect(entries[0]).toMatchObject({ type: "session", parentSession: main.getSessionFile() });
    expect(entries.filter((e) => e.type === "message").map((e) => e.message.content[0].text)).toEqual(["tangent q", "tangent a"]);
  });

  it("records the thread mode in the reset entry", () => {
    const { main, leaf } = mainSession();
    const file = writePromotedBtwSession({
      cwd: dir, sessionDir: dir, mainSessionFile: main.getSessionFile()!, mainLeafId: leaf, mode: "readonly",
      messages: [user("q"), assistant("a")],
    });
    const reset = readEntries(file).find((e) => e.type === "custom" && e.customType === "btw-thread-reset");
    expect(reset.data.mode).toBe("readonly");
  });

  it("refuses an empty thread", () => {
    const { main, leaf } = mainSession();
    expect(() => writePromotedBtwSession({ cwd: dir, sessionDir: dir, mainSessionFile: main.getSessionFile()!, mainLeafId: leaf, messages: [] }))
      .toThrow("No BTW thread available to promote.");
  });
});
