import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Validate package-local prebuilt support without loading an addon or changing permissions. */
export function requireNativePrebuilt(): { addon: string; helper: string } {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Native /btw currently requires the approved macOS arm64 prebuilt runtime.");
  }
  const require = createRequire(import.meta.url);
  const packageFile = require.resolve("node-pty/package.json");
  const metadata = JSON.parse(readFileSync(packageFile, "utf8")) as { version?: string };
  if (metadata.version !== "1.1.0") {
    throw new Error("Native /btw requires package-local node-pty 1.1.0.");
  }
  const directory = realpathSync(join(dirname(packageFile), "prebuilds", "darwin-arm64"));
  const addon = join(directory, "pty.node");
  const helper = join(directory, "spawn-helper");
  try {
    if (!statSync(addon).isFile() || !statSync(helper).isFile()) {
      throw new Error("Prebuilt files are not regular files");
    }
    accessSync(addon, constants.R_OK);
    accessSync(helper, constants.X_OK);
  } catch (cause) {
    throw new Error("Native /btw prebuilt addon or executable spawn-helper is unavailable; no compiler or reduced-chat fallback is used.", { cause });
  }
  return { addon, helper };
}

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getPackageDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { getCellDimensions, matchesKey, truncateToWidth, type OverlayHandle, type KeyId } from "@earendil-works/pi-tui";
import type { IPty } from "node-pty";
import { spawnSync } from "node:child_process";
import { BtwTerminal } from "./btw-terminal";
import { blankNativeSession, seedNativeSession } from "./btw-seed";
import { AttentionAnnouncer, ATTENTION_KEY, readAttention } from "./btw-attention";

/** contextual: inherited cut (/btw, /side). blank: no inherited conversation (/btw:tangent). readonly: inherited cut, read-only tool allowlist (/btw:ask). */
export type NativeMode = "contextual" | "blank" | "readonly";
export const NATIVE_MODE_COMMAND: Record<NativeMode, string> = { contextual: "/btw", blank: "/btw:tangent", readonly: "/btw:ask" };
/** Read-only child: allowlist built-in read tools, then exclude MCP and codemode reach by name/pattern. */
export const READONLY_TOOL_ARGS = ["--tools", "read,grep,find,ls", "--exclude-tools", "mcp__*,list_mcp_resources,list_mcp_resource_templates,read_mcp_resource,codemode"];
/** Ordinary Pi CLI argv for the child. Resume (fresh undefined) passes only the session; a read-only session keeps its tool restriction on every start. */
export function nativeChildArgs(cli: string, sessionFile: string, mode: NativeMode, fresh: { provider: string; id: string; thinkingLevel: string } | undefined, initial: string): string[] {
  return [cli, "--session", sessionFile, ...(fresh ? ["--model", `${fresh.provider}/${fresh.id}`, "--thinking", fresh.thinkingLevel] : []), ...(mode === "readonly" ? READONLY_TOOL_ARGS : []), ...(initial ? [initial] : [])];
}

/** Id of the last entry of a seeded session file: the boundary between inherited seed and side conversation. */
export function lastEntryId(jsonl: string): string | undefined { const last = jsonl.trim().split("\n").at(-1);try { const id = (JSON.parse(last ?? "") as { id?: unknown }).id;return typeof id === "string" ? id : undefined; } catch { return undefined; } }

/**
 * Exact message node-pty 1.1.0 throws when resizing a PTY master that has already been closed
 * (node_modules/node-pty/src/unix/pty.cc, pty_resize: ioctl(TIOCSWINSZ) -> errno EBADF => Napi::Error "ioctl(2) failed, EBADF").
 * The same function throws different messages for EFAULT, EINVAL, ENOTTY and a bare "ioctl(2) failed"; those are NOT closed-PTY errors.
 */
export const CLOSED_PTY_RESIZE_MESSAGE = "ioctl(2) failed, EBADF";
/** True only for the exact closed-PTY message. Duck-typed on message so it does not depend on the Error realm. Every other shape is false. */
export function isClosedPtyResizeError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { message?: unknown }).message === CLOSED_PTY_RESIZE_MESSAGE;
}
/**
 * Resize the child PTY, tolerating a PTY that has already closed. Between the child's PTY closing and the asynchronous exit collection
 * clearing this.child, a render tick can still reach child.resize; node-pty then throws the closed-PTY error above, uncaught inside Pi's
 * render timer, which killed the MAIN process (r11 native HOLD). Only that exact error is swallowed; the exit collection still reports the real exit.
 * Residual: an ENOTTY after close can mean the fd number was recycled; it is deliberately rethrown, not hidden.
 */
export function resizeChildPty(child: { resize(cols: number, rows: number): void }, cols: number, rows: number): void {
  try { child.resize(cols, rows); } catch (error) { if (!isClosedPtyResizeError(error)) throw error; }
}

export class NativeBtwPopup {
  constructor(private readonly hideKeys: readonly KeyId[] = [], private readonly checkPrebuilt: () => void = requireNativePrebuilt, private readonly createTerminal = (...args: ConstructorParameters<typeof BtwTerminal>) => new BtwTerminal(...args)) {}
  private child: IPty | undefined;
  private terminal: BtwTerminal | undefined;
  private handle: OverlayHandle | undefined;
  private finish: (() => void) | undefined;
  private visible = false;
  private control: string | undefined;
  private controlRevision = 0;
  private expectedModel: string | undefined;
  private notify: ((message: string, kind: "error") => void) | undefined;
  private exit: Promise<void> | undefined;
  private closedError: Error | undefined;
  lastExit: { pid: number; exitCode: number; signal?: number } | undefined;
  private starting = false;
  private generation = 0;
  pointer: { sessionFile: string; id: string; parentSession?: string; cwd: string; controlFile?: string; mode?: NativeMode; seedLeafId?: string } | undefined;
  /** Host status line (ctx.ui.setStatus) captured at open; absent in contexts without it. */
  private setStatus: ((key: string, text: string | undefined) => void) | undefined;
  private attentionTimer: ReturnType<typeof setInterval> | undefined;
  private announcer = new AttentionAnnouncer();
  private announcerControl: string | undefined;
  /** Current session mode, or undefined when there is no live or saved session. */
  get currentMode(): NativeMode | undefined { return this.child || this.pointer || this.starting ? this.mode : undefined; }
  get isLive(): boolean { return !!this.child || this.starting; }
  /** Forget the saved pointer so the next open starts a fresh session. The saved session file is kept on disk. Refused while a child is live. */
  forget(): void { if (this.child || this.starting) throw new Error("A native BTW child is live; quit it (/quit in the popup) before starting a new session."); this.pointer = undefined;this.mode = "contextual"; }
  /** One status-line decision from the child state file; no-op unless a child is live and a status line exists. Exposed for tests. */
  attentionTick(): void { if (!this.child || !this.control || !this.setStatus) return;if (this.announcerControl !== this.control) { this.announcer = new AttentionAnnouncer();this.announcerControl = this.control; } /* a new session has its own sequence numbers */ const step = this.announcer.step(this.visible, readAttention(this.control));if (step.set) this.setStatus(ATTENTION_KEY, step.set);else if (step.clear) this.setStatus(ATTENTION_KEY, undefined); }
  private stopAttention(): void { if (this.attentionTimer) clearInterval(this.attentionTimer);this.attentionTimer = undefined; }
  private mode: NativeMode = "contextual";
  private render: (() => void) | undefined;
  restore(pointer: any): void { if (!this.child && pointer?.sessionFile && pointer?.id && pointer?.cwd && existsSync(pointer.sessionFile)) { this.mode = pointer.mode === "blank" || pointer.mode === "readonly" ? pointer.mode : "contextual";this.pointer = { sessionFile: pointer.sessionFile, id: pointer.id, cwd: pointer.cwd, parentSession: pointer.parentSession, controlFile: pointer.controlFile, mode: this.mode, seedLeafId: typeof pointer.seedLeafId === "string" ? pointer.seedLeafId : undefined }; } }
  hasSession(): boolean { return !!this.child || this.starting; }
  toggle(): void { if (this.handle) void this.setVisible(!this.visible).catch(error => this.notify?.(String(error), "error")); }
  private async setVisible(value: boolean): Promise<void> {
    this.visible = value;if (value) this.attentionTick();const revision = this.publishControl(false);
    // Child pauses/adopts its native UI before the host actually hides/reveals it.
    while (this.child && this.control) {
      if (revision !== this.controlRevision) return;
      try { const ack = JSON.parse(readFileSync(this.control + ".ack", "utf8"));if (ack.revision === revision && ack.pid === this.child.pid && typeof ack.sessionId === "string") break; } catch { }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (!this.child) return;
    this.handle?.setHidden(!value);
    if (value) this.handle?.focus();
  }
  private publishControl(close: boolean): number {
    const revision = ++this.controlRevision;
    if (!this.control) return revision;
    const temporary = this.control + ".tmp";
    writeFileSync(temporary, JSON.stringify({ visible: this.visible, close, revision, expectedModel: this.expectedModel }));renameSync(temporary, this.control);return revision;
  }
  /** requested undefined = plain /btw: reopen whatever exists, else contextual. A mode-specific command never silently reopens a different mode. */
  async open(ctx: ExtensionCommandContext, initial = "", requested?: NativeMode): Promise<void> {
    const existing = !!this.child || !!this.pointer;
    if (existing && requested && requested !== this.mode) throw new Error(`A native BTW session already exists in ${this.mode} mode; use ${NATIVE_MODE_COMMAND[this.mode]} or /btw to reopen it.`);
    const mode: NativeMode = existing ? this.mode : requested ?? "contextual";
    if (this.child) { if (initial.trim()) throw new Error("A native BTW child is already live; enter follow-up text in its native editor instead of /btw or /side arguments.");await this.setVisible(true);return; }
    if (this.closedError) throw this.closedError;
    if (this.starting) throw new Error("Native /btw is already opening.");
    const capture = (ctx as ExtensionCommandContext & { captureConversationSnapshot?: () => string }).captureConversationSnapshot;
    if (!capture) throw new Error("Native /btw requires the managed atomic conversation-capture patch; no SDK overlay fallback is used.");
    if (this.pointer?.controlFile && existsSync(this.pointer.controlFile + ".session")) {
      const saved = JSON.parse(readFileSync(this.pointer.controlFile + ".session", "utf8"));
      if (saved?.sessionFile && saved?.id && saved?.cwd && existsSync(saved.sessionFile)) this.pointer = { ...this.pointer, sessionFile: saved.sessionFile, id: saved.id, cwd: saved.cwd };
    }
    // The cut, settings, cwd and UI services are copied BEFORE the first await.
    const seed = this.pointer ? undefined : mode === "blank" ? blankNativeSession(capture()) : seedNativeSession(capture());const cwd = this.pointer?.cwd ?? ctx.cwd;const custom = ctx.ui.custom.bind(ctx.ui);const notify = ctx.ui.notify.bind(ctx.ui);this.notify = notify;this.setStatus = typeof ctx.ui.setStatus === "function" ? ctx.ui.setStatus.bind(ctx.ui) : undefined;
    const parentSession = ctx.sessionManager.getSessionFile();
    this.checkPrebuilt();
    const directory = this.pointer ? dirname(this.pointer.sessionFile) : join(getAgentDir(), "btw-native", seed!.id);mkdirSync(directory, { recursive: true });
    const sessionFile = this.pointer?.sessionFile ?? join(directory, "session.jsonl");if (seed) writeFileSync(sessionFile, seed.jsonl, { flag: "wx" });
    const savedModel = seed ? undefined : SessionManager.open(sessionFile).buildSessionContext().model;
    this.expectedModel = seed ? `${seed.cut.model.provider}/${seed.cut.model.id}` : savedModel ? `${savedModel.provider}/${savedModel.modelId}` : undefined;
    if (!this.expectedModel) throw new Error("Native /btw saved session has no model identity; refusing fallback.");
    this.control = join(directory, "host-control.json");this.visible = true;this.publishControl(false);
    this.starting = true;const generation = ++this.generation;
    try {
      const pty = await import("node-pty");
      if (generation !== this.generation) throw new Error("Native /btw opening was canceled.");
      let ready!: () => void;let failed!: (error: unknown) => void;
      const startup = new Promise<void>((resolve, reject) => { ready = resolve;failed = reject; });
      void custom(async (tui, _theme, _keys, done) => {
        let outgoing: IPty | undefined;let collection: Promise<void> | undefined;
        try {
        const host = tui as typeof tui & { btwNativeExclusiveInput?: boolean };
        if (!host.btwNativeExclusiveInput) throw new Error("Native /btw requires the managed exclusive-input patch.");
        const colors = await tui.queryTerminalColors({ timeoutMs: 150 });
        if (generation !== this.generation) throw new Error("Native /btw opening was canceled.");
        const cell = getCellDimensions();

        const cols = Math.max(1, Math.floor(tui.terminal.columns * .8));const rows = Math.max(1, Math.floor(tui.terminal.rows * .8));
        const argv = nativeChildArgs(join(getPackageDir(), "dist", "bundle", "cli.js"), sessionFile, mode, seed ? { provider: seed.cut.model.provider, id: seed.cut.model.id, thinkingLevel: seed.cut.thinkingLevel } : undefined, initial);
        const child = pty.spawn(process.execPath, argv, { cwd, env: { ...process.env, PI_BTW_NATIVE_CONTROL: this.control!, PI_IMAGE_PROTOCOL: "none" }, cols, rows, name: "xterm-256color" });
        outgoing = child;this.child = child;
        let terminal: BtwTerminal | undefined;let lastRenderError: string | undefined;
        const control = this.control;const finish = () => done(undefined);
        // Review (child.write hardening): once the child reported exit, keys and terminal replies are dropped instead of written to a dead PTY (node-pty fails such writes asynchronously and prints on the host stderr). The PTY can close slightly BEFORE onExit, so this narrows the window; it does not close it.
        let exited = false;const writeChild = (data: string): void => { if (!exited) child.write(data); };
        collection = this.exit = new Promise(resolve => child.onExit(event => {
          exited = true;
          const errors: Error[] = [];
          const attempt = async (operation: () => void | Promise<void>) => { try { await operation(); } catch (error) { errors.push(error instanceof Error ? error : new Error(String(error))); } };
          if (this.child === child) this.lastExit = { pid: child.pid, ...event };
          void (async () => {
            await attempt(() => {
              if (event.exitCode !== 0 || (event.signal !== undefined && event.signal !== 0)) throw new Error(`Native /btw child exited ${event.exitCode} (signal ${event.signal}).`);
            });
            await attempt(() => { if (control && existsSync(control + ".error")) throw new Error(readFileSync(control + ".error", "utf8")); });
            await attempt(() => {
              const group = spawnSync("/bin/ps", ["-ww", "-g", String(child.pid), "-o", "pid="], { encoding: "utf8", env: {} });
              let absent = false;try { process.kill(-child.pid, 0); } catch (error) { absent = (error as NodeJS.ErrnoException).code === "ESRCH"; }
              if (![0, 1].includes(group.status ?? -1) || group.stderr || group.stdout.trim() || !absent) throw new Error("Native /btw owned group remains or is UNKNOWN after exit.");
            });
            await attempt(() => terminal?.dispose());
            await attempt(finish);
            if (errors.length) await attempt(() => notify(errors.map(error => error.message).join("; "), "error"));
            if (this.child === child) {
              if (errors.length) this.closedError = new AggregateError(errors, "Native /btw exit collection failed");
              this.child = undefined;this.starting = false;this.finish = undefined;this.terminal = undefined;this.render = undefined;this.stopAttention();
              try { this.setStatus?.(ATTENTION_KEY, undefined); } catch { /* status line is optional */ }   // review P3-1a: a hidden child that exits must not leave BTW: text behind
            }
          })().finally(resolve);
        }));
        const ownership = spawnSync("/bin/ps", ["-ww", "-p", String(child.pid), "-o", "pid=,ppid=,pgid=,uid="], { encoding: "utf8", env: {} });
        const identity = ownership.stdout.trim().split(/\s+/).map(Number);
        if (ownership.status !== 0 || ownership.stderr || identity.length !== 4 || identity[0] !== child.pid || identity[1] !== process.pid || identity[2] !== child.pid || identity[3] !== process.getuid?.()) {
          child.kill("SIGTERM");throw new Error("Native /btw child ownership could not be confirmed.");
        }
        terminal = this.createTerminal(cols, rows, data => writeChild(data), { width: cell.widthPx, height: cell.heightPx }, tui.terminal.kittyProtocolActive, colors);
        this.terminal = terminal;this.render = () => { if (this.visible && this.child === child) tui.requestRender(); };
        child.onData(data => { void terminal!.write(data).then(() => { if (this.child === child) this.render?.(); }).catch(error => { if (this.child === child) { const failures = [error instanceof Error ? error : new Error(String(error))];try { notify(String(error), "error"); } catch (failure) { failures.push(new Error(String(failure))); }try { this.publishControl(true); } catch (failure) { failures.push(new Error(String(failure))); }this.closedError = new AggregateError(failures, "Native /btw output failed"); } }); });
        this.finish = finish;this.starting = false;this.stopAttention();this.attentionTimer = setInterval(() => this.attentionTick(), 250);this.attentionTimer.unref?.();this.attentionTick();ready();   // review P3-1b: seed the announcer from a resumed child's old state so a quick hide cannot re-announce it

        return {
          focused: true, wantsKeyRelease: true, invalidate() {},
          render: (width: number) => {
            if (this.child !== child) return [];
            const height = Math.max(1, Math.min(this.handle?.getBounds()?.height ?? rows, Math.floor(tui.terminal.rows * .8), tui.terminal.rows - 2));
            terminal?.resize(width, height);resizeChildPty(child, width, height);
            queueMicrotask(() => {
              const bounds = this.handle?.getBounds();const terminal = this.terminal;
              if (this.child !== child || !this.visible || !bounds || !terminal) return;
              if (terminal.terminal.cols !== bounds.width || terminal.terminal.rows !== bounds.height) {
                terminal.resize(bounds.width, bounds.height);resizeChildPty(child, bounds.width, bounds.height);tui.requestRender();
              }
            });
            try { const lines = terminal?.render() ?? [];lastRenderError = undefined;return lines; }
            catch (error) { this.closedError = error instanceof Error ? error : new Error(String(error));this.publishControl(true);const message = String(error);if (message !== lastRenderError) { lastRenderError = message;notify(message, "error"); }return [truncateToWidth("Native /btw view could not preserve this terminal output.", width)]; }
          },
          handleInput: (data: string) => {
            if (this.child !== child) return;
            if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { writeChild(data);return; }
            if (matchesKey(data, "ctrl+]") || this.hideKeys.some(key => matchesKey(data, key))) { void this.setVisible(false).catch(error => notify(String(error), "error"));return; }
            if (data === "\x1b[5;2~") { terminal?.scroll(-12);tui.requestRender();return; }
            if (data === "\x1b[6;2~") { terminal?.scroll(12);tui.requestRender();return; }
            const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data), bounds = this.handle?.getBounds();
            if (mouse && bounds) {
              const x = Number(mouse[2]) - bounds.col, y = Number(mouse[3]) - bounds.row;
              if (x < 1 || y < 1 || x > bounds.width || y > bounds.height) return;
              data = `\x1b[<${mouse[1]};${x};${y}${mouse[4]}`;
            }
            writeChild(data);
          },
          dispose: () => { if (this.child === child) this.render = undefined; },
        };
        } catch (error) {
          const failures: unknown[] = [error];
          if (outgoing && this.child === outgoing) {
            try { this.publishControl(true); } catch (failure) { failures.push(failure); }
            // Failed startup has not established a working control reader.
            try { outgoing.kill("SIGTERM"); } catch (failure) { failures.push(failure); }
            await collection;
            if (this.closedError) failures.push(this.closedError);
          }
          const failure = failures.length === 1 ? error : new AggregateError(failures, `Native /btw startup failed: ${String(error)}; cleanup also failed`);
          failed(failure);throw failure;
        }
      }, { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center", margin: 1, ...{ exclusiveInput: true } }, onHandle: handle => { if (generation === this.generation) this.handle = handle; } }).catch(error => { failed(error); });
      await startup;
      // Saved pointer only; child uses ordinary session JSONL/resume, never SDK rehydration.
      this.mode = mode;this.pointer = { sessionFile, id: seed?.id ?? this.pointer!.id, parentSession: mode === "blank" ? undefined : parentSession, cwd, controlFile: this.control, mode, seedLeafId: seed ? lastEntryId(seed.jsonl) : this.pointer?.seedLeafId };
    } catch (error) { this.starting = false;throw error; }
  }
  async shutdown(): Promise<void> {
    this.generation++;this.starting = false;this.stopAttention();
    if (this.child) { this.publishControl(true);await this.exit; }
    this.handle = undefined;this.render = undefined;
    if (this.closedError) throw this.closedError;
  }
}
