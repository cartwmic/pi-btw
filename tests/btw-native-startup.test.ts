import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
// Named checked private source port only; never imports or starts InteractiveMode.
const root = process.env.PI_ROOT;
it.skipIf(!root)("attaches native visibility before a configured startup handler awaits UI", async () => {
 const source = readFileSync(root + "/dist/modes/interactive/interactive-mode.js", "utf8");
 const visibility = source.slice(source.indexOf("setHostVisibility(visible) {"), source.indexOf("cancelHostedUI() {", source.indexOf("setHostVisibility(visible) {")));
 const prompt = source.slice(source.indexOf("runHostedUIPrompt(kind, opts, open) {"), source.indexOf("createExtensionUIContext() {", source.indexOf("runHostedUIPrompt(kind, opts, open) {")));
 const install = source.slice(source.indexOf("publishBtwHostSession() {"), source.indexOf("    async bindCurrentSessionExtensions() {", source.indexOf("publishBtwHostSession() {")));
 const previous = process.env.PI_BTW_NATIVE_CONTROL;process.env.PI_BTW_NATIVE_CONTROL = "TESTONLY_CONTROL";vi.useFakeTimers();
 let control = { visible: false, close: false, revision: 1, expectedModel: "scripted/a" };const writes = new Map<string, string>();
 const fs = { readFileSync: () => JSON.stringify(control), writeFileSync: (p: string, v: string) => writes.set(p, v), renameSync: (from: string, to: string) => { writes.set(to, writes.get(from)!);writes.delete(from); } };
 const methods = Function("btwHostFS", `return ({${visibility},${prompt},${install.replace("\ninstallBtwHostControl", ",\ninstallBtwHostControl")}})`)(fs);
 const host = { ...methods, hostUIEnabled: false, hostUIVisible: true, hostUIGeneration: 0, hostUITickets: new Set(), session: { model: { provider: "scripted", id: "a" }, agent: { signal: new AbortController().signal }, sessionManager: { getSessionFile: () => "side.jsonl", getSessionId: () => "side-id", getCwd: () => "/project" } }, shutdown: vi.fn() };
 try {
  host.installBtwHostControl();expect(host.hostUIVisible).toBe(false);
  expect(source.indexOf("this.installBtwHostControl();", source.indexOf("async bindCurrentSessionExtensions"))).toBeLessThan(source.indexOf("await this.session.bindExtensions", source.indexOf("async bindCurrentSessionExtensions")));
  let finish: (() => void) | undefined;const nativeOpen = vi.fn((_opts, ticket) => new Promise<void>(resolve => { finish = resolve;ticket.component = { setHostVisible: vi.fn() }; }));
  const pending = host.runHostedUIPrompt("input", {}, nativeOpen);expect(nativeOpen).not.toHaveBeenCalled();
  control = { ...control, visible: true, revision: 2 };await vi.advanceTimersByTimeAsync(50);expect(nativeOpen).toHaveBeenCalledTimes(1);
  const component = [...host.hostUITickets][0] as any;
  control = { ...control, visible: false, revision: 3 };await vi.advanceTimersByTimeAsync(50);expect(component.component.setHostVisible).toHaveBeenLastCalledWith(false);
  control = { ...control, visible: true, revision: 4 };await vi.advanceTimersByTimeAsync(50);expect(nativeOpen).toHaveBeenCalledTimes(1);expect(component.component.setHostVisible).toHaveBeenLastCalledWith(true);
  expect(JSON.parse(writes.get("TESTONLY_CONTROL.ack")!).revision).toBe(4);finish!();await pending;
 } finally { vi.clearAllTimers();vi.useRealTimers();if (previous === undefined) delete process.env.PI_BTW_NATIVE_CONTROL;else process.env.PI_BTW_NATIVE_CONTROL = previous; }
});

it.skipIf(!root)("publishes replacement and final saved session atomically before exit instead of relying on the poll", async () => {
 const source = readFileSync(root + "/dist/modes/interactive/interactive-mode.js", "utf8");
 const publish = source.slice(source.indexOf("publishBtwHostSession() {"), source.indexOf("installBtwHostControl() {"));
 const shutdown = source.slice(source.indexOf("async shutdown(options) {"), source.indexOf("emergencyTerminalExit() {"));
 const writes = new Map<string, string>();const rename = vi.fn((from: string, to: string) => { writes.set(to, writes.get(from)!);writes.delete(from); });
 const fs = { writeFileSync: (file: string, text: string) => writes.set(file, text), renameSync: rename };
 const previous = process.env.PI_BTW_NATIVE_CONTROL;process.env.PI_BTW_NATIVE_CONTROL = "TESTONLY_POINTER";
 const fakeProcess = { env: process.env, exit: vi.fn(), stdout: { write: vi.fn() } };
 const methods = Function("btwHostFS", "process", "formatResumeCommand", `return ({${publish},${shutdown}})`)(fs, fakeProcess, () => "");
 // Execute the actual public binding prefix at replacement; remaining binding work is mocked.
 const start = source.indexOf("async bindCurrentSessionExtensions() {");const prefix = source.slice(start, source.indexOf("await this.session.bindExtensions", start));
 const bind = Function(`return ({${prefix} }})`)().bindCurrentSessionExtensions;
 let identity = { sessionFile: "first.jsonl", id: "first", cwd: "/project" };
 const manager = { getSessionFile: () => identity.sessionFile, getSessionId: () => identity.id, getCwd: () => identity.cwd };
 const host: any = { ...methods, session: { sessionManager: manager }, installBtwHostControl: vi.fn(), createExtensionUIContext: () => ({}), themeController: { disableAutoSync: vi.fn() }, ui: { terminal: { drainInput: vi.fn() } }, stop: vi.fn(), runtimeHost: { dispose: async () => { identity = { sessionFile: "final.jsonl", id: "final", cwd: "/project" }; } } };
 try {
  identity = { sessionFile: "switched.jsonl", id: "switched", cwd: "/project" };await bind.call(host);
  expect(JSON.parse(writes.get("TESTONLY_POINTER.session")!)).toEqual(identity);
  await host.shutdown();expect(JSON.parse(writes.get("TESTONLY_POINTER.session")!)).toEqual(identity);expect(identity.id).toBe("final");expect(fakeProcess.exit).toHaveBeenCalledWith(0);expect(rename).toHaveBeenCalled();expect(writes.has("TESTONLY_POINTER.session.tmp")).toBe(false);
 } finally { if (previous === undefined) delete process.env.PI_BTW_NATIVE_CONTROL;else process.env.PI_BTW_NATIVE_CONTROL = previous; }
});
it.skipIf(!root)("documents the pinned main-image overlap block without graphics-core suppression", async () => {
 const source = readFileSync(root + "/../pi-tui/dist/tui.js", "utf8");
 expect(source).toContain("if (isImageLine(baseLine))\n        return baseLine;");
 const start = source.indexOf("export function compositeTuiLine(");const end = source.indexOf("const afterStart", start);
 const compose = Function("isImageLine", source.slice(start, end).replace("export ", "") + "return baseLine; } return compositeTuiLine;")((line: string) => line.includes("\x1b_G"));
 const mainImage = "outside-left\x1b_Gi=1;AAAA\x1b\\outside-right";
 expect(compose(mainImage, "NATIVE-PANE", 3, 8, 20)).toBe(mainImage);
});
