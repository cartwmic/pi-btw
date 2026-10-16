import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SUMMARY_LIMITS, SummaryRefusal, boundedSummarize, cappedModel, type SummaryAssistant, type SummaryDeps, type SummarySession } from "../extensions/btw-summary";

type Model = { id: string; maxTokens?: number };
const model: Model = { id: "scripted/m", maxTokens: 128000 };
function rig(reply: SummaryAssistant | undefined | "hang", over: { promptThrows?: Error } = {}) {
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const calls: string[] = [];const opened: Model[] = [];
  const session: SummarySession = {
    prompt: vi.fn(async (text: string) => { calls.push("prompt:" + text.length);if (over.promptThrows) throw over.promptThrows;if (reply === "hang") await new Promise(() => {}); }),
    abort: vi.fn(async () => { calls.push("abort"); }), dispose: vi.fn(() => { calls.push("dispose"); }),
    lastAssistant: () => reply === "hang" ? undefined : reply,
  };
  const deps: SummaryDeps<Model> = { open: vi.fn(async (m: Model) => { opened.push(m);return session; }), setTimer: (fn, ms) => { const t = { fn, ms, cleared: false };timers.push(t);return t; }, clearTimer: h => { (h as { cleared: boolean }).cleared = true; } };
  return { deps, session, timers, calls, opened };
}
const ok: SummaryAssistant = { stopReason: "stop", text: "  the summary  ", usage: { input: 10, output: 5 }, model: "scripted/m" };

describe("cappedModel", () => {
  it("lowers but never raises, does not mutate, and supplies a cap when the model has none", () => {
    expect(cappedModel(model, 2048).maxTokens).toBe(2048);expect(model.maxTokens).toBe(128000);
    expect(cappedModel({ id: "s", maxTokens: 1000 }, 2048).maxTokens).toBe(1000);
    expect(cappedModel({ id: "s" }, 2048).maxTokens).toBe(2048);expect(cappedModel({ id: "s", maxTokens: 0 }, 2048).maxTokens).toBe(2048);
  });
});

describe("boundedSummarize (scripted session; no model is ever called)", () => {
  it("success: the session receives the CAPPED model and the exact input, text is trimmed, usage is reported, session is aborted and disposed, timer cleared", async () => {
    const r = rig(ok);const out = await boundedSummarize(r.deps, model, "THREAD");
    expect(out).toEqual({ text: "the summary", stopReason: "stop", usage: { input: 10, output: 5 }, model: "scripted/m", inputChars: 6, maxTokensSent: DEFAULT_SUMMARY_LIMITS.maxOutputTokens });
    expect(r.opened).toEqual([{ id: "scripted/m", maxTokens: DEFAULT_SUMMARY_LIMITS.maxOutputTokens }]);expect(model.maxTokens).toBe(128000);
    expect(r.calls).toEqual(["prompt:6", "abort", "dispose"]);expect(r.timers).toHaveLength(1);expect(r.timers[0].ms).toBe(DEFAULT_SUMMARY_LIMITS.timeoutMs);expect(r.timers[0].cleared).toBe(true);
  });
  it("input boundary: over the limit is refused BEFORE a session is opened; exactly at the limit is accepted", async () => {
    const limits = { ...DEFAULT_SUMMARY_LIMITS, maxInputChars: 10 };
    const over = rig(ok);await expect(boundedSummarize(over.deps, model, "x".repeat(11), limits)).rejects.toMatchObject({ reason: "too-long" });
    expect(over.deps.open).not.toHaveBeenCalled();expect(over.timers).toHaveLength(0);
    const at = rig(ok);await expect(boundedSummarize(at.deps, model, "x".repeat(10), limits)).resolves.toMatchObject({ inputChars: 10 });
  });
  it("timeout: aborts the session, rejects with reason timeout, still disposes and clears the timer", async () => {
    const r = rig("hang");const pending = boundedSummarize(r.deps, model, "T");const assertion = expect(pending).rejects.toMatchObject({ reason: "timeout" });
    for (let i = 0; i < 50 && r.timers.length === 0; i++) await Promise.resolve();expect(r.timers).toHaveLength(1);r.timers[0].fn();await assertion;
    expect(r.calls).toContain("abort");expect(r.calls.at(-1)).toBe("dispose");expect(r.timers[0].cleared).toBe(true);
  });
  it("stop reasons: length is refused as truncated (never handed off), error carries the provider message, aborted, no response, empty text", async () => {
    const cases: [SummaryAssistant | undefined, string][] = [
      [{ stopReason: "length", text: "partial words" }, "truncated"], [{ stopReason: "error", errorMessage: "overloaded", text: "" }, "error"],
      [{ stopReason: "aborted", text: "" }, "aborted"], [undefined, "no-response"], [{ stopReason: "stop", text: "   " }, "empty"],
    ];
    for (const [reply, reason] of cases) { const r = rig(reply);const error = await boundedSummarize(r.deps, model, "T").catch(e => e);expect(error, reason).toBeInstanceOf(SummaryRefusal);expect(error.reason).toBe(reason);expect(r.calls.at(-1), reason).toBe("dispose"); }
    const e = rig({ stopReason: "error", errorMessage: "overloaded", text: "" });await expect(boundedSummarize(e.deps, model, "T")).rejects.toThrow("overloaded");
  });
  it("a prompt failure propagates unchanged and the session is still torn down", async () => {
    const boom = new Error("socket");const r = rig(ok, { promptThrows: boom });await expect(boundedSummarize(r.deps, model, "T")).rejects.toBe(boom);expect(r.calls.slice(-2)).toEqual(["abort", "dispose"]);
  });
  it("the caller's limits are honoured (cap and timeout reach the model copy and the timer)", async () => {
    const r = rig(ok);await boundedSummarize(r.deps, model, "T", { maxInputChars: 100, maxOutputTokens: 500, timeoutMs: 1234 });
    expect(r.opened[0].maxTokens).toBe(500);expect(r.timers[0].ms).toBe(1234);
  });
});
