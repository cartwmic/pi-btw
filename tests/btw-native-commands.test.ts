import { describe, expect, it, vi } from "vitest";
import { DELIVER_STEER, KIND_FULL, NATIVE_CLEAR_HINT, nativeLegacyRoute, runHandoff, type DialogUi, type Exchange } from "../extensions/btw-menu";

const ALL = { tui: true, hasNative: true, sdkThreadEmpty: true };
describe("nativeLegacyRoute (PF1: legacy SDK commands on a native session)", () => {
  it("routes exactly the four commands, each to its own action", () => {
    expect(nativeLegacyRoute("btw:inject", ALL)).toEqual({ action: "handoff", kind: "full" });
    expect(nativeLegacyRoute("btw:summarize", ALL)).toEqual({ action: "handoff", kind: "summary" });
    expect(nativeLegacyRoute("btw:promote", ALL)).toEqual({ action: "open-separately" });
    expect(nativeLegacyRoute("btw:clear", ALL)).toEqual({ action: "hint", message: NATIVE_CLEAR_HINT });
  });
  it("any condition false = legacy path (undefined), for every one of the four commands", () => {
    for (const name of ["btw:inject", "btw:summarize", "btw:promote", "btw:clear"]) {
      expect(nativeLegacyRoute(name, { ...ALL, tui: false }), name + " not tui").toBeUndefined();
      expect(nativeLegacyRoute(name, { ...ALL, hasNative: false }), name + " no native session").toBeUndefined();
      expect(nativeLegacyRoute(name, { ...ALL, sdkThreadEmpty: false }), name + " SDK thread in use").toBeUndefined();
    }
  });
  it("other commands are never routed", () => {
    for (const name of ["btw", "side", "btw:new", "btw:tangent", "btw:ask", "btw:model", "btw:thinking", "btw:unknown", ""]) expect(nativeLegacyRoute(name, ALL), name).toBeUndefined();
  });
  it("the clear hint tells the owner what to do instead and does not promise a clear", () => {
    expect(NATIVE_CLEAR_HINT).toContain("/btw menu");expect(NATIVE_CLEAR_HINT).toContain("saved one is kept");expect(NATIVE_CLEAR_HINT).toContain("not cleared");
  });
});

const thread: Exchange[] = [{ user: "q", assistant: "a" }];
function rig(over: Partial<Parameters<typeof runHandoff>[0]> & { select?: (string | undefined)[]; editor?: (string | undefined)[] } = {}) {
  const select = [...(over.select ?? [])], editor = [...(over.editor ?? [])];
  const prompts: { kind: string; title: string; options?: string[]; prefill?: string }[] = [];
  const ui: DialogUi = { select: async (title, options) => { prompts.push({ kind: "select", title, options });return select.shift(); }, editor: async (title, prefill) => { prompts.push({ kind: "editor", title, prefill });return editor.shift(); }, notify: vi.fn() };
  const send = vi.fn(), summarize = vi.fn(async () => "SUMMARY");
  return { prompts, send, summarize, deps: { ui, isIdle: () => true, send, readThread: () => thread, summarize, ...over } as Parameters<typeof runHandoff>[0] };
}
describe("runHandoff kind and preface (used by /btw:inject and /btw:summarize)", () => {
  it("kind full: no kind question, no summarizer call, editor prefilled with preface + blank line + full thread, send once", async () => {
    const r = rig({ kind: "full", preface: "LEAD", editor: ["OK"] });
    expect(await runHandoff(r.deps)).toMatchObject({ sent: true, kind: "full", text: "OK" });
    expect(r.prompts.map(p => p.kind)).toEqual(["editor"]);expect(r.prompts[0].prefill).toBe("LEAD\n\nUser: q\nAssistant: a");
    expect(r.summarize).not.toHaveBeenCalled();expect(r.send).toHaveBeenCalledExactlyOnceWith("OK", undefined);
  });
  it("kind summary: no kind question, summarizer called once, preface precedes the summary", async () => {
    const r = rig({ kind: "summary", preface: "LEAD", editor: ["OK"] });
    await runHandoff(r.deps);
    expect(r.prompts.map(p => p.kind)).toEqual(["editor"]);expect(r.prompts[0].prefill).toBe("LEAD\n\nSUMMARY");expect(r.summarize).toHaveBeenCalledExactlyOnceWith(thread);
  });
  it("without kind and preface nothing changes: the kind question is asked and the prefill is the bare proposal", async () => {
    const r = rig({ select: [KIND_FULL], editor: ["OK"] });
    await runHandoff(r.deps);
    expect(r.prompts.map(p => p.kind)).toEqual(["select", "editor"]);expect(r.prompts[1].prefill).toBe("User: q\nAssistant: a");
  });
  it("busy main still asks follow-up or steer after the editor; cancelling the editor sends nothing even with a preface", async () => {
    const busy = rig({ kind: "full", preface: "LEAD", isIdle: () => false, select: [DELIVER_STEER], editor: ["go"] });
    expect(await runHandoff(busy.deps)).toMatchObject({ sent: true, deliverAs: "steer" });
    const cancelled = rig({ kind: "full", preface: "LEAD", editor: [undefined] });
    expect(await runHandoff(cancelled.deps)).toEqual({ sent: false, reason: "cancelled" });expect(cancelled.send).not.toHaveBeenCalled();
  });
  it("summary failure with kind summary: error, no editor, nothing sent", async () => {
    const r = rig({ kind: "summary", preface: "LEAD", summarize: async () => { throw new Error("down"); } });
    expect(await runHandoff(r.deps)).toEqual({ sent: false, reason: "summary-failed" });expect(r.prompts).toEqual([]);expect(r.send).not.toHaveBeenCalled();
  });
});
