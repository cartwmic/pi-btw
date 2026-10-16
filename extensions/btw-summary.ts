/**
 * Bounded summarizer for the BTW handoff. Pure: the session and the model are injected, so every limit is testable without a model call.
 * Wired into btw.ts summarizeThread (boundedSummarize). The timer wraps session.prompt only; settings, auth lookup and session creation are outside it (review P3-3).
 * Limits are the proposed defaults; none of them needs a model to be chosen.
 */
export interface SummaryLimits { maxInputChars: number; maxOutputTokens: number; timeoutMs: number }
/** Output default leaves room for adaptive thinking, which shares max_tokens on the registered Claude models (read from source, unobserved). */
export const DEFAULT_SUMMARY_LIMITS: SummaryLimits = { maxInputChars: 24000, maxOutputTokens: 2048, timeoutMs: 60000 };

export interface SummaryAssistant { stopReason?: string; errorMessage?: string; text: string; usage?: { input?: number; output?: number }; model?: string }
export interface SummarySession {
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  lastAssistant(): SummaryAssistant | undefined;
}
export interface SummaryDeps<M extends { maxTokens?: number }> {
  /** Open one in-memory, tool-less session on exactly this (already capped) model. */
  open(model: M): Promise<SummarySession>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}
export class SummaryRefusal extends Error { constructor(readonly reason: "too-long" | "timeout" | "truncated" | "empty" | "no-response" | "error" | "aborted", message: string) { super(message); } }
export interface SummaryOutcome { text: string; stopReason?: string; usage?: { input?: number; output?: number }; model?: string; inputChars: number; maxTokensSent: number }

/** A copy of the model whose maxTokens cannot exceed the cap. The original object is never mutated. */
export function cappedModel<M extends { maxTokens?: number }>(model: M, maxOutputTokens: number): M {
  const current = model.maxTokens;
  return { ...model, maxTokens: typeof current === "number" && current > 0 ? Math.min(current, maxOutputTokens) : maxOutputTokens };
}

export async function boundedSummarize<M extends { maxTokens?: number }>(deps: SummaryDeps<M>, model: M, inputText: string, limits: SummaryLimits = DEFAULT_SUMMARY_LIMITS): Promise<SummaryOutcome> {
  // Input boundary first: fail closed BEFORE any session or model exists.
  if (inputText.length > limits.maxInputChars) throw new SummaryRefusal("too-long", "The BTW thread is " + inputText.length + " characters; the summary limit is " + limits.maxInputChars + ". Hand off the full thread instead.");
  const sent = cappedModel(model, limits.maxOutputTokens);
  const session = await deps.open(sent);
  let timer: unknown;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = deps.setTimer(() => { void session.abort().catch(() => {}); reject(new SummaryRefusal("timeout", "BTW summary timed out after " + limits.timeoutMs + " ms.")); }, limits.timeoutMs); });
    await Promise.race([session.prompt(inputText), timeout]);
    const reply = session.lastAssistant();
    if (!reply) throw new SummaryRefusal("no-response", "BTW summarize finished without a response.");
    if (reply.stopReason === "error") throw new SummaryRefusal("error", reply.errorMessage || "Failed to summarize BTW thread.");
    if (reply.stopReason === "aborted") throw new SummaryRefusal("aborted", "BTW summarize aborted.");
    if (reply.stopReason === "length") throw new SummaryRefusal("truncated", "The summary hit the " + limits.maxOutputTokens + "-token cap and was cut off; nothing was handed off.");
    const text = reply.text.trim();
    if (!text) throw new SummaryRefusal("empty", "BTW summary was empty.");
    return { text, stopReason: reply.stopReason, usage: reply.usage, model: reply.model, inputChars: inputText.length, maxTokensSent: sent.maxTokens as number };
  } finally {
    if (timer !== undefined) deps.clearTimer(timer);
    try { await session.abort(); } catch { /* shutdown */ }
    session.dispose();
  }
}
