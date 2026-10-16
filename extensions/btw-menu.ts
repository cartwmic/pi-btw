import { dirname } from "node:path";
import { NATIVE_MODE_COMMAND, READONLY_TOOL_ARGS, type NativeMode } from "./btw-native";

export type Exchange = { user: string; assistant: string };
export const MENU_TITLE = "BTW";
export const HANDOFF_TITLE = "Hand off to main";
export const KIND_SUMMARY = "Summary (default)";
export const KIND_FULL = "Full thread";
export const DELIVER_FOLLOW_UP = "Follow-up (default)";
export const DELIVER_STEER = "Steer";

/** Text of a message whose content is a string or a list of content blocks. Only text blocks count. */
export function messageText(message: { content?: unknown } | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(block => (block && typeof block === "object" && (block as { type?: string }).type === "text" ? String((block as { text?: unknown }).text ?? "") : "")).filter(Boolean).join("\n");
}

/**
 * The side conversation from a saved native session file. Entries up to and including seedLeafId are the inherited seed
 * (empty for a blank session beyond its model/thinking entries) and are not part of the side thread. Without a seedLeafId
 * (a pointer saved before this field existed) the whole session is returned and scope says so.
 * Aborted or failed assistant turns are left out, like the legacy handoff did.
 */
/** Pi appends every entry as a child of the current leaf and a re-opened session's leaf is its LAST entry, so the active branch is the parent chain of the last entry. Turns abandoned through /tree stay in the file but are not on that chain and must not be handed off (review: /tree branching residual). Files without parent links (older format) are used as written. */
export function activeBranch<T extends { id?: string; parentId?: string | null }>(entries: T[]): T[] {
  if (!entries.some(entry => entry.parentId)) return entries;
  const byId = new Map<string, T>();
  for (const entry of entries) if (entry.id) byId.set(entry.id, entry);
  let last: T | undefined;
  for (let i = entries.length - 1; i >= 0 && !last; i--) if (entries[i].id) last = entries[i];
  const chain: T[] = [];const seen = new Set<string>();
  for (let entry = last; entry?.id && !seen.has(entry.id); entry = entry.parentId ? byId.get(entry.parentId) : undefined) { seen.add(entry.id);chain.push(entry); }
  return chain.reverse();
}

export function sideThreadFromSession(jsonl: string, seedLeafId?: string): { exchanges: Exchange[]; scope: "after-seed" | "whole-session" } {
  const all = jsonl.split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as { type?: string; id?: string; parentId?: string | null; message?: { role?: string; content?: unknown; stopReason?: string } });
  const branch = activeBranch(all);
  // The inherited seed is the parent chain of seedLeafId. The user can /tree to a point INSIDE the seed and continue from there, which takes seedLeafId off the active branch; the seed (main's own conversation) must still not be handed back (review r12f P2-1).
  const seedKnown = !!seedLeafId && all.some(entry => entry.id === seedLeafId);
  let entries = branch;let cut = -1;
  if (seedKnown && all.some(entry => entry.parentId)) {
    const byId = new Map<string, (typeof all)[number]>();
    for (const entry of all) if (entry.id) byId.set(entry.id, entry);
    const seedChain = new Set<string>();
    for (let entry = byId.get(seedLeafId!); entry?.id && !seedChain.has(entry.id); entry = entry.parentId ? byId.get(entry.parentId) : undefined) seedChain.add(entry.id);
    entries = branch.filter(entry => !entry.id || !seedChain.has(entry.id));
  } else if (seedKnown) cut = branch.findIndex(entry => entry.id === seedLeafId);
  const scope = seedKnown ? "after-seed" : "whole-session";
  const exchanges: Exchange[] = [];
  let user = "", assistant = "", exclude = false;
  const push = () => { if (!exclude && (user || assistant)) exchanges.push({ user: user.trim() || "(No user prompt)", assistant: assistant.trim() || "(No assistant response)" }); user = ""; assistant = ""; exclude = false; };
  for (const entry of entries.slice(cut + 1)) {
    if (entry.type !== "message" || !entry.message) continue;
    const { role } = entry.message;
    if (role === "user") { const text = messageText(entry.message).trim(); if (!text) continue; push(); user = text; continue; }
    if (role !== "assistant") continue;
    if (entry.message.stopReason === "aborted" || entry.message.stopReason === "error") { exclude = true; continue; }
    const text = messageText(entry.message).trim();
    if (text) assistant = assistant ? assistant + "\n\n" + text : text;
  }
  push();
  return { exchanges, scope };
}

/** Deterministic full-thread text; same layout as the legacy handoff. */
export function fullThreadText(exchanges: Exchange[]): string {
  return exchanges.map(entry => "User: " + entry.user.trim() + "\nAssistant: " + entry.assistant.trim()).join("\n\n---\n\n");
}

export interface MenuState { mode?: NativeMode; live: boolean }
export type MenuId = "reopen" | "new-contextual" | "new-blank" | "new-readonly" | "handoff" | "open-separately";
const NEW: Record<NativeMode, { id: MenuId; label: string }> = {
  contextual: { id: "new-contextual", label: "New contextual session" },
  blank: { id: "new-blank", label: "New blank session" },
  readonly: { id: "new-readonly", label: "New read-only session" },
};
/** Entries for the current state. With a saved or live session, "new" entries start a fresh one and keep the saved one; they are not offered while a child is live. */
export function menuEntries(state: MenuState): { id: MenuId; label: string }[] {
  if (!state.mode) return (["contextual", "blank", "readonly"] as NativeMode[]).map(mode => NEW[mode]);
  const entries: { id: MenuId; label: string }[] = [{ id: "reopen", label: "Reopen " + state.mode + " session (" + NATIVE_MODE_COMMAND[state.mode] + ")" }, { id: "handoff", label: "Hand off to main" }, { id: "open-separately", label: "Open separately" }];
  if (!state.live) for (const mode of ["contextual", "blank", "readonly"] as NativeMode[]) entries.push({ id: NEW[mode].id, label: NEW[mode].label + " (keeps the saved one)" });
  return entries;
}

const shell = (value: string): string => /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
/** Copyable ordinary-Pi command to continue the saved side session in its own terminal. A read-only session keeps its tool restriction. */
export function openSeparatelyCommand(pointer: { sessionFile: string; id: string; mode?: NativeMode }): string {
  return ["pi", "--session-dir", shell(dirname(pointer.sessionFile)), "--session", shell(pointer.id), ...(pointer.mode === "readonly" ? READONLY_TOOL_ARGS.map(shell) : [])].join(" ");
}

/** Notice for "continue this session in its own terminal". While the popup child is live a second Pi process on the same session file would fork the tree (review P2-1), so the command is shown behind a quit-first instruction. */
export function separateTerminalNotice(command: string | undefined, live: boolean, lead = "Continue this BTW session in its own terminal:"): { message: string; type: "info" | "warning" } {
  if (!command) return { message: "No saved BTW session to open.", type: "warning" };
  if (live) return { message: "Quit the popup child first (/quit in the popup); two Pi processes must not share one session file. Then continue it in its own terminal:\n" + command, type: "info" };
  return { message: lead + "\n" + command, type: "info" };
}

export interface DialogUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}
export interface HandoffDeps {
  ui: DialogUi;
  isIdle(): boolean;
  send(text: string, deliverAs?: "followUp" | "steer"): void | Promise<void>;
  readThread(): Exchange[] | Promise<Exchange[]>;
  summarize(exchanges: Exchange[]): Promise<string>;
  /** Skip the Summary/Full choice (used by /btw:inject = full, /btw:summarize = summary). */
  kind?: "summary" | "full";
  /** Text placed before the proposed handoff in the editor, e.g. the legacy "Here is a side conversation I had" lead-in. */
  preface?: string;
}
export type HandoffResult = { sent: false; reason: "no-thread" | "cancelled" | "summary-failed" | "empty" } | { sent: true; kind: "summary" | "full"; deliverAs?: "followUp" | "steer"; text: string };
/** Confirmed handoff to main. Nothing is sent unless the owner confirms the edited text; cancel at any step sends nothing; the side session is never touched. */
export async function runHandoff(deps: HandoffDeps): Promise<HandoffResult> {
  const exchanges = await deps.readThread();
  if (!exchanges.length) { deps.ui.notify("The BTW session has no messages to hand off yet.", "warning"); return { sent: false, reason: "no-thread" }; }
  let kind: "summary" | "full";
  if (deps.kind) kind = deps.kind;
  else {
    const kindChoice = await deps.ui.select(HANDOFF_TITLE, [KIND_SUMMARY, KIND_FULL]);
    if (kindChoice === undefined) return { sent: false, reason: "cancelled" };
    kind = kindChoice === KIND_FULL ? "full" : "summary";
  }
  let proposed: string;
  if (kind === "full") proposed = fullThreadText(exchanges);
  else {
    try { proposed = (await deps.summarize(exchanges)).trim(); } catch (error) { deps.ui.notify("BTW summary failed: " + (error instanceof Error ? error.message : String(error)), "error"); return { sent: false, reason: "summary-failed" }; }
    if (!proposed) { deps.ui.notify("BTW summary was empty; nothing was handed off.", "error"); return { sent: false, reason: "summary-failed" }; }
  }
  const edited = await deps.ui.editor(HANDOFF_TITLE, deps.preface ? deps.preface + "\n\n" + proposed : proposed);
  if (edited === undefined || !edited.trim()) { deps.ui.notify("Handoff cancelled; nothing was sent.", "info"); return { sent: false, reason: edited === undefined ? "cancelled" : "empty" }; }
  let deliverAs: "followUp" | "steer" | undefined;
  if (!deps.isIdle()) {
    const delivery = await deps.ui.select("Main is working. Deliver as", [DELIVER_FOLLOW_UP, DELIVER_STEER]);
    if (delivery === undefined) { deps.ui.notify("Handoff cancelled; nothing was sent.", "info"); return { sent: false, reason: "cancelled" }; }
    deliverAs = delivery === DELIVER_STEER ? "steer" : "followUp";
  }
  await deps.send(edited, deliverAs);
  return { sent: true, kind, deliverAs, text: edited };
}

export interface MenuDeps {
  ui: DialogUi;
  state(): MenuState;
  reopen(): Promise<void>;
  startNew(mode: NativeMode): Promise<void>;
  handoff(): Promise<unknown>;
  openSeparately(): string | undefined;
}
export type MenuResult = { action: "cancelled" } | { action: MenuId };
export async function runMenu(deps: MenuDeps): Promise<MenuResult> {
  const entries = menuEntries(deps.state());
  const choice = await deps.ui.select(MENU_TITLE, entries.map(entry => entry.label));
  const picked = entries.find(entry => entry.label === choice);
  if (!picked) return { action: "cancelled" };
  switch (picked.id) {
    case "reopen": await deps.reopen(); break;
    case "new-contextual": await deps.startNew("contextual"); break;
    case "new-blank": await deps.startNew("blank"); break;
    case "new-readonly": await deps.startNew("readonly"); break;
    case "handoff": await deps.handoff(); break;
    case "open-separately": { const notice = separateTerminalNotice(deps.openSeparately(), deps.state().live);deps.ui.notify(notice.message, notice.type); break; }
  }
  return { action: picked.id };
}

export type NativeLegacyRoute =
  | { action: "handoff"; kind: "summary" | "full" }
  | { action: "open-separately" }
  | { action: "hint"; message: string };
export const NATIVE_CLEAR_HINT = "Native BTW sessions are not cleared. Use /btw menu and pick a New ... session (the saved one is kept), or /btw to reopen it.";
/**
 * The four SDK-thread commands that have a native counterpart. Routed only on the desktop TUI, when a native session is live or saved and the
 * SDK thread is empty (an SDK thread the user is still working in keeps its legacy behaviour). Anything else returns undefined = legacy path.
 */
export function nativeLegacyRoute(name: string, state: { tui: boolean; hasNative: boolean; sdkThreadEmpty: boolean }): NativeLegacyRoute | undefined {
  if (!state.tui || !state.hasNative || !state.sdkThreadEmpty) return undefined;
  switch (name) {
    case "btw:inject": return { action: "handoff", kind: "full" };
    case "btw:summarize": return { action: "handoff", kind: "summary" };
    case "btw:promote": return { action: "open-separately" };
    case "btw:clear": return { action: "hint", message: NATIVE_CLEAR_HINT };
    default: return undefined;
  }
}
