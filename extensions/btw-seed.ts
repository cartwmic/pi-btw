import { randomUUID } from "node:crypto";

type Entry = { id: string; parentId: string | null; type: string; message?: any; [key: string]: any };
export interface ConversationCut {
  version: number; kind: string; source: { header: Record<string, unknown>; sessionFile?: string; cwd: string; leafId: string | null };
  branch: Entry[]; model: { provider: string; id: string }; thinkingLevel: string;
  runtime: { finalized: { entryId: string | null; message: any }[]; streamingMessage: unknown; pendingToolCalls: string[]; toolObservations: unknown; isStreaming: boolean };
}
/** Already serialized synchronous cut. Never reread main after an asynchronous boundary. */
function parseCut(bytes: string): ConversationCut {
  const cut = JSON.parse(bytes) as ConversationCut;
  if (cut.version !== 1 || cut.kind !== "pi-conversation-snapshot" || !Array.isArray(cut.branch) || !cut.model?.provider || !cut.model.id) throw new Error("Unsupported native /btw conversation capture");
  return cut;
}
/** Blank native session: the cut's cwd, model and thinking level only. No inherited conversation, frontier or parent link. */
export function blankNativeSession(bytes: string): { id: string; jsonl: string; cut: ConversationCut } {
  const cut = parseCut(bytes);
  const entries: Entry[] = [];let leaf: string | null = null;
  for (const value of [{ type: "model_change", provider: cut.model.provider, modelId: cut.model.id }, { type: "thinking_level_change", thinkingLevel: cut.thinkingLevel }]) {
    const id = randomUUID().replaceAll("-", "").slice(0, 8);entries.push({ ...value, id, parentId: leaf, timestamp: new Date().toISOString() } as Entry);leaf = id;
  }
  const id = randomUUID();const header = { ...cut.source.header, id, parentSession: undefined, cwd: cut.source.cwd, timestamp: new Date().toISOString() };
  return { id, cut, jsonl: [header, ...entries].map(e => JSON.stringify(e)).join("\n") + "\n" };
}
export function seedNativeSession(bytes: string): { id: string; jsonl: string; cut: ConversationCut } {
  const cut = parseCut(bytes);
  const entries = cut.branch;let leaf = cut.source.leafId;
  const append = (value: Record<string, unknown> & { type: string }) => {
    let id: string;do { id = randomUUID().replaceAll("-", "").slice(0, 8); } while (entries.some(e => e.id === id));
    const e = { ...value, id, parentId: leaf, timestamp: new Date().toISOString() } as Entry;entries.push(e);leaf = id;
  };
  for (const { entryId, message } of cut.runtime.finalized) {
    if (entryId !== null) continue;
    if (["user", "assistant", "toolResult", "system"].includes(message.role)) append({ type: "message", message });
    else if (message.role === "custom") append({ type: "custom_message", customType: message.customType, content: message.content, display: message.display, details: message.details });
    else throw new Error(`Unsupported inherited runtime message: ${message.role}`);
  }
  const unfinished: Entry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];if (e.type !== "message" || e.message?.role !== "assistant") continue;
    const calls = e.message.content.filter((b: any) => b.type === "toolCall");if (!calls.length) continue;
    const results = entries.slice(i + 1).filter(r => r.type === "message" && r.message?.role === "toolResult" && calls.some((c: any) => c.id === r.message.toolCallId));
    if (calls.every((c: any) => results.some(r => r.message.toolCallId === c.id)) && !calls.some((c: any) => cut.runtime.pendingToolCalls.includes(c.id))) continue;
    unfinished.push(e, ...results);
  }
  if (unfinished.length || cut.runtime.streamingMessage || cut.runtime.pendingToolCalls.length) {
    for (const e of unfinished) append({ type: "context_edit", targetId: e.id, replacement: null });
    const observation = { version: 1, kind: "pi-historical-snapshot-frontier", status: "Observed on main at snapshot; not executing in child", source: cut.source, unfinishedEntries: unfinished, runtime: cut.runtime };
    const content: any[] = [{ type: "text", text: "Inherited unfinished main work; historical observation, not tool execution/completion:\n" + JSON.stringify(observation) }];
    const collectImages = (value: any) => {
      if (!value || typeof value !== "object") return;
      if (value.type === "image") { content.push(value);return; }
      for (const child of Object.values(value)) collectImages(child);
    };
    collectImages(observation);
    append({ type: "custom_message", customType: "btw-snapshot-frontier", content, display: true, details: observation });
  }
  append({ type: "model_change", provider: cut.model.provider, modelId: cut.model.id });
  append({ type: "thinking_level_change", thinkingLevel: cut.thinkingLevel });
  const id = randomUUID();const header = { ...cut.source.header, id, parentSession: cut.source.sessionFile, cwd: cut.source.cwd, timestamp: new Date().toISOString() };
  return { id, cut, jsonl: [header, ...entries].map(e => JSON.stringify(e)).join("\n") + "\n" };
}
