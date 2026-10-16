import { expect, it } from "vitest";
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { encodeKitty, encodeITerm2 } from "@earendil-works/pi-tui";
import { BtwTerminal } from "../extensions/btw-terminal";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=";
const plain = (view: BtwTerminal) => view.render().join("\n").replace(/\x1b\[[0-9;]*m/g, "");
it("consumes split/chunked Kitty images as one unsupported marker without parent graphics or deletion", async () => {
 const view = new BtwTerminal(80, 5, () => {}, { width: 9, height: 18 }, true);
 const encoded = encodeKitty(png.repeat(80), { columns: 2, rows: 2, imageId: 33, moveCursor: false });
 for (let i = 0; i < encoded.length; i += 17) await view.write(encoded.slice(i, i + 17));
 await view.write("\x1b_Ga=d,d=A\x1b\\");
 expect(plain(view)).toContain("Unsupported child image 1: Kitty");expect(plain(view)).not.toContain("image 2");
 expect(view.render().join("")).not.toMatch(/\x1b_G|1337;|a=d|i=33/);expect(plain(view)).not.toContain(png);await view.dispose();
});
it("keeps separate unsupported iTerm transmissions in history through scrolling and reflow", async () => {
 const view = new BtwTerminal(80, 5, () => {}, { width: 9, height: 18 }, false);
 const image = encodeITerm2(png, { width: 2, height: 1 });
 await view.write(image.slice(0, 5));await view.write(image.slice(5));await view.write("\r\n" + image.replace(/\x07$/, "\x1b\\") + "\r\n\r\n\r\n\r\n");
 expect(view.terminal.buffer.active.baseY).toBeGreaterThan(0);view.scroll(-100);
 expect(plain(view)).toContain("image 1: iTerm");expect(plain(view)).toContain("image 2: iTerm");view.resize(70, 6);
 expect(plain(view)).toContain("image 1: iTerm");expect(plain(view)).toContain("image 2: iTerm");expect(view.render().join("")).not.toContain(png);await view.dispose();
});
it("returns no positive graphics acknowledgment while retaining Kitty keyboard and text controls", async () => {
 const replies: string[] = [];const view = new BtwTerminal(80, 4, value => replies.push(value), { width: 9, height: 18 }, true);
 await view.write("\x1b_Ga=q,i=42,s=1,v=1;AAAA\x1b\\\x1b[?u\x1b[18t");
 expect(replies).toContain("\x1b_Gi=0;ENOTSUP\x1b\\");expect(replies).toContain("\x1b[?7u");expect(replies).toContain("\x1b[8;4;80t");expect(replies.join("")).not.toContain("OK");expect(view.render().join("")).not.toMatch(/\x1b_G|AAAA/);await view.dispose();
});
it("does not leak unfinished image payloads on parser disposal", async () => {
 const view = new BtwTerminal(80, 3, () => {}, { width: 9, height: 18 }, false);await view.write("before\x1b]1337;File=inline=1:" + png);
 expect(plain(view)).toContain("before");expect(plain(view)).not.toContain(png);await view.dispose();
});
it("retains cell-linked URLs through reflow", async () => {
 const view = new BtwTerminal(12, 3, () => {}, { width: 9, height: 18 }, false);
 await view.write("\x1b]8;;https://example.test/a\x1b\\linked-text\x1b]8;;\x1b\\");
 expect(view.render().join("")).toContain("https://example.test/a");view.resize(6, 5);expect(view.render().join("")).toContain("https://example.test/a");await view.dispose();
});
it("restores live following at PageDown bottom so later output advances", async () => {
 const view = new BtwTerminal(10, 2, () => {}, { width: 9, height: 18 }, false);await view.write("one\r\ntwo\r\nthree");view.scroll(-1);view.scroll(100);await view.write("\r\nlatest");expect(plain(view)).toContain("latest");await view.dispose();
});
const root = process.env.PI_ROOT;
it.skipIf(!root)("imports the actual isolated image helper and detects child none without changing parent capabilities", async () => {
 const file = root + "/../pi-tui/dist/terminal-image.js";
 expect(lstatSync(file).isSymbolicLink()).toBe(false);expect(realpathSync(file)).toBe(file.replace("/pi-coding-agent/../", "/"));
 expect(createHash("sha256").update(readFileSync(file)).digest("hex")).toBe("1187386762f00b8992c22a453d6837acfb4f664d21f18b6eac9cee8994e14049");
 const image = await import(/* @vite-ignore */ file);const previous = process.env.PI_IMAGE_PROTOCOL;const before = image.detectCapabilities(() => false);
 try { process.env.PI_IMAGE_PROTOCOL = "none";expect(image.detectCapabilities(() => false).images).toBe(null); }
 finally { if (previous === undefined) delete process.env.PI_IMAGE_PROTOCOL;else process.env.PI_IMAGE_PROTOCOL = previous; }
 expect(image.detectCapabilities(() => false)).toEqual(before);expect(process.env.PI_IMAGE_PROTOCOL).toBe(previous);
});
