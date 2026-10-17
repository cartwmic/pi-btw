# pi-btw

A [pi](https://github.com/earendil-works/pi-mono) extension that adds a side conversation, `/btw` / `/side`, next to your main session.

**On the desktop TUI the side conversation is a normal Pi CLI session** (a child process on a pseudo-terminal) shown in an inset popup over your main session. It has its own model, thinking level, editor, tools, dialogs, transcript, links and a normal saved session file. There is no reduced chat and no silent fallback to one: if the native hooks are missing, the command fails with a clear message.

Headless, RPC and SDK hosts keep the older SDK side-chat route, described under [Legacy SDK/headless route](#legacy-sdkheadless-route).

Status of this text: written against candidate-r12g, which has not been copied into the maintained tree. Items marked *scripted* were observed with a scripted provider (no real model). See [What has and has not been verified](#what-has-and-has-not-been-verified).

## Requirements

- Pi 1.1.0 desktop with the matching managed native-session patch (it adds the atomic conversation snapshot, the host visibility control and the saved-session publication; editing this package does not activate it).
- macOS arm64 with the package-local node-pty 1.1.0 prebuilt (executable helper) and @xterm/headless 5.5.0. Install scripts must not be used as an implicit compiler fallback.

## Commands (desktop TUI)

| Command | What it does |
|---|---|
| `/btw`, `/side` | Open the contextual popup, or reopen the existing one. The first open takes an atomic cut of the main conversation, model and thinking level (unfinished main work is inherited as non-executing history). Text after the command is the first message of a NEW session; a live child refuses it (type in its editor instead). Flags such as `--save` are refused on this route. |
| `/btw:tangent` | Blank session: starts with no main conversation. |
| `/btw:ask` | Read-only session: inherits the main conversation; the child is started with `--tools read,grep,find,ls` and `--exclude-tools` for MCP-style tools. |
| `/btw menu` | With no session: start contextual, blank or read-only. With a saved or live session: Reopen, Hand off to main, Open separately; while no child is live also New contextual / blank / read-only (the saved one is kept). |
| `/btw:inject [instructions]` | Put the side thread (active branch only) in an editor with a lead-in, then send it to main on confirmation. |
| `/btw:summarize [instructions]` | Same, but as a bounded summary: input over 24000 characters is refused, output is capped at 2048 tokens, timeout 60 s. This is a real model call on a real host. |
| `/btw:promote` | Shows the ordinary `pi --session-dir … --session …` command for the saved session. No copy is made: the side session already is a normal session. |
| `/btw:clear` | Explains that native sessions are not cleared; use the menu to start a new one. |

A mode-specific command never silently reopens a different mode: `/btw:ask` while a blank session exists says so. `/btw:new`, `/btw:model` and `/btw:thinking` are unavailable while a native session exists (use the child's own `/model`). Nested native sessions (`/btw` inside the popup child) are not supported.

When main is busy, a handoff asks **Follow-up (default)** or **Steer**. *Scripted:* steer reaches the next model request after the current tool result; follow-up waits until the run has ended.

## Popup controls

- `Ctrl+]` hides the popup; `/btw` shows the same live child again with its draft, dialogs and history intact. Hiding exposes the covered main output.
- `Shift+PageUp/PageDown` scroll the child's normal-buffer history; everything else goes to the child's own editor (Escape and Ctrl+C included).
- Main keeps working while the popup is open or hidden. A dialog the child opens while hidden waits until you reopen the popup; the child's agent work is not paused.
- `/quit` inside the popup ends the child; the session file stays and `/btw` resumes it.

## Quiet attention while hidden

While the popup is hidden the host status line shows one compact line per event: `BTW: finished`, `BTW: failed` or `BTW: needs your input`. It is cleared when you reopen the popup and when a hidden child exits. Nothing steals focus. The child state is polled every 250 ms. These wordings and the polling interval are candidate choices the owner has not approved.

## One writer per session file

A BTW session is an ordinary Pi session file; two Pi processes must not append to it. While the popup child is live, **Open separately** and `/btw:promote` therefore say "Quit the popup child first (/quit in the popup)…" and still show the command. This is advice only. Nothing enforces it, and a later `/btw` in the host can resume a session that you opened separately.

## Handoff follows the active branch

If you use `/tree` inside the popup child and continue from an earlier point, the abandoned turns stay in the file but are **not** handed off. The handoff reads the parent chain of the last entry, which is what Pi shows as the current branch once something has been appended or the child has been reopened (a /tree move not yet followed by a message is not in the file, so a handoff made right then still sees the branch the child just left). Main's own inherited conversation is never handed back, even if you /tree to a point inside it and continue from there.

## Known limits

- **Images:** child images are unsupported. Only the child gets `PI_IMAGE_PROTOCOL=none`; known image output becomes an explicit "Unsupported child image" text, and image data is not stripped from conversation or model context. Main-session images can still obscure popup rows (the parent compositor is unchanged).
- One terminal-size family was exercised (110x40, resized to 100x36 and back).
- Keys and terminal replies are dropped after the child's exit event, but node-pty can close the PTY just before that event, so a late write can still reach a closed PTY. This is hardening, not a guarantee.
- Native sessions are macOS arm64 only.

## What has and has not been verified

The native popup was checked with unit tests, mutants, a derived overlay and scripted native journeys (a real Pi child on a real pseudo-terminal, scripted provider, no model, no network, no credentials). Observed: popup open, hide and reopen with draft and dialogs; main progress while the popup is up; the model and thinking cut; resume of a saved session; blank and read-only modes (in the scripted runs the read-only child's active tool set, as reported by Pi's `getActiveTools`, was exactly `read, grep, find, ls` and the blank child's was larger); mode-mismatch refusal; the menu; handoff with a scripted summarizer (output cap 2048 seen at the provider); steer versus follow-up; cancel sends nothing; `/tree` branch handoff; hidden finished, needs-input and failed status; status cleared when a hidden child exits; the live open-separately/promote notice; compaction before a contextual open; Escape abort in main while the popup is hidden; resize while the child exits.

It was then exercised against a real provider route on 2026-10-16/17 (Claude Sonnet 5.5 through the Claude Compat subscription, synthetic prompts, one attempt each, request counts enforced on the wire):
- **Summary:** exactly 3 requests: main answer, native child answer, and the `/btw:summarize` request. The summarizer request carried `max_tokens` 2048 and no tools; the editor showed the summary and cancelling sent nothing to main.
- **Read-only ask:** exactly 2 requests with a tool round trip. The tools offered on the wire were `read`, `grep`, `find` and `ls` (Claude Compat renames them with a leading underscore), plus Pi's own reserved placeholder, which Pi never executes.
- The harness's own pass/fail checks did not match the real behaviour in either run, so the original verdicts were `HOLD`; the retained logs were re-analysed and passed. See `scripts/live-smoke/README.md`. An earlier summary attempt produced no usable request count and is not counted as evidence.

Not verified: a confirmed (sent) handoff on a real provider, the closed-PTY write guard firing in a real run, other terminals or sizes, and the work profile on its own machine (codified, not applied there). The native child loads the user's normal extensions, so a real run can also contact whatever those extensions contact. Passing these checks is not owner acceptance of the wording, polling interval or summarizer defaults.

## Install

This source targets exact Pi 1.1.0, including its matched companion packages. Native support currently targets macOS arm64 with node-pty 1.1.0 and @xterm/headless 5.5.0. Install scripts must not be used as an implicit compiler fallback. The package-local prebuilt helper must be executable; the extension does not change runtime permissions.

The maintained native-session patch must be reviewed/applied through the managed source mechanism. Source edits do not activate it. The scripted product journey remains allocation-gated; source/type/unit checks are not native acceptance.

### From npm (after publish)

```bash
pi install npm:pi-btw
```

### From git

```bash
pi install git:github.com/dbachelder/pi-btw
```

Then reload pi:

```text
/reload
```

### From a local checkout

```bash
pi install /absolute/path/to/pi-btw
```

## Legacy SDK/headless route

The text below documents the older SDK side chat. It applies to headless, RPC and SDK hosts. On the desktop TUI `/btw`, `/side`, `/btw:tangent` and `/btw:ask` use the native popup instead, and `/btw:inject`, `/btw:summarize`, `/btw:promote` and `/btw:clear` act on the native session when one exists.

### Usage

```text
/btw what file defines this route?
/side what file defines this route?
/btw how would you refactor this parser?
/btw --save summarize the last error in one sentence
/btw:new let's start a fresh thread about auth
/btw:tangent brainstorm from first principles without using the current chat context
/btw:ask what does this module do?
/btw:ask --save explain the latest test failure
/btw:model openai gpt-5-mini openai-responses
/btw:thinking low
/btw:inject implement the plan we just discussed
/btw:summarize turn that side thread into a short handoff
/btw:promote
/btw:clear
```

### Commands

### `/btw [--save] <question>`

- runs right away
- works while pi is busy
- creates or reuses a real BTW sub-session instead of a one-off completion call
- continues the current BTW thread
- opens or refreshes the focused BTW modal shell
- streams into the BTW modal transcript/status surface
- on RPC/SDK hosts, displays completed inline-question responses as visible session notes instead
- composer-only `/btw` requires the TUI; pass the question inline on RPC/SDK hosts
- persists the BTW exchange as hidden thread state
- with `--save`, also saves that single exchange as a visible session note

### `/side [--save] <question>`

- alias for `/btw`, matching the equivalent command in Codex
- shares the same thread, overlay, persistence, model, and thinking settings as `/btw`
- `/btw` stays canonical; lifecycle commands remain under the `/btw:*` namespace, so there is no `/side:new` or `/side:clear`

### Overlay controls

- `Alt+w` toggles the overlay between the framed window layout (inset from the terminal edges) and a full-width layout
- full-width mode makes terminal Shift+drag selection capture only the dialog's own text, which is handy for copying without pulling in surrounding main-screen content
- window mode keeps the full box frame; full-width mode drops the side borders and corner glyphs (keeping only horizontal rules) so those border columns never land inside a drag selection
- `Alt+/`, `Super+/`, or `Ctrl+Alt+W` toggles focus between BTW and the main editor without closing the overlay
- `Super+/` requires a terminal that reports the Super modifier, typically through the Kitty keyboard protocol
- `Ctrl+Alt+W` remains a fallback for terminals that do not deliver either primary shortcut
- set the `PI_BTW_FOCUS_KEYS` environment variable to remap these when they conflict with your window manager or terminal
- the value is a comma-separated list of pi-tui key identifiers such as `PI_BTW_FOCUS_KEYS="ctrl+/,ctrl+alt+b"`; it replaces the defaults entirely
- identifiers combine `ctrl`, `shift`, `alt`, and `super` with a single base key (letter, digit, symbol, or named key like `enter`/`f5`); blank or invalid entries are ignored, and the defaults are kept if none are usable
- while BTW is streaming, the first `Esc` aborts the request and keeps its partial transcript visible; press `Esc` again to dismiss
- while BTW is idle, `Esc` dismisses the overlay immediately
- BTW now opens top-centered so the main session remains visible underneath it

### `/btw:new [question]`

- clears the current BTW thread
- starts a fresh thread that still inherits the current main-session context
- optionally asks the first question in the new thread immediately
- if no question is provided, opens a fresh BTW modal ready for the next prompt

### `/btw:tangent [--save] <question>`

- starts or continues a contextless tangent thread
- does not inherit the current main-session conversation
- if you switch from `/btw` to `/btw:tangent` (or back), the previous side thread is cleared so the modes do not mix
- opens or refreshes the same focused BTW modal shell
- with `--save`, also saves that single exchange as a visible session note

### `/btw:ask [--save] <question>`

- starts or continues an enforced read-only side thread
- inherits the current main-session conversation, exactly like `/btw`
- exposes only pi's built-in read-only tools (`read`, `grep`, `find`, `ls`); `bash`, `edit`, and `write` are never available to it
- follows up read-only for the lifetime of the thread
- identifies the thread as read-only in the overlay title
- if you switch between `/btw`, `/btw:tangent`, and `/btw:ask`, the previous side thread is cleared and the child session is recreated so the capability boundary stays unambiguous
- opens or refreshes the same focused BTW modal shell
- with `--save`, also saves that single exchange as a visible session note

### `/btw:clear`

- dismisses the BTW modal/widget
- clears the current BTW thread

### `/btw:inject [instructions]`

- sends the full BTW thread back to the main agent as a user message
- if pi is busy, queues it as a follow-up
- clears the BTW thread after sending

### `/btw:summarize [instructions]`

- summarizes the BTW thread with the current effective BTW model
- always runs summarize with thinking off, even if BTW chat is using a thinking override
- injects the summary into the main agent
- if pi is busy, queues it as a follow-up
- clears the BTW thread after sending

### `/btw:promote`

- saves the BTW thread as a new session instead of sending it back to main
- the new session starts with the main branch (root to the current leaf, like `/fork`), then the full BTW exchanges, including tool calls
- works while main is busy: if main is mid-turn, the fork stops at the last point where every tool call has its result
- a `/btw:tangent` thread never saw main, so it promotes on its own
- the new session's parent is the main session; the main session keeps running
- prints `pi --session <file>` so you can open it in another pane or tab
- clears the BTW thread after writing; needs a saved main session (not `--no-session`)

### `/btw:model [<provider> <model> <api> | clear]`

- with no args, shows the current effective BTW model and whether it is inherited or overridden
- with values, sets a BTW-only model override
- `clear` removes the override and returns BTW to inheriting the main thread model
- if the configured BTW model has no credentials, BTW warns and falls back to the main thread model

### `/btw:thinking [<level> | clear]`

- with no args, shows the current effective BTW thinking level and whether it is inherited or overridden
- with a value, sets a BTW-only thinking override for normal BTW chat
- `clear` removes the override and returns BTW to inheriting the main thread thinking level
- changing `/btw:model` or `/btw:thinking` disposes the current BTW sub-session and applies the new settings on the next BTW prompt while preserving the hidden thread

### Behavior

### Real sub-session model

BTW is implemented as an actual pi sub-session with its own in-memory session state, transcript events, and tool surface.

- contextual `/btw` threads seed that sub-session from the current main-session branch while filtering out BTW-visible notes from the parent context
- `/btw:tangent` starts the same BTW UI in a contextless mode with no inherited main-session conversation
- `/btw:ask` seeds the same main-session context as `/btw` but restricts the child session's tool surface to pi's read-only tools, so the boundary is structural rather than prompt-based
- BTW can inherit the main thread model/thinking settings or use BTW-only overrides via `/btw:model` and `/btw:thinking`
- `/btw:summarize` uses the current effective BTW model but keeps thinking off
- the overlay transcript/status line is driven from sub-session events, so tool activity, streaming deltas, failures, and recovery are all visible without scraping rendered output
- child prompts preserve the main session's instructions and append an authoritative list of their own tools; inherited tool/skill instructions and historical tool calls do not grant additional capabilities
- handoff commands (`/btw:inject`, `/btw:summarize`, and `/btw:promote`) read from the BTW sub-session thread rather than maintaining a separate manual transcript model

### Opt-in extension tools

BTW loads no extensions by default. To enable tools such as `web_search` and
`fetch_content` in `/btw`, `/side`, and `/btw:tangent`, create
`~/.pi/agent/btw.json` (or `btw.json` in your `PI_CODING_AGENT_DIR`):

```json
{
  "extensions": ["npm:pi-web-access"]
}
```

A trusted project's `.pi/btw.json` can override this list. Lists replace rather
than merge; `{"extensions": []}` disables global BTW extensions for that
project. An omitted `extensions` key inherits the global list. Untrusted
projects do not contribute configuration. Config is read when a child session
is created; use `/btw:clear` to apply changes to an existing thread.

Sources can be Pi `npm:` or `git:` packages, or local extension files/package
directories. Local paths are relative to the config file's directory. Remote
packages are resolved into a separate BTW cache under the agent directory's
`btw/` folder and can be installed on first use. Pin a source version when you
need reproducible behavior.

Only listed sources are loaded. BTW runs their lifecycle handlers headlessly
(`ctx.hasUI === false`) and exposes their tools alongside `read`, `bash`,
`edit`, and `write`, including tools registered at startup. The capability
note follows the child's active tools. Load/startup errors stop child creation
and are reported with the failing source; clear, mode/model changes, and parent
shutdown run extension cleanup before disposal.

Choose extensions that support headless sessions. Tools requiring interactive
dialogs (such as `ask_user`) need additional UI integration. BTW does not import
extension skills, prompt templates, themes, widgets, or shortcuts into its UI.
Extensions are trusted code, not sandboxed: separate package installs avoid
sharing the parent's cached extension factory, but extensions may still use
shared files or external services. A local source already registered by the
parent is rejected; use an `npm:` or `git:` source for a separate install.

`/btw:ask` never reads this configuration or loads extension tools, so it retains
its built-in read-only tool set. `/btw:summarize` remains tool-free. Extension
configuration is machine/project configuration, not persisted in hidden
conversation-history entries.

### In-modal slash behavior

Inside the BTW modal composer, slash handling is split at the BTW/session boundary:

- `/btw:new`, `/btw:tangent`, `/btw:ask`, `/btw:clear`, `/btw:model`, `/btw:thinking`, `/btw:inject`, `/btw:summarize`, and `/btw:promote` stay owned by BTW because they control BTW lifecycle, configuration, or handoff behavior
- any other slash-prefixed input is routed through the BTW sub-session's normal `prompt()` path
- this means ordinary pi slash commands like `/help` are handled by the sub-session instead of being rejected by a modal-only fallback
- if the sub-session cannot handle a slash command, BTW surfaces the real sub-session failure through the transcript/status state instead of inventing an "unsupported slash input" warning

This keeps BTW-owned lifecycle commands explicit while giving the side conversation the same slash-command surface as the underlying sub-session.

### Behavior

### Hidden BTW thread state

BTW exchanges are persisted in the session as hidden custom entries so they:

- survive reloads and restarts
- rehydrate the BTW modal shell for the current branch
- preserve whether the current side thread is a normal `/btw` thread, a contextless `/btw:tangent`, or a read-only `/btw:ask` thread
- preserve the current BTW-only model and thinking overrides for that session history
- stay out of the main agent's LLM context

### Visible saved notes

If you use `--save`, that one BTW exchange is also written as a visible custom message in the session transcript.

### Why

Sometimes you want to:

- ask a clarifying question while the main agent keeps working
- think through next steps without derailing the current turn
- explore an idea, then inject it back once it's ready

### Included skill

This package also ships a small `btw` skill so pi can better recognize when a side-conversation workflow is appropriate.

It helps with discoverability and guidance, but it is not required for the extension itself to work.

### Development

The extension entrypoint is:

- `extensions/btw.ts`

The included skill is:

- `skills/btw/SKILL.md`

To use it without installing:

```bash
pi -e /path/to/pi-btw
```


## DeepSeek Harness

pi-btw also runs unmodified on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) through the [pi2dsh](https://github.com/weijiafu14/pi2dsh) compatibility bridge.

For DSH Web, install the **dsh-work-x** suite, which includes pi-btw, pi2dsh, a browser side-chat window, and other extensions:

```bash
dsh plugin --profile web add dsh-work-x
```

To install just the bridge and this extension instead:

```bash
dsh plugin --profile web add pi2dsh
dsh plugin --profile web add pi-btw
```

Restart DSH after installation, then use `/btw <question>` to start a side conversation. The suite presents it in a browser side-chat window backed by a native DSH child session. DSH uses hyphens for the command family: for example, `/btw:inject` becomes `/btw-inject`.

See the [DSH side-conversation guide](https://github.com/weijiafu14/pi2dsh/tree/main/examples/side-conversation) for CLI-only installation, usage, and screenshots, and the [versioned validation results](https://github.com/weijiafu14/pi2dsh/tree/main/community/release-0.25.1) for the tested releases. Report DSH integration problems to [pi2dsh](https://github.com/weijiafu14/pi2dsh/issues).

## License

MIT

