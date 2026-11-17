# BlueCheese: development notes

> The user guide is the [README](../README.md). This file is the development log: design constraints that come from Roaster, measurements, what each
> version taught us, the test inventory and open gaps. It is kept as written while the project evolved, so older sections describe the state at that time.

# BlueCheese 🧀

A local-first coding assistant for **Roaster** (Qwen3.6-35B-A3B streamed from SSD on a laptop): a VS Code sidebar with
saved chats, read-only code tools and MCP servers. See `ROASTER_USAGE.md` for the engine.

> **0.0.8:** the code graph is removed for now (an alternative is being looked for): the model reads the project with plain file tools
> (`list_files`, `find_files`, `grep`, `read_file`) plus the compiler's `diagnostics`. Chats are saved per project and can be reopened
> from a sidebar, together with the model's context. MCP servers can be added, and every tool is listed in the panel. The model can
> create and edit files (each change asks first) and search its own chat, including what slid out of its context. See
> [Chats](#chats-and-saved-context), [Tools and MCP](#tools-and-mcp) and [Writing files](#writing-files-and-searching-the-chat).

```
packages/
  agent/       @bluecheese/agent  – Roaster client, sessions, text tool-call protocol, agent loop, docker runtime manager
  core/        @bluecheese/core   – file tools, saved chats, MCP client, ChatController (UI-free chat logic shared by front-ends)
  cli/         @bluecheese/cli    – `bc` command
  vscode-ext/  bluecheese-vscode  – sidebar chat (thin shell over core); see packages/vscode-ext/README.md
```

## Design constraints that come from Roaster

| Roaster fact | What BlueCheese does about it |
|---|---|
| Whole prompt ≤ 16000 bytes per request | `fitPrompt()` for the first turn; MCP tool descriptions are shortened and capped (`mcp.promptBytes`); client refuses >15000 bytes before sending |
| **Sessions keep the KV cache between requests** (`session`, `reset`) | Agent runs in one session; each step sends only the NEW message (a tool result), never the history |
| A session holds a slot until deleted (503 when slots run out) | Throwaway sessions are deleted automatically; named sessions must be deleted by the agent when the task ends |
| One request at a time per session (409) | One step at a time per session; parallel work gets its own session |
| Context is cumulative (prompt + replies + thinking must fit `--context`) | **Context sliding** (default): the window slides, old context parks on SSD, nothing is reset. Only with sliding off: compact by resetting and re-seeding with a summary when nearly full |
| A system turn is **pinned**: it stays in the window however far it slides | Instructions + tool list go in a real system message, once per conversation, so they survive sliding |
| `save` / `restore` store and replace a whole session's context in a directory on the server | Every chat's context is saved there after each answer and restored when the chat is opened (falls back to a recap of the transcript) |
| Session settings (`context_length`, routing, `slide`, `keep`) can be changed with `PATCH` while the session lives | Every session is created with explicit settings and changed in place: no restart, no lost context |
| Several new messages in one request are flattened to plain text | Always send exactly one new user message per step |
| `tools` and `stop` are ignored | Text tool protocol (`<tool_call>` JSON or XML, parsed client-side) |
| Client disconnect stops generation cleanly (partial answer stays in context) | Optional client-side stop; but let the model end its own turn when it does, to keep the context clean |
| Nothing is sent until the first token; prefill can take minutes | Client uses node:http (no 5-minute header timeout) |
| Concurrent requests round-robin one token each | No parallel subagents for speed |
| HTTP 503 = no free slot | Client retries with backoff |

## Which project does the CLI use?

The folder you typed the command in. (`pnpm` runs scripts from BlueCheese's own folder; the CLI reads `INIT_CWD`, which
pnpm/npm set to where you ran the command. If that variable is missing it falls back to the current folder.) Use `--root <dir>`
to be explicit. Chats and MCP settings of a project live in `<project>/.bluecheese/` (git-ignored by a `.gitignore` BlueCheese writes there).

## Quick start

```bash
pnpm install

# Start Roaster serve + api as in ROASTER_USAGE.md (api on 127.0.0.1:8080), then:
pnpm slots --slots 3                 # solo vs concurrent speed (aggregate should ≈ solo)
pnpm slots --protocol-check --skip-speed --repeat 5   # does Qwen follow the <tool_call> protocol?
pnpm tsx packages/agent/scripts/session-test.ts            # does KV reuse across turns pay off? tool round trip works?

# no model handy?
pnpm tsx packages/agent/scripts/mock-server.ts 8080

# ask about any project
pnpm bc ask "how does login work" --root /path/to/project
```

Env: `BC_BASE_URL` (default http://127.0.0.1:8080), `BC_MODEL` (default `roaster`), `BC_API_KEY`.

## Measured on the dev laptop (Roaster, Qwen3.6-35B-A3B Q4_K_M, iGPU, --cache-route 1)

| Measurement | Result |
|---|---|
| Prefill | ~7 tok/s (357 prompt tokens → 49.6 s; 1797 → 271.7 s). 3000 tokens would take ~7.5 min |
| Decode | ~6.5 tok/s (chat); fixed ~8 s per request before the first token even for a 13-token prompt |
| API accepts all request fields our client sends | yes (after the JSON array-parse fix in api.c) |
| Text tool protocol (`<tool_call>` JSON) | 5/5 valid |

(Measured BEFORE sessions existed: each request re-prefilled its whole prompt. Re-measure with `session-test.ts`.)

Consequence at that time: with no KV reuse between requests, every agent step paid full prefill. At ~7 tok/s a 1500-token
context pack is ~3.5 min per step. Before building the full loop, Roaster needs KV/slot reuse and/or faster
(batched) prefill; see "Roaster wishlist" below.

### With sessions (measured with `session-test.ts`)

| Turn | New prompt | ttft |
|---|---|---|
| 1: big prompt, empty session | ~170 tok | 36.5 s |
| 2: short follow-up, same session | ~12 tok | 2.4 s |
| 3: tool instructions + task | ~130 tok | 17 s |
| 4: tool result | ~40 tok | 6.4 s |
| 6: after a client-side disconnect | ~13 tok | 2.8 s |

KV reuse works; prefill is still ~7.5 tok/s. Step cost ≈ 2 s + new tokens / 7.5 + reply tokens / 8.
Tool round trip works across turns (clean `<tool_call>` JSON; the model ends its own turn).

## Ask a question

```bash
pnpm bc ask "how does the controller restore a chat" --root /path/to/project --steps 8
```
Runs a read-only tool loop (diagnostics, list_files, find_files, grep, read_file) inside one Roaster session.
Progress and per-step timings go to stderr, the answer to stdout. `--keep` leaves the session on the server.
Expect ~1 min for the first message and ~30-60 s per tool step.

### Second `bc ask` run (394 s) vs single shot (197 s)

The tool loop followed the continuation hints (read_symbol → read_file 108-169 → read_file 138-169) with no repeated call and
gave a precise answer; single shot (`--steps 0 --pack 900`) was twice as fast but vaguer and partly off-topic.
`usage.prompt_tokens` is the NEW tokens of each request. Tool results ≈ 2.2 bytes/token (raw code);
the first message ≈ 3.3 bytes/token. Prefill 7-8 tok/s, decode 6-7 tok/s.

### First real `bc ask` run (before the fixes below)

494 s for one question: first message ~646 tok (82 s), two identical `read_symbol` calls (~840 tok each, 104 s and 127 s),
then a `read_file` and a forced answer (115 s + 53 s). Answer quality was good; the time went into tokens.
- Prefill stayed ~7-8 tok/s regardless of context length (up to ~2.5k tokens).
- Tool results are token-dense: ~1.8 KB of TypeScript added ~850 tokens (~2.1 bytes/token), so byte and "estimated token"
  budgets understate the real cost by ~1.7x for code. Rule of thumb: **1 KB of code ≈ 480 tokens ≈ 60 s of prefill.**
- Fixes: repeated identical calls are answered locally in ~25 tokens; cut-off results say how to continue; `--obs` sets
  the per-result cap (default 1200 B); the top retrieval seed may use up to 70% of the pack for its body.
- Single-shot alternative (no tool loop): `bc ask "…" --steps 0 --pack 900`.

## Managed API containers (no more hand-typed `docker run ... api`)

BlueCheese starts and stops `roaster api` containers itself. `roaster serve` (model + GPU) stays a process you start;
the API containers only talk to it over the shared socket folder.

```bash
cp bluecheese.config.example.json bluecheese.config.json   # image, socketDir, basePort, maxApis, named profiles

pnpm bc ask "how does X work" --root .                 # starts its own API, answers, stops it
pnpm bc ask "…" --profile quality --ctx 16384          # a named profile from the config, with overrides
pnpm bc ask "…" --keep-api                             # leave the API running afterwards
pnpm bc runtime up --count 2 --profile default         # 2 API servers on the next free ports from basePort
pnpm bc runtime status                                 # name, URL, health
pnpm bc runtime down                                   # stop everything BlueCheese started
```

- `maxApis` is a hard limit across processes (containers are found by label `bluecheese.managed=1`).
- Ports are the next free ones from `basePort`, so an existing `roaster-api` on 8080 is skipped (or `docker rm -f roaster-api`).
- Containers started by a command are removed when it ends, on Ctrl+C / SIGTERM, and on crashes. `runtime up` is the exception.
- Each API has its own `--context`, `--max-tokens`, `--think`, routing (`--cache-route`, `--route-j`, …) and sampling defaults,
  so one API can be fast (`cache-route 1`) and another careful (`cache-route 0`, `route-j 4`).
- Slots belong to `serve`: every session on every API takes one, so total concurrent sessions ≤ `serve --max-slots`.
- Use an existing API instead with `--url http://…` or `BC_BASE_URL`.

## Chat: one session, many questions

```bash
pnpm bc chat --root /path/to/project          # starts its own API, keeps one session across questions (not saved: use the extension for saved chats)
bluecheese> how does retrieve pick which nodes get source
bluecheese> and what about repoMap          # follow-up: no system prompt, no code the model already saw
bluecheese> :reset                          # empty the context (next question re-sends the instructions)
bluecheese> :quit                           # stops the API container
```
The system prompt and tool list are sent once. Code already sent is not sent again (`retrieve(..., { sent })`), and the
session is reset automatically when the context is more than 55% full. A short follow-up costs seconds, not minutes.

### Third `bc ask` run (managed API, 275 s)
API container ready in 0.6 s and removed afterwards. Step 1 produced malformed JSON; the retry went back as a 54-token
message and cost 6.7 s, but it used up one of the three tool steps. Fixes: near-JSON tool calls are repaired
(missing colons or commas, single quotes, full-width punctuation, `tool(arg="x")`), failed attempts no longer count
toward `--steps` (two in a row end the loop), and the raw text of a bad call is shown.

### First `bc chat` session (what it taught us)

Q1 "list the errors in the project" took 485 s and ended with a raw tool call as the "answer"; the claimed bug (a missing
`return` in `chatOnce`) was false: the model had only seen lines 128-207 in cut-off pieces and reported the unseen end as missing.
Overlapping `read_file` ranges re-paid for text already in the context, a "continue" answer was cut at 400 tokens without a
notice, and the automatic reset silently dropped the thread. Changes:
- `diagnostics` tool: exact compiler errors (tsconfig.json aware, hides "cannot find module" noise). For "errors/bugs"
  questions the system prompt says to call it first; it is cheap and cannot hallucinate.
- Reads never repeat: line ranges already shown in the conversation are skipped, with a note saying so.
- System prompt: report only problems seen in code actually read; say so if a function was only partly seen.
- A forced final answer that comes back as a tool call is retried once with a firmer message; a stray `<tool_call>`
  closing tag is tolerated.
- Final answers get 600 tokens (`--max-tokens`) and a notice if still cut off.
- Automatic reset happens when the next question may not fit (reserve ~2200 tokens) and carries a short recap of the last
  two answers; `bc chat` now defaults to a 16K context. `:reset` still clears everything.
- Realistic scope: this reads a few hundred lines per question. Whole-project reviews need tools like `diagnostics`,
  not code reading.

### Second `bc chat` session
"Any type errors?" → one `diagnostics` call, exact answer, 109 s (94 s of it is the first message). A review of `chatOnce`
for logic bugs took 432 s, read the whole function without re-reading anything, and then listed 5 "bugs" that were all wrong,
nitpicks or intended behaviour. Models of this size invent plausible bugs when asked to find them: treat such answers as
hints to check, never as findings. Mitigations now: the prompt demands a line number and a failing input for each claim
and allows "No bugs found"; code lines are numbered so claims can be checked; `--think` (slower, reasoning stays in
the context) is available to test whether thinking cuts the false positives. Prefer deterministic checks (diagnostics,
and later lint/tests) over model opinions.

## VS Code extension

`packages/vscode-ext` is a sidebar chat built on `ChatController`. **You run `roaster serve`; BlueCheese is the client**: a
**switch** (starts/stops its own API container; checks for the serve socket; it lives in ⚙ Settings → Connection, and the chat header is just a status dot, the state and a Connect button when needed), a **slots** budget (1 main conversation + `slots − 1`
**helpers**: extra conversations the model can hand code-reading questions to via the `explore` tool, so the main context
stays small), a status-bar item, a **Think toggle next to the chat box**, a settings panel (number boxes; sliders only for temperature,
top-p and the two routing fractions; **Unlimited** options for tool steps, helper steps and reply length), and auto-connect when VS Code
starts. Helpers keep the main context small and slots free; they do not make answers faster.
Install `bluecheese-vscode-0.0.8.vsix` (`code --install-extension …`) or build with `pnpm --filter bluecheese-vscode package`;
for development press F5. See packages/vscode-ext/README.md.
### Live tool calls and context bar

A tool row opens the moment the model starts a tool call and shows the call **as it is written** (for `write_file`, the code appearing), with the tool's name as soon as it is known and a running timer. When the call has been read it is shown in full (code keeps its line breaks) while the tool runs; if it needs your OK the row says *waiting for you*. When the result arrives the row folds to one line with the outcome (`✓ Created a.py (2 lines).` / `✗ Error: …`; open it for the full call and result). The folded trace lists the tools in order (`list_files → read_file → write_file · 3 tool calls · 61s`). The context bar under the box now grows while the model reads and writes: exact numbers from the server at every step, an estimate (`~5.2k / 16k`, a token per streamed piece and ~3.4 bytes per token of prompt) in between.

### Chats and saved context

Every conversation is a **chat**, saved per project folder in `<project>/.bluecheese/chats/` (one JSON file each). The ☰ button opens a sidebar with the
chats of that folder (grouped by day, searchable, rename ✎, delete 🗑 with a second click to confirm, **+ New chat**). The one that was open last
is shown again after a restart. A chat has two halves:

| Half | Where | What it does |
|---|---|---|
| Transcript | `.bluecheese/chats/<id>.json` (written as you go, atomically) | Your questions, the answers, which tools were used (with their results), the speed line. Shown as it was when you reopen the chat. |
| Context | `roaster serve`'s side: `<Context folder on the server>/<project>/<chat id>/` via the API's `save` / `restore` | The model's own memory of the chat (KV window, recurrent state, slid-out part, pinned system prompt). Opening the chat restores it, so the next question carries on exactly where it stopped, with no new system prompt and no re-reading. |

If the context cannot be restored (it was never saved, the server restarted without that folder, another model), BlueCheese starts empty and gives the model
a short recap of the last three exchanges; it says so in the log. The **Reset conversation** button is gone from Settings: use **+ New chat**
(the old chat stays in the list). "Apply to a new chat" in the system prompt editor does the same after saving the prompt.

**The system prompt is cached too.** Each chat's stored context contains its pinned system prompt, so reopening a chat never re-reads it. A *new* chat used to read the system prompt and tool list again every time (about 1.5k tokens, over a minute at 17 tok/s). Now the first new chat sends the system prompt alone (plus a one-word `Ready.` turn and a one-token reply: the same prefill the first question would have paid), stores the server's KV cache for it with `save` in `<Context folder on the server>/<project>/_prefix/<hash of the prompt and tools>`, and every later new chat `restore`s that instead, so only the question is read. The cache is keyed by the exact system text, so changing the system prompt, the tools (turning one off, MCP servers coming or going) or the helper settings makes a new one; the old one is deleted if *Context folder on this computer* is set (otherwise it stays on the server, about 125 MB each). It works across restarts. It needs *Save the context* to be on; *Reuse the system prompt cache* switches it off. Any problem (nothing stored yet, another model, a full disk, a busy session) falls back to the old way and says so in the log; a failed store is not retried every chat. The `Ready.` turn stays in each new chat's context (a few tokens). Tested against the mock server only, which follows USAGE.md's `save` / `restore` description.

Settings (group *Chats & history*):
- **Save the context**: *after every answer* (default; the save runs in the background, the next question waits for it), *when I leave the chat*, or *never (text only)*.
  A saved context costs about 40 KB per window token + 65 MB (a 16k window is roughly 700 MB per chat, replaced in place, not added to). Sliding-window spill is included.
- **Context folder on the server**: a path **inside the `roaster serve` container** (default `/state/bluecheese`, a folder under the documented `/state` mount). With
  `serve --save-root DIR` give the path relative to it. If saving fails, the error says which folder and how to fix it, once; the chat keeps working from its transcript.
- **Context folder on this computer** (optional): the same folder as the host sees it. When set, deleting a chat deletes its stored context too; otherwise the log tells you the folder to delete.

Transcripts can contain tool results (file contents, MCP output): they stay in the project's `.bluecheese/` folder, which BlueCheese git-ignores.

### Tools and MCP

The **🛠** button in the header (and the *N tools* chip above the chat box) opens the tool list: everything the model can call, where it comes from, whether it is
on, whether it fits the prompt, whether it is read-only or asks first, and how many times it was used in the open chat. Click a name to see how the model calls it.
A checkbox turns a tool off: it is not offered in new chats, and a call to it is refused at once.

Built-in tools: read-only `diagnostics` (TypeScript compiler errors), `list_files`, `find_files`, `grep`, `outline`, `check_file`, `read_file`, `search_chat`, `read_turn`, `explore` (helpers); and `write_file` / `edit_file` / `replace_lines`, which change files and ask first. The whole tool list plus the system prompt is about 5 KB (~1.5k tokens) of every chat's first message: turn tools off in the list to save prefill time.

**MCP servers** are read from `.bluecheese/mcp.json` (created by *BlueCheese: Open MCP Servers Config*, git-ignored), `.mcp.json` and `.vscode/mcp.json` (later wins):

```json
{ "mcpServers": {
    "files":  { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "${workspaceFolder}"] },
    "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${env:TOKEN}" } } } }
```

- Transports: stdio (`command`, `args`, `env`, `cwd`) and Streamable HTTP (`url`, `headers`). Not supported: the old HTTP+SSE transport, OAuth sign-in (use a header), and server features other than tools (resources, prompts, sampling).
- Servers start when BlueCheese is switched on. **Each server needs your permission once** (a modal shows the command or URL; a changed command, URL or environment asks again), and nothing starts in an untrusted workspace.
- Tools are named `server__tool`. Approval (*Ask before MCP tools run*): by default a tool asks first unless the server marks it read-only; the card offers *Allow once / Always allow / Deny*; Stop cancels it. *Never ask* is available.
- **Prompt budget.** Tool descriptions are paid for in every conversation, so each is shortened to one sentence and the MCP part of the system prompt is capped (*MCP tool list size*, default 3500 B). Tools that do not fit are marked *not offered: too big*.
- A tool list that changed since a chat's pinned system prompt was written is sent to the model with the chat's next message.
- Results are cut to *MCP result size* (default 2400 B). Images and binary content are replaced by a note.
- *Reload servers* re-reads the config and reconnects (and asks again about refused servers).

### Writing files and searching the chat

**`write_file(path, content, append?)`** creates a file (folders included) or replaces one; `append=true` adds to the end, so a file longer than ~80 lines is written in parts
(a reply is limited by *Reply token limit* in Settings, default 1500 ≈ 100 lines; a call that hits the limit is cut off, never run, and the model is told to write less and append). **`edit_file(path, old, new)`** replaces one exact piece of text, which must occur once
(the error says how many times otherwise); it keeps the file's line endings. The tool prompt shows a single call format (JSON); the parser still accepts the XML and mixed styles and garbled tags such as `<tooltool_call>`, but does not advertise them (showing two formats made the model blend them).
Both refuse paths outside the project, inside `.git`, `node_modules` or `.bluecheese`, and symlinks that lead outside; a file the model changed is forgotten by the "already read" tracker, since its line numbers moved.

**A reply cut off mid-file is not lost.** If the reply limit hits while the model is writing a `write_file` call, the complete lines that arrived are kept: they are written (after the usual approval, and the card shows exactly that part) and the model is told how many lines were written, what the last one was, and to continue with `write_file(..., append=true)` instead of starting over. Nothing is written if not even one full line arrived, if the path itself was cut off, or for `edit_file` (a half edit is never applied). A call that fails for any other reason keeps its row in the chat with everything the model wrote, so you can open it and copy it. The parser also understands the mixed style some models write, `<function=write_file>{"arguments": {...}}`, with or without the `<tool_call>` wrapper.

**Small mistakes should cost a small edit, not a rewrite.** The prompt and the tool descriptions tell the model to use `edit_file` or `replace_lines` for any change to an existing file and to send only the changed lines. `replace_lines(path, start, end, new)` works by line numbers (as `read_file` shows them), so the model has no text to copy exactly; `end = start - 1` inserts, empty text deletes, and the result shows the lines around the change. When `edit_file` does not match, the error says why: the same lines exist with different indentation (with the exact text and numbers to use), or the closest text is near line N. A `write_file` that replaces an existing file is answered with a reminder to use the small tools next time. Formatting mistakes cost nothing: if a `write_file` call is malformed but its text is there (unescaped quotes in code, a missing brace), the content is recovered and written as it was (after approval) and the model is told nothing needs to be sent again; quotes inside code no longer cut the content short (before, an unescaped quote silently truncated the file). Limits: if a mistake is inside a long file and the model chooses to rewrite anyway, that is still slow; the failed attempt also stays in the context (it cannot be removed), so a long rewrite adds to it.

**Pointing the model at the lines, so it never reads whole files.** "Fix the files" used to send the model through a file 80 lines at a time (a minute of prefill each). Two read-only tools and an automatic check replace that:
- **`check_file(path)`** is a syntax check with line numbers: JavaScript / TypeScript / JSX / TSX and the inline `<script>` blocks of HTML (the bundled TypeScript parser; nothing is executed), JSON, Python (`ast.parse` in a short `python3` process; skipped if Python is not installed), CSS and HTML structure (an unclosed `<script>` / `<style>`, a file that ends before `</html>`, unbalanced braces: how a cut-off file looks). Line numbers are the lines of the real file, also for scripts inside HTML. It finds syntax errors only, not logic errors.
- **`outline(path)`** lists the functions, classes and sections with line ranges (TS/JS, Python, HTML with its scripts, Markdown), so the model reads only the range it needs.
- **Every change is checked automatically**: `write_file`, `edit_file` and `replace_lines` end with `Syntax check: OK` or the problems with line numbers and the source line, plus "fix only these lines, do not rewrite or re-read the whole file". A new file of 60+ lines also gets its outline. A cut-off part (and `append` parts) are not checked until the file is finished.
The prompt tells the model to use `outline` instead of reading whole files and to start a fix with `check_file`. Limits: it only catches what a parser catches (a game that parses but plays wrongly looks fine), unknown file types are not checked, and it cannot make the model choose well: it makes the right move cheap and shows where to look.

**Each change asks first**: a card shows the path and the text (*Allow once / Always allow / Deny*; Deny tells the model so). *Ask before changing files = Never ask* removes the card: use it only with the project in git.
The changes are made on disk directly (there is no undo button; use git).

**Reply limit and "Run to the end".** Above the chat box, **Reply: N** picks the most tokens the model may write in one reply (600 / 1500 / 3000 / 6000 / **Unlimited**, or any number set in Settings); it is the same setting as *Reply token limit*. The **Run to the end** switch is for "give it a task and let it finish": it sets the reply limit to Unlimited, *Max tool steps* to Unlimited and *Ask before changing files* to Never ask, in one click. Turning it on shows a confirmation (it lets the model change files unattended; there is no undo, so use git) and remembers your old values; turning it off puts them back. **Stop** always works, a model that repeats the same call is still stopped, and the sliding window keeps a long run from running out of room.

**`search_chat(query, all_chats?)`** and **`read_turn(turn, offset?)`** let the model look back. When a window slides, the old part moves to the SSD as KV tensors, which no tool can read, and the model
can no longer quote it. The saved *transcript* still has it, so the model can search it (words, ranked by how many match; snippets with turn numbers) and read a turn again. `all_chats=true` also searches the project's other saved chats.
What is searchable: your questions, the answers, and each tool result up to 1.5 KB. Not searchable: the model's thinking, the rest of a long tool result, the turn being asked right now.

### See what it is doing (0.0.6)

Your message and the answer are normal chat bubbles; everything the model does in between is thin text, no boxes:

- **The answer streams in token by token.** (A reply that starts with a tool call is recognised as a tool step and not shown as an answer.)
- **Thinking** (Think on) is written out live in dim italics, then folds into a `thought for 6s` line you can open. If Think is on but the server sent no
  reasoning, a line says so. A reply that starts with an inline `<think>…</think>` is treated as reasoning too.
- **Each tool is one row**: name, what it was asked, how long (`read_symbol  buildContext  0.4s`). Open it for the full call and result.
  `explore` shows `3 questions`; its helper branches are rows inside it (`helper 2 · 3 steps · 5s`), each with its own tool rows.
- When the answer arrives, all of that folds into one quiet line (`1 tool call · 3 helpers · 41s`).
- **Speed** sits in small text right under the answer: `prefill 7.4 · decode 6.6 tok/s · 41s` (while it streams: `decoding ~6.4 tok/s`).
  Prefill = new prompt tokens / time to first token (short prompts are left out: they only measure request overhead); decode = the other tokens /
  the remaining time; both are totals over the main conversation's steps for that question (helpers excluded: they share the model).
- **A context bar** under the text box shows the window in RAM (blue), the pinned system prompt (purple) and, in words, what has slid out to SSD
  (`5.2k / 16k · 1.1k on SSD`). It updates at every step and turns amber above 85%.

### Settings that change while it runs (0.0.6)

Every setting in the panel is tagged with when it applies:

| Tag | Settings | What happens |
|---|---|---|
| **applies now** | context window, routing (`cache-route`, `route-j/m/alpha/p`), sliding, kept tokens, slots, helper settings, tool/reply limits, sampling, Think | `PATCH /v1/sessions/{id}` on the live session(s). Nothing restarts, the conversation and the helpers keep their context. A bigger window brings slid-out context back from SSD; a smaller one moves the oldest tokens out |
| **next question** | tool result size, MCP result size | read when the next question starts |
| **needs restart** | Docker image, socket folder, ports, max API containers, "Use existing API at", project folder, the container's default max tokens | the API container itself changes |

- Changing a session setting **while a question runs** never interrupts it: **Think, the tool-step limit, the reply limit and sampling
  take effect at the very next step**; session-level changes (context window, routing, sliding) are applied the moment the question ends.
- A value the server refuses (bad number, not enough RAM for the bigger window) leaves the session as it was and shows why once.
- Lowering **Slots** closes idle helpers immediately; helpers that stay keep what they read.

### No limit (and the guard that makes it safe)

**Max tool steps**, **Helper tool steps** and **Reply token limit** have an **Unlimited** option (stored as `-1`; unchecking restores your last number).
**Stop API when idle** shows `0` as **Never**. Because sliding means the context cannot run out, unlimited is safe for the window;
for the loop, a model that repeats the same call three times in a row is stopped and asked for its answer, and **Stop** always works.
Limits you cannot lift: the size of a tool result and of the system prompt (a request is at most 16000 bytes).

### Helper branches

**Helper branches per call** is how many questions the model may put into one `explore` call. The default is **Same as slots**; a number
or Unlimited can be chosen. If there are fewer helpers than questions, the helpers take them in turn (a queue), so more branches than
helpers costs time, not slots.

### Context sliding

On by default (`api.slide`, `api.keep`). Instructions and tool list are sent as a pinned system turn; when the window fills it slides and the
old part goes to `serve`'s state directory (about 40 KB per token: put `--state-dir` on an SSD). The panel shows
`window / context · N slid out to SSD · N pinned` after each answer. When something slides out, BlueCheese forgets which code it had shown
(so it may read a file again rather than point at text the model can no longer see); a new chat resets the session and deletes the spilled part (a saved chat keeps its own copy). With sliding off the
old behaviour returns: reset with a short recap when the context is nearly full.

What was tested (no real VS Code was available while writing it):
- Controller against a fake Roaster API limited to 3 slots: slots=3 → main + 2 helpers, 3 questions sent to `explore` are capped at 2,
  helpers reused on the next question (no new slots), slots=1 → no helpers, helpers disabled → 1 slot, connecting takes no slots,
  disconnecting frees them, no serve socket → clear error, Stop mid-question, idle shutdown.
- Extension bundle with a fake `vscode` module: writing a setting, refusing unknown keys, status-bar states, remembering "on",
  auto-connect after a simulated restart, lowering slots closes helpers, no containers left after deactivate, your `serve` untouched.
- 0.0.6, against the mock API (`pnpm tsx packages/core/scripts/live-settings-test.ts`): sessions created with explicit settings; context
  window / routing / keep / sliding changed live; a bad value refused once; a change during a question deferred until it ends; Think
  flipped mid-question reaching the next step; unlimited steps and reply tokens (and the repeat guard); helper branches (slots 2 → 2,
  slots 4 → 3, 1, unlimited); helper settings and slot count changed live; sliding on (no reset, window/SSD/pinned shown) and off (old
  reset); a resize the server refuses.
- 0.0.6, real `chat.html` in jsdom with the bundled extension and the mock API (`node packages/vscode-ext/scripts/webview-e2e.mjs`, needs
  `jsdom`): 30 settings listed, 4 sliders, an "applies" tag on each, Think above the chat box and in sync with VS Code's settings, Unlimited
  and branch controls, restart bar only for Docker/connection settings, Think and context window changed during a question, the answer
  growing token by token, tool rows with helpers nested in the explore row, thinking shown then folded, the speed line under the answer and
  the context bar. Also (`live-settings-test.ts`): inline `<think>` handling and the events the UI is built from.
- NOT tested: whether the real model writes good tool calls for `write_file` / `edit_file` (the XML style is the safer one), how it looks (no browser was available: the structure and behaviour are tested, the CSS is not), real webview rendering and CSP (jsdom does not enforce them), real VS Code API behaviour, real Docker, the real model, how Qwen
  uses `explore`, the real server's `PATCH` / sliding (the mock follows USAGE.md; the real one may differ), SSD spill sizes in practice.
  Expect first-run fixes; send the Output panel ("BlueCheese") and the webview developer-tools console.

## Roaster wishlist (from reading api.c)
1. ~~Keep a slot alive across requests~~ (done: sessions). Next: fork/checkpoint a session at a position, so a primed system prompt can be reused per task and compaction can rewind.
2. Faster prefill: ~7 tok/s ≈ decode speed suggests no batching benefit; check the batch size and expert I/O.
3. Send HTTP headers (or SSE keep-alive comments) as soon as the request is accepted; today nothing is sent until the first token.
4. ~~Notice client disconnects~~ (done).
5. Stop sequences; structured `tool_calls` in responses.

## Suggested Roaster settings for the agent
- `serve`: `--max-slots 4` is plenty; extra slots cost ~400 MB each at `--context 8192`. Put `--state-dir` on an SSD: slid-out context is written there (~40 KB per token).
- `api`: `--context 8192 --max-tokens 1024 --cache-route 1`; send `"think": true` only for planning steps.
- If tool-call JSON is flaky, test `--route-j 4` (or `--cache-route 0`) before blaming the prompt.

## What works today
- File tools (no index): read-only `list_files`, `find_files`, `grep`, `read_file`, `diagnostics`, plus `write_file` / `edit_file` with approval, and `search_chat` / `read_turn`; MCP tools from stdio and HTTP servers, with approvals.
- Saved chats per project with context save/restore through Roaster's `save` / `restore`, a sidebar, and a tool list.
- Roaster client with streaming, 503 retry, client-side stop, byte guard; text tool protocol; prompt fitter.

### Tested in 0.0.8 (against the mock API, no real model / Docker / VS Code)
- `pnpm tsx packages/core/scripts/chats-mcp-test.ts` (also covers write/edit, search_chat, approvals for file changes): transcript saved as you go; context saved after the answer / when leaving / never; a new chat; reopening restores the context and sends no new system prompt; a failing save explains itself once and the chat continues from a recap; restart shows the last chat; rename, delete, path-safe ids; MCP config files and precedence; a real stdio MCP server (stray stdout, read-only vs asks-first, approval deny / once / always, Stop during a prompt, budget, disabled tool refused, untrusted/unconfirmed server not started); Streamable HTTP with JSON and SSE replies, session id, expanded headers; array/object arguments; cancel; a server that cannot start.
- `pnpm tsx packages/core/scripts/live-settings-test.ts`: the settings tests from 0.0.6, unchanged apart from the graph.
- `node packages/vscode-ext/scripts/webview-e2e.mjs` (needs `jsdom`): the real `chat.html` with the bundled extension: settings, streaming, the sidebar (list, search, new, open, rename, delete), tools view (built-in + MCP rows, toggles), approval card, no Reset button.
- NOT tested: whether the real model writes good tool calls for `write_file` / `edit_file` (the XML style is the safer one), how it looks (no browser: structure and behaviour are tested, the CSS is not), real webview CSP, real VS Code APIs (the modal prompt, the settings UI), real Docker, the real model (how Qwen uses 8 tool steps without a code pack, or the MCP tools), the real server's `save` / `restore` (the mock follows USAGE.md), real MCP servers beyond the fake one.

## Known gaps / next
- No code graph / retrieval: the model must find code with `grep` / `find_files`, which costs steps (default max tool steps raised from 5 to 8). An alternative is being looked for.
- MCP: tools only; no OAuth, no legacy SSE transport, no resources / prompts.
- Non-TypeScript projects get no `diagnostics`.
- Ideas for upstream Roaster: stop sequences, a delete endpoint for saved contexts, larger prompt limit, native tool parsing.
