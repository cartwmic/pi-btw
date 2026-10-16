import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ATTENTION_TEXT, AttentionAnnouncer, ChildAttention, attentionFile, readAttention, type AttentionState } from "../extensions/btw-attention";

const control = () => join(mkdtempSync(join(tmpdir(), "btw-att-")), "host-control.json");
const st = (state: AttentionState["state"], seq: number): AttentionState => ({ state, seq, pid: 1, at: 0 });

describe("ChildAttention (child side)", () => {
  it("settled run -> done; failed last turn -> failed; aborted is not failed; a new run resets failure", () => {
    const c = control();const child = new ChildAttention(c, () => 5, 42);
    child.agentStart();expect(readAttention(c)).toEqual({ state: "working", seq: 1, pid: 42, at: 5 });
    child.agentEnd([{ role: "user" }, { role: "assistant", stopReason: "stop" }]);child.agentSettled();expect(readAttention(c)).toMatchObject({ state: "done", seq: 2 });
    child.agentStart();child.agentEnd([{ role: "assistant", stopReason: "error" }]);child.agentSettled();expect(readAttention(c)).toMatchObject({ state: "failed", seq: 4 });
    child.agentStart();child.agentEnd([{ role: "assistant", stopReason: "aborted" }]);child.agentSettled();expect(readAttention(c)).toMatchObject({ state: "done", seq: 6 });
  });
  it("only the LAST assistant message decides failure", () => {
    const c = control();const child = new ChildAttention(c);child.agentStart();
    child.agentEnd([{ role: "assistant", stopReason: "error" }, { role: "user" }, { role: "assistant", stopReason: "stop" }]);child.agentSettled();expect(readAttention(c)!.state).toBe("done");
  });
  it("prompts: needs-input while a blocking prompt is open, working again when it ends", () => {
    const c = control();const child = new ChildAttention(c);child.promptStart();expect(readAttention(c)!.state).toBe("needs-input");child.promptEnd();expect(readAttention(c)!.state).toBe("working");
  });
  it("sequence numbers continue across a restarted child (resume) and the write is atomic (no .tmp left)", () => {
    const c = control();new ChildAttention(c).agentStart();const second = new ChildAttention(c);second.agentStart();
    expect(readAttention(c)!.seq).toBe(2);expect(() => readFileSync(attentionFile(c) + ".tmp")).toThrow();
  });
});

describe("readAttention", () => {
  it("is undefined for a missing, unparsable or malformed file", () => {
    const c = control();expect(readAttention(c)).toBeUndefined();
    writeFileSync(attentionFile(c), "{not json");expect(readAttention(c)).toBeUndefined();
    writeFileSync(attentionFile(c), JSON.stringify({ state: "bogus", seq: 1 }));expect(readAttention(c)).toBeUndefined();
    writeFileSync(attentionFile(c), JSON.stringify({ state: "done" }));expect(readAttention(c)).toBeUndefined();
  });
});

describe("AttentionAnnouncer (host side; quiet, non-repeating)", () => {
  it("visible popup: nothing is announced and events are marked seen", () => {
    const a = new AttentionAnnouncer();expect(a.step(true, st("done", 3))).toEqual({});
    expect(a.step(false, st("done", 3))).toEqual({});   // seen while visible: still not announced after hiding
  });
  it("hidden: done, failed and needs-input each announce once, with the compact text", () => {
    for (const kind of ["done", "failed", "needs-input"] as const) {
      const a = new AttentionAnnouncer();expect(a.step(false, st(kind, 1))).toEqual({ set: ATTENTION_TEXT[kind] });
      expect(a.step(false, st(kind, 1))).toEqual({});expect(a.step(false, st(kind, 1))).toEqual({});   // no repeat for the same event
    }
  });
  it("a newer event announces again; working clears the status", () => {
    const a = new AttentionAnnouncer();a.step(false, st("done", 1));
    expect(a.step(false, st("working", 2))).toEqual({ clear: true });expect(a.step(false, st("working", 2))).toEqual({});
    expect(a.step(false, st("failed", 3))).toEqual({ set: ATTENTION_TEXT.failed });
  });
  it("reopening clears a shown status and marks the event seen", () => {
    const a = new AttentionAnnouncer();a.step(false, st("needs-input", 1));
    expect(a.step(true, st("needs-input", 1))).toEqual({ clear: true });expect(a.step(true, st("needs-input", 1))).toEqual({});expect(a.step(false, st("needs-input", 1))).toEqual({});
  });
  it("no state file yet: nothing", () => { expect(new AttentionAnnouncer().step(false, undefined)).toEqual({}); });
  it("working never announces by itself", () => { expect(new AttentionAnnouncer().step(false, st("working", 1))).toEqual({}); });
});
