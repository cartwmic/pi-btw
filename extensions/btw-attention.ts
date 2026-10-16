import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type AttentionKind = "working" | "done" | "failed" | "needs-input";
export interface AttentionState { state: AttentionKind; seq: number; pid: number; at: number }
export const ATTENTION_KEY = "btw";
export const ATTENTION_TEXT: Record<Exclude<AttentionKind, "working">, string> = { done: "BTW: finished", failed: "BTW: failed", "needs-input": "BTW: needs your input" };
export const attentionFile = (control: string): string => control + ".attention";

export function readAttention(control: string): AttentionState | undefined {
  try {
    const file = attentionFile(control);
    if (!existsSync(file)) return undefined;
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<AttentionState>;
    if (!["working", "done", "failed", "needs-input"].includes(String(value.state)) || !Number.isFinite(value.seq)) return undefined;
    return value as AttentionState;
  } catch { return undefined; }
}

/** Child side. Writes the compact state for the host; the sequence number continues across child restarts so a resumed child is never mistaken for an old event. */
export class ChildAttention {
  private seq: number;
  private failed = false;
  constructor(private readonly control: string, private readonly now: () => number = Date.now, private readonly pid: number = process.pid) { this.seq = readAttention(control)?.seq ?? 0; }
  private write(state: AttentionKind): void {
    const file = attentionFile(this.control), temporary = file + ".tmp";
    writeFileSync(temporary, JSON.stringify({ state, seq: ++this.seq, pid: this.pid, at: this.now() } satisfies AttentionState));renameSync(temporary, file);
  }
  agentStart(): void { this.failed = false;this.write("working"); }
  /** Last assistant turn of the run failed (not aborted). */
  agentEnd(messages: ReadonlyArray<{ role?: string; stopReason?: string }>): void { const last = [...messages].reverse().find(message => message.role === "assistant");this.failed = last?.stopReason === "error"; }
  agentSettled(): void { this.write(this.failed ? "failed" : "done");this.failed = false; }
  promptStart(): void { this.write("needs-input"); }
  promptEnd(): void { this.write("working"); }
}

/** Host side. Pure decision: what to do with the status line given visibility and the child's latest state. Each event (sequence number) is announced at most once; it is marked seen while the popup is visible. */
export class AttentionAnnouncer {
  private lastSeq = 0;
  private shown = false;
  step(visible: boolean, state: AttentionState | undefined): { set?: string; clear?: true } {
    if (visible) { if (state) this.lastSeq = Math.max(this.lastSeq, state.seq);if (this.shown) { this.shown = false;return { clear: true }; } return {}; }
    if (!state || state.seq <= this.lastSeq) return {};
    this.lastSeq = state.seq;
    if (state.state === "working") { if (this.shown) { this.shown = false;return { clear: true }; } return {}; }
    this.shown = true;return { set: ATTENTION_TEXT[state.state] };
  }
}
