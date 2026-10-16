import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import xterm from "@xterm/headless";
import { CURSOR_MARKER, hyperlink } from "@earendil-works/pi-tui";

/** A decoded child terminal: only cell rows reach the parent's compositor. */
export class BtwTerminal {
  readonly terminal: xterm.Terminal;
  private cursorHidden = false;
  private offset: number | undefined;
  private chain = Promise.resolve();
  private pendingMedia = "";
  private imageNumber = 0;
  private kittyUpload = false;
  private readonly links: { getLinkData(id: number): { uri?: string } | undefined };
  constructor(cols: number, rows: number, private readonly reply: (data: string) => void,
    private readonly cell: { width: number; height: number }, kitty: boolean, colors: { foreground?: { r: number; g: number; b: number }; background?: { r: number; g: number; b: number } } = {}) {
    const require = createRequire(import.meta.url);
    if (JSON.parse(readFileSync(require.resolve("@xterm/headless/package.json"), "utf8")).version !== "5.5.0") throw new Error("Unsupported native /btw headless version");
    this.terminal = new xterm.Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true, windowOptions: { getCellSizePixels: true, getWinSizeChars: true } });
    // Pinned xterm5.5 read-only URI lookup; never modify renderer internals.
    const core = this.terminal as unknown as { _core?: { _oscLinkService?: { getLinkData(id: number): { uri?: string } | undefined } } };
    if (typeof core._core?._oscLinkService?.getLinkData !== "function") throw new Error("Unsupported headless hyperlink layout");
    this.links = core._core._oscLinkService;
    this.terminal.onData(reply);
    this.terminal.parser.registerCsiHandler({ final: "t" }, args => {
      if (args[0] === 16) reply(`\x1b[6;${cell.height};${cell.width}t`);
      else if (args[0] === 18) reply(`\x1b[8;${this.terminal.rows};${this.terminal.cols}t`);
      else return false;
      return true;
    });
    this.terminal.parser.registerCsiHandler({ prefix: "?", final: "u" }, () => {
      if (kitty) reply("\x1b[?7u");
      return true;
    });
    for (const code of [10, 11]) this.terminal.parser.registerOscHandler(code, data => {
      if (data !== "?") return false;
      const rgb = code === 10 ? colors.foreground : colors.background;
      if (rgb) { const hex = (v: number) => Math.round(v).toString(16).padStart(2, "0").repeat(2);reply(`\x1b]${code};rgb:${hex(rgb.r)}/${hex(rgb.g)}/${hex(rgb.b)}\x1b\\`); }
      return true;
    });
    for (const final of ["h", "l"]) this.terminal.parser.registerCsiHandler({ prefix: "?", final }, args => {
      if (args.includes(25)) this.cursorHidden = final === "l";
      return false;
    });
  }
  write(data: string): Promise<void> {
    this.chain = this.chain.then(() => this.decode(data));
    return this.chain;
  }
  private cells(data: string): Promise<void> { return new Promise(resolve => this.terminal.write(data, resolve)); }
  private unsupportedImage(protocol: string): Promise<void> {
    return this.cells(`[Unsupported child image ${++this.imageNumber}: ${protocol}]`);
  }
  private async media(payload: string): Promise<void> {
    const header = payload.slice(0, payload.indexOf(";") < 0 ? undefined : payload.indexOf(";"));
    const params = Object.fromEntries(header.split(",").map(value => value.split("=")));
    if (params.a === "d") return; // Child deletion must never reach parent images.
    if (params.a === "q") { this.reply("\x1b_Gi=0;ENOTSUP\x1b\\");return; }
    if (params.a === "T" || params.a === "t" || params.a === "p" || !this.kittyUpload) await this.unsupportedImage("Kitty");
    this.kittyUpload = params.m === "1";
  }
  private async decode(data: string): Promise<void> {
    this.pendingMedia += data;
    for (;;) {
      const kitty = this.pendingMedia.indexOf("\x1b_G"), iterm = this.pendingMedia.indexOf("\x1b]1337;");
      const indices = [kitty, iterm].filter(n => n >= 0);const at = indices.length ? Math.min(...indices) : -1;
      if (at < 0) {
        // Keep only a possible split protocol introducer, not ordinary output.
        const tail = this.pendingMedia.lastIndexOf("\x1b");
        const keep = tail >= 0 && ["\x1b_G", "\x1b]1337;"].some(p => p.startsWith(this.pendingMedia.slice(tail))) ? tail : this.pendingMedia.length;
        await this.cells(this.pendingMedia.slice(0, keep));this.pendingMedia = this.pendingMedia.slice(keep);return;
      }
      await this.cells(this.pendingMedia.slice(0, at));this.pendingMedia = this.pendingMedia.slice(at);
      const isKitty = at === kitty;
      const st = this.pendingMedia.indexOf("\x1b\\"), bel = isKitty ? -1 : this.pendingMedia.indexOf("\x07");
      const endings = [st, bel].filter(value => value >= 0);const end = endings.length ? Math.min(...endings) : -1;
      if (end < 0) return;
      const payload = this.pendingMedia.slice(isKitty ? 3 : 7, end);this.pendingMedia = this.pendingMedia.slice(end + (end === st ? 2 : 1));
      if (isKitty) await this.media(payload);
      else {
        await this.unsupportedImage("iTerm");
      }
    }
  }
  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0 && (cols !== this.terminal.cols || rows !== this.terminal.rows)) this.terminal.resize(cols, rows);
  }
  scroll(delta: number): void {
    const b = this.terminal.buffer.active;
    if (b.type === "normal") { const next = Math.max(0, Math.min(b.baseY, (this.offset ?? b.baseY) + delta));this.offset = next === b.baseY ? undefined : next; }
  }
  render(): string[] {
    const b = this.terminal.buffer.active;
    const top = b.type === "alternate" ? 0 : Math.min(this.offset ?? b.baseY, b.baseY);
    const rows: string[] = [];
    for (let y = 0; y < this.terminal.rows; y++) {
      let text = "";const line = b.getLine(top + y);
      for (let x = 0; x < this.terminal.cols; x++) {
        const c = line?.getCell(x);if (!c) break;if (c.getWidth() === 0) continue;
        const style = [0];
        if (c.isBold()) style.push(1);if (c.isDim()) style.push(2);if (c.isItalic()) style.push(3);
        if (c.isUnderline()) style.push(4);if (c.isInverse()) style.push(7);if (c.isInvisible()) style.push(8);if (c.isStrikethrough()) style.push(9);
        if (c.isFgRGB()) { const v = c.getFgColor();style.push(38, 2, v >> 16 & 255, v >> 8 & 255, v & 255); }
        else if (c.isFgPalette()) style.push(38, 5, c.getFgColor());
        if (c.isBgRGB()) { const v = c.getBgColor();style.push(48, 2, v >> 16 & 255, v >> 8 & 255, v & 255); }
        else if (c.isBgPalette()) style.push(48, 5, c.getBgColor());
        if (!this.cursorHidden && top === b.baseY && x === b.cursorX && y === b.cursorY) text += CURSOR_MARKER;
        const urlId = (c as unknown as { extended?: { urlId?: number } }).extended?.urlId;
        const uri = urlId ? this.links.getLinkData(urlId)?.uri : undefined;
        const chars = c.getChars() || " ";
        text += `\x1b[${style.join(";")}m` + (uri ? hyperlink(chars, uri.replace(/[\x00-\x1f\x7f]/g, "")) : chars);
      }
      rows.push(text + "\x1b[0m");
    }
    return rows;
  }
  async dispose(): Promise<void> {
    try { await this.chain; } catch { /* The writer already receives the decode failure; cleanup must still run. */ }
    this.terminal.dispose();
  }
}
