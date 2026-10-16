import { describe, expect, it, vi } from "vitest";
import { DELIVER_FOLLOW_UP, DELIVER_STEER, KIND_FULL, KIND_SUMMARY, fullThreadText, menuEntries, messageText, openSeparatelyCommand, separateTerminalNotice, runHandoff, runMenu, sideThreadFromSession, activeBranch, type DialogUi, type Exchange } from "../extensions/btw-menu";
import { READONLY_TOOL_ARGS } from "../extensions/btw-native";

const line = (value: unknown) => JSON.stringify(value);
const msg = (id: string, role: string, text: string, extra: Record<string, unknown> = {}) => line({ type: "message", id, parentId: null, message: { role, content: [{ type: "text", text }], ...extra } });
const header = line({ type: "session", version: 3, id: "s" });

describe("sideThreadFromSession", () => {
  const seeded = [header, msg("a1", "user", "MAIN-SEED-QUESTION"), msg("a2", "assistant", "MAIN-SEED-ANSWER"), line({ type: "thinking_level_change", id: "t1", thinkingLevel: "low" }),
    msg("b1", "user", "side one"), msg("b2", "assistant", "answer one"), msg("b3", "user", "side two"), msg("b4", "assistant", "answer two a"), msg("b5", "assistant", "answer two b")].join("\n");
  it("returns only the side conversation after the seed boundary", () => {
    const { exchanges, scope } = sideThreadFromSession(seeded, "t1");
    expect(scope).toBe("after-seed");expect(JSON.stringify(exchanges)).not.toContain("MAIN-SEED");
    expect(exchanges).toEqual([{ user: "side one", assistant: "answer one" }, { user: "side two", assistant: "answer two a\n\nanswer two b" }]);
  });
  it("negative control: without a boundary the whole session is returned and says so", () => {
    const { exchanges, scope } = sideThreadFromSession(seeded);
    expect(scope).toBe("whole-session");expect(JSON.stringify(exchanges)).toContain("MAIN-SEED-QUESTION");
  });
  it("an unknown boundary id falls back to the whole session, never to an empty or partial thread", () => {
    expect(sideThreadFromSession(seeded, "zzz").scope).toBe("whole-session");
  });
  it("leaves out aborted and failed assistant turns, keeps the user prompt of an answered turn only", () => {
    const text = [header, msg("u1", "user", "q1"), msg("x1", "assistant", "partial", { stopReason: "aborted" }), msg("u2", "user", "q2"), msg("x2", "assistant", "fine", { stopReason: "stop" }), msg("u3", "user", "q3"), msg("x3", "assistant", "", { stopReason: "error" })].join("\n");
    expect(sideThreadFromSession(text).exchanges).toEqual([{ user: "q2", assistant: "fine" }]);
  });
  it("a user prompt with no answer yet is kept with a placeholder; non-message entries and tool results are ignored", () => {
    const text = [header, line({ type: "model_change", id: "m", provider: "p", modelId: "a" }), msg("u1", "user", "waiting"), msg("r1", "toolResult", "ignored")].join("\n");
    expect(sideThreadFromSession(text).exchanges).toEqual([{ user: "waiting", assistant: "(No assistant response)" }]);
  });
  it("blank session: the boundary is its last seed entry, so the thread starts empty", () => {
    const blank = [header, line({ type: "model_change", id: "m1", provider: "p", modelId: "a" }), line({ type: "thinking_level_change", id: "m2", thinkingLevel: "low" })].join("\n");
    expect(sideThreadFromSession(blank, "m2")).toEqual({ exchanges: [], scope: "after-seed" });
  });
  it("messageText handles strings, block lists and non-text blocks", () => {
    expect(messageText({ content: "plain" })).toBe("plain");
    expect(messageText({ content: [{ type: "text", text: "a" }, { type: "image", data: "x" }, { type: "text", text: "b" }] })).toBe("a\nb");
    expect(messageText(undefined)).toBe("");expect(messageText({ content: 5 })).toBe("");
  });
  it("fullThreadText keeps the legacy layout", () => {
    expect(fullThreadText([{ user: " a ", assistant: " b " }, { user: "c", assistant: "d" }])).toBe("User: a\nAssistant: b\n\n---\n\nUser: c\nAssistant: d");
  });
});

describe("menuEntries", () => {
  it("no session: the three starts only", () => { expect(menuEntries({ live: false }).map(e => e.id)).toEqual(["new-contextual", "new-blank", "new-readonly"]); });
  it("saved session: reopen, handoff, open separately, and the starts that keep the saved one", () => {
    const entries = menuEntries({ mode: "readonly", live: false });
    expect(entries.map(e => e.id)).toEqual(["reopen", "handoff", "open-separately", "new-contextual", "new-blank", "new-readonly"]);
    expect(entries[0].label).toContain("readonly");expect(entries[0].label).toContain("/btw:ask");expect(entries.at(-1)!.label).toContain("keeps the saved one");
  });
  it("live child: no new-session entries (a second child would be refused)", () => {
    expect(menuEntries({ mode: "blank", live: true }).map(e => e.id)).toEqual(["reopen", "handoff", "open-separately"]);
  });
});

function ui(script: { select?: (string | undefined)[]; editor?: (string | undefined)[] } = {}) {
  const select = [...(script.select ?? [])], editor = [...(script.editor ?? [])];
  const calls: { kind: string; title: string; options?: string[]; prefill?: string }[] = [];const notices: [string, string | undefined][] = [];
  const api: DialogUi = {
    select: async (title, options) => { calls.push({ kind: "select", title, options });return select.shift(); },
    editor: async (title, prefill) => { calls.push({ kind: "editor", title, prefill });return editor.shift(); },
    notify: (message, type) => { notices.push([message, type]); },
  };
  return { api, calls, notices };
}
const thread: Exchange[] = [{ user: "q", assistant: "a" }];
function deps(over: Partial<Parameters<typeof runHandoff>[0]> & { script?: Parameters<typeof ui>[0] } = {}) {
  const u = ui(over.script);const send = vi.fn(), summarize = vi.fn(async () => "SUMMARY TEXT"), readThread = vi.fn(() => thread);
  return { u, send, summarize, readThread, d: { ui: u.api, isIdle: () => true, send, readThread, summarize, ...over } as Parameters<typeof runHandoff>[0] };
}

describe("runHandoff (scripted summarizer; no model is ever called)", () => {
  it("summary default, edited text is what is sent, idle main gets a plain send", async () => {
    const x = deps({ script: { select: [KIND_SUMMARY], editor: ["EDITED"] } });
    const result = await runHandoff(x.d);
    expect(result).toEqual({ sent: true, kind: "summary", deliverAs: undefined, text: "EDITED" });
    expect(x.send).toHaveBeenCalledExactlyOnceWith("EDITED", undefined);expect(x.summarize).toHaveBeenCalledExactlyOnceWith(thread);
    expect(x.u.calls.map(c => c.kind)).toEqual(["select", "editor"]);expect(x.u.calls[1].prefill).toBe("SUMMARY TEXT");
    expect(x.u.calls[0].options).toEqual([KIND_SUMMARY, KIND_FULL]);
  });
  it("full thread makes no summarizer call and prefills the deterministic text", async () => {
    const x = deps({ script: { select: [KIND_FULL], editor: ["x"] } });
    await runHandoff(x.d);
    expect(x.summarize).not.toHaveBeenCalled();expect(x.u.calls[1].prefill).toBe(fullThreadText(thread));
  });
  it("busy main asks follow-up or steer; follow-up is the first option; each maps to its deliverAs", async () => {
    for (const [choice, expected] of [[DELIVER_FOLLOW_UP, "followUp"], [DELIVER_STEER, "steer"]] as const) {
      const x = deps({ isIdle: () => false, script: { select: [KIND_FULL, choice], editor: ["go"] } });
      expect(await runHandoff(x.d)).toMatchObject({ sent: true, deliverAs: expected });
      expect(x.send).toHaveBeenCalledExactlyOnceWith("go", expected);expect(x.u.calls[2].options).toEqual([DELIVER_FOLLOW_UP, DELIVER_STEER]);
    }
  });
  it("cancel at every step sends nothing and never touches the thread reader result", async () => {
    const steps: { name: string; over: Parameters<typeof deps>[0]; reason: string }[] = [
      { name: "kind", over: { script: { select: [undefined] } }, reason: "cancelled" },
      { name: "editor undefined", over: { script: { select: [KIND_FULL], editor: [undefined] } }, reason: "cancelled" },
      { name: "editor blank", over: { script: { select: [KIND_FULL], editor: ["   "] } }, reason: "empty" },
      { name: "delivery", over: { isIdle: () => false, script: { select: [KIND_FULL, undefined], editor: ["go"] } }, reason: "cancelled" },
    ];
    for (const step of steps) { const x = deps(step.over);const r = await runHandoff(x.d);expect(r, step.name).toEqual({ sent: false, reason: step.reason });expect(x.send, step.name).not.toHaveBeenCalled(); }
  });
  it("empty side thread: warns and asks nothing", async () => {
    const x = deps({ readThread: () => [] });expect(await runHandoff(x.d)).toEqual({ sent: false, reason: "no-thread" });
    expect(x.u.calls).toEqual([]);expect(x.u.notices[0][1]).toBe("warning");expect(x.send).not.toHaveBeenCalled();
  });
  it("summary failure or empty summary: error notice, no editor, nothing sent", async () => {
    for (const summarize of [vi.fn(async () => { throw new Error("route down"); }), vi.fn(async () => "  ")]) {
      const x = deps({ summarize, script: { select: [KIND_SUMMARY] } });
      expect(await runHandoff(x.d)).toEqual({ sent: false, reason: "summary-failed" });expect(x.u.calls.map(c => c.kind)).toEqual(["select"]);expect(x.send).not.toHaveBeenCalled();expect(x.u.notices.at(-1)![1]).toBe("error");
    }
  });
  it("sending happens exactly once and only after the final confirmation (order check)", async () => {
    const order: string[] = [];const u = ui({ select: [KIND_FULL, DELIVER_STEER], editor: ["t"] });
    const d = { ui: { select: async (a: string, b: string[]) => { order.push("select");return u.api.select(a, b); }, editor: async (a: string, b?: string) => { order.push("editor");return u.api.editor(a, b); }, notify: u.api.notify }, isIdle: () => false, send: () => { order.push("send"); }, readThread: () => thread, summarize: async () => "s" };
    await runHandoff(d);expect(order).toEqual(["select", "editor", "select", "send"]);
  });
});

describe("runMenu", () => {
  function menuDeps(state: Parameters<typeof menuEntries>[0], choiceLabel: string | undefined) {
    const u = ui({ select: [choiceLabel] });
    const d = { reopen: vi.fn(async () => {}), startNew: vi.fn(async () => {}), handoff: vi.fn(async () => {}), openSeparately: vi.fn((): string | undefined => "pi --session x") };
    return { u, d, deps: { ui: u.api, state: () => state, ...d } };
  }
  it("each entry calls exactly its action", async () => {
    const saved = { mode: "blank" as const, live: false };
    for (const [label, call, args] of [["New contextual session (keeps the saved one)", "startNew", ["contextual"]], ["New blank session (keeps the saved one)", "startNew", ["blank"]], ["New read-only session (keeps the saved one)", "startNew", ["readonly"]], ["Hand off to main", "handoff", []], ["Reopen blank session (/btw:tangent)", "reopen", []]] as const) {
      const m = menuDeps(saved, label);await runMenu(m.deps);
      for (const [name, fn] of Object.entries(m.d)) if (name === call) expect(fn).toHaveBeenCalledExactlyOnceWith(...args);else if (name !== "openSeparately") expect(fn, label + " must not call " + name).not.toHaveBeenCalled();
    }
  });
  it("open separately notifies the exact command and starts nothing; none saved warns", async () => {
    const m = menuDeps({ mode: "readonly", live: false }, "Open separately");expect(await runMenu(m.deps)).toEqual({ action: "open-separately" });
    expect(m.u.notices[0][0]).toContain("pi --session x");expect(m.d.startNew).not.toHaveBeenCalled();
    const none = menuDeps({ mode: "readonly", live: false }, "Open separately");none.d.openSeparately.mockReturnValue(undefined);await runMenu(none.deps);expect(none.u.notices[0][1]).toBe("warning");
  });
  it("open separately while the popup child is live asks to quit it first and still shows the command (review P2-1)", async () => {
    const m = menuDeps({ mode: "blank", live: true }, "Open separately");await runMenu(m.deps);
    expect(m.u.notices[0][0]).toContain("Quit the popup child first");expect(m.u.notices[0][0]).toContain("pi --session x");expect(m.u.notices[0][1]).toBe("info");
    const saved = menuDeps({ mode: "blank", live: false }, "Open separately");await runMenu(saved.deps);
    expect(saved.u.notices[0][0]).not.toContain("Quit the popup child first");expect(saved.u.notices[0][0]).toContain("Continue this BTW session in its own terminal:");
  });
  it("separateTerminalNotice: none saved warns; live and saved differ; a custom lead is kept only when not live", () => {
    expect(separateTerminalNotice(undefined, true)).toEqual({ message: "No saved BTW session to open.", type: "warning" });
    expect(separateTerminalNotice("pi x", true, "LEAD").message).toBe("Quit the popup child first (/quit in the popup); two Pi processes must not share one session file. Then continue it in its own terminal:\npi x");
    expect(separateTerminalNotice("pi x", false, "LEAD")).toEqual({ message: "LEAD\npi x", type: "info" });
  });
  it("cancel or an unknown label does nothing", async () => {
    for (const label of [undefined, "Not an entry"]) { const m = menuDeps({ live: false }, label);expect(await runMenu(m.deps)).toEqual({ action: "cancelled" });for (const fn of Object.values(m.d)) expect(fn).not.toHaveBeenCalled(); }
  });
});

describe("sideThreadFromSession follows the active branch (review: /tree branching residual)", () => {
  // Written by the real Pi SessionManager (appendMessage x4, branch(), appendMessage x2): Q2/A2 are abandoned, Q3/A3 are current.
  const real = "{\"type\":\"session\",\"version\":3,\"id\":\"01a14322-1938-75e9-8c82-2c630793d46a\",\"timestamp\":\"2026-10-16T05:14:30.585Z\",\"cwd\":\"/tmp/proj\"}\n{\"type\":\"message\",\"id\":\"a60abb78\",\"parentId\":null,\"timestamp\":\"2026-10-16T05:14:30.586Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Q1\"}],\"timestamp\":1792127670586}}\n{\"type\":\"message\",\"id\":\"5a51052b\",\"parentId\":\"a60abb78\",\"timestamp\":\"2026-10-16T05:14:30.586Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"A1\"}],\"stopReason\":\"stop\",\"api\":\"x\",\"provider\":\"x\",\"model\":\"x\",\"usage\":{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"totalTokens\":0,\"cost\":{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"total\":0}},\"timestamp\":1792127670586}}\n{\"type\":\"message\",\"id\":\"2b13d09c\",\"parentId\":\"5a51052b\",\"timestamp\":\"2026-10-16T05:14:30.586Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Q2-ABANDONED\"}],\"timestamp\":1792127670586}}\n{\"type\":\"message\",\"id\":\"4ede1b05\",\"parentId\":\"2b13d09c\",\"timestamp\":\"2026-10-16T05:14:30.586Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"A2-ABANDONED\"}],\"stopReason\":\"stop\",\"api\":\"x\",\"provider\":\"x\",\"model\":\"x\",\"usage\":{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"totalTokens\":0,\"cost\":{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"total\":0}},\"timestamp\":1792127670586}}\n{\"type\":\"message\",\"id\":\"cd2ff282\",\"parentId\":\"5a51052b\",\"timestamp\":\"2026-10-16T05:14:30.586Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Q3-CURRENT\"}],\"timestamp\":1792127670586}}\n{\"type\":\"message\",\"id\":\"6332bc17\",\"parentId\":\"cd2ff282\",\"timestamp\":\"2026-10-16T05:14:30.586Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"A3-CURRENT\"}],\"stopReason\":\"stop\",\"api\":\"x\",\"provider\":\"x\",\"model\":\"x\",\"usage\":{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"totalTokens\":0,\"cost\":{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"total\":0}},\"timestamp\":1792127670586}}\n";
  it("a real branched session file hands off only the active branch", () => {
    const thread = sideThreadFromSession(real);
    expect(thread.exchanges.map(e => e.user)).toEqual(["Q1", "Q3-CURRENT"]);
    expect(fullThreadText(thread.exchanges)).not.toContain("ABANDONED");
  });
  it("a seed boundary on the active branch still cuts; a seed that sits on an abandoned branch excludes its own ancestors only", () => {
    const lines = real.split("\n").filter(Boolean).map(l => JSON.parse(l));
    const a1 = lines[2].id, abandonedUser = lines[3].id;
    expect(sideThreadFromSession(real, a1)).toMatchObject({ scope: "after-seed", exchanges: [{ user: "Q3-CURRENT" }] });
    expect(sideThreadFromSession(real, abandonedUser)).toMatchObject({ scope: "after-seed", exchanges: [{ user: "Q3-CURRENT" }] });
    expect(sideThreadFromSession(real, "not-in-file").scope).toBe("whole-session");
  });
  it("branching INSIDE the inherited seed never hands main's own conversation back (review r12f P2-1)", () => {
    const m = (id: string, parentId: string | null, role: string, text: string) => JSON.stringify({ type: "message", id, parentId, message: { role, content: [{ type: "text", text }], ...(role === "assistant" ? { stopReason: "stop" } : {}) } });
    const header = JSON.stringify({ type: "session", id: "sess", cwd: "/p" });
    // seed = S1 S2 S3 (main's conversation); side turns Q1/A1 hang off S3; the user then navigates to S2 and asks Q2.
    const file = [header, m("S1", null, "user", "MAIN-ONE"), m("S2", "S1", "assistant", "MAIN-ANSWER"), m("S3", "S2", "user", "MAIN-FRONTIER"), m("Q1", "S3", "user", "SIDE-Q1"), m("A1", "Q1", "assistant", "SIDE-A1"), m("Q2", "S2", "user", "SIDE-Q2"), m("A2", "Q2", "assistant", "SIDE-A2")].join("\n");
    const t = sideThreadFromSession(file, "S3");
    expect(t.scope).toBe("after-seed");expect(t.exchanges.map(e => e.user)).toEqual(["SIDE-Q2"]);
    expect(fullThreadText(t.exchanges)).not.toContain("MAIN-");
    // navigating to the very first seed message and continuing from a new root
    const root = [header, m("S1", null, "user", "MAIN-ONE"), m("S2", "S1", "assistant", "MAIN-ANSWER"), m("Q1", "S2", "user", "SIDE-Q1"), m("A1", "Q1", "assistant", "SIDE-A1"), m("Q9", null, "user", "SIDE-Q9"), m("A9", "Q9", "assistant", "SIDE-A9")].join("\n");
    expect(sideThreadFromSession(root, "S2").exchanges.map(e => e.user)).toEqual(["SIDE-Q9"]);
    // no navigation: unchanged behaviour
    const linear = [header, m("S1", null, "user", "MAIN-ONE"), m("S2", "S1", "assistant", "MAIN-ANSWER"), m("Q1", "S2", "user", "SIDE-Q1"), m("A1", "Q1", "assistant", "SIDE-A1")].join("\n");
    expect(sideThreadFromSession(linear, "S2")).toMatchObject({ scope: "after-seed", exchanges: [{ user: "SIDE-Q1" }] });
    // files without parent links keep the index cut
    const flat = [header, JSON.stringify({ type: "message", id: "a", message: { role: "user", content: [{ type: "text", text: "OLD-SEED" }] } }), JSON.stringify({ type: "message", id: "b", message: { role: "user", content: [{ type: "text", text: "SIDE" }] } })].join("\n");
    expect(sideThreadFromSession(flat, "a")).toMatchObject({ scope: "after-seed", exchanges: [{ user: "SIDE" }] });
  });
  it("activeBranch: linear files and files without parent links are unchanged; dangling parent and cycles terminate", () => {
    const linear = [{ id: "a", parentId: null }, { id: "b", parentId: "a" }, { id: "c", parentId: "b" }];
    expect(activeBranch(linear)).toEqual(linear);
    const flat = [{ id: "a" }, { id: "b" }];
    expect(activeBranch(flat)).toBe(flat);
    expect(activeBranch([{ id: "x", parentId: "gone" }, { id: "y", parentId: "x" }]).map(e => e.id)).toEqual(["x", "y"]);
    expect(activeBranch([{ id: "p", parentId: "q" }, { id: "q", parentId: "p" }]).length).toBeLessThanOrEqual(2);
  });
});

describe("openSeparatelyCommand", () => {
  it("contextual and blank: ordinary pi with the session dir and id", () => {
    expect(openSeparatelyCommand({ sessionFile: "/a/b/s1/session.jsonl", id: "id-1", mode: "blank" })).toBe("pi --session-dir /a/b/s1 --session id-1");
  });
  it("read-only keeps its tool restriction (a separate terminal must not widen it)", () => {
    const command = openSeparatelyCommand({ sessionFile: "/a/s/session.jsonl", id: "id-2", mode: "readonly" });
    expect(command).toContain("--tools read,grep,find,ls");expect(command).toContain("--exclude-tools");for (const arg of READONLY_TOOL_ARGS) expect(command).toContain(arg.includes("*") ? "'" + arg + "'" : arg);
  });
  it("quotes paths with spaces and single quotes", () => {
    expect(openSeparatelyCommand({ sessionFile: "/a b/it's/session.jsonl", id: "i" })).toBe("pi --session-dir '/a b/it'\\''s' --session i");
  });
});
