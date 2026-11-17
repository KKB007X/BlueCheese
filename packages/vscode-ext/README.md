# BlueCheese for VS Code

A sidebar chat that answers questions about your project with read-only code tools, MCP servers and your local Roaster model. Chats are saved per project.
**You run `roaster serve` yourself; BlueCheese is only the client**: it starts a small API container, talks to your server
through its socket, and stops the API container when you switch it off. It never starts, stops or configures the model server.

## Install (stays installed)

```bash
code --install-extension bluecheese-vscode-0.0.8.vsix
# or build it yourself:  pnpm install && pnpm --filter bluecheese-vscode package
#           (offline:    pnpm --filter bluecheese-vscode package:offline)
```
Restart VS Code. A cheese icon appears in the activity bar and a **BlueCheese** item in the status bar.
The extension starts with VS Code and, by default, connects again if it was on last time.

## Which project does it analyze?

The folder open in VS Code (the first one in a multi-root workspace). The panel shows it in ⚙ Settings → Connection ("Project: name  path"), not in the main view.
To analyze a different folder without opening it, set **Project folder** (absolute path or `~/…`); changing it closes the current
connection and conversation. BlueCheese keeps its chats and MCP config in `<project>/.bluecheese/` (it writes a `.gitignore` there so they are not committed).

## Use

1. Start `roaster serve` the way you always do, with a socket folder (default `/tmp/roaster`).
2. Click the cheese icon and press **Connect** in the slim header (or click the status bar item). The header is only a status dot, the state and the ⚙; the on/off **switch**, the API address, Slots and the project folder live in ⚙ Settings → Connection. BlueCheese checks for the socket and starts
   its API container. It takes no slots until you ask something.
3. Ask. Asking while it is off connects first.

If you already run the API yourself, set **Use existing API at** (`http://127.0.0.1:8080`, `127.0.0.1:8080` or just `8080` all work) and nothing is started.

## Slots and helpers

**Slots** (⚙ Settings → Connection, 1–16) is how many slots BlueCheese may use at once. If your server has 6 and you give BlueCheese 4,
two stay free for other things. The main conversation takes 1; the other `slots − 1` are **helpers**.

When a question needs reading several functions, the model can call `explore` with one question per line. Each question goes to a
helper: its own conversation with its own fresh context. It does the reading and returns a short answer, so the main conversation
only receives summaries and its context lasts much longer. Helpers keep their context between subtasks (their instructions are
sent once, and they remember what they read) and are reset when nearly full.

What this does **not** do: make answers faster. The model server shares its compute between slots and each helper still has to
read the code. The gain is a smaller main context and the option to keep slots free; the cost is the helpers' setup tokens.
Set **Slots** to 1, or turn off **Use helper slots for subtasks**, to keep everything in one conversation.
Slots are taken only when needed and released when you switch off. Lowering the number closes idle helpers at once.

**Helper branches per call** is how many questions one `explore` call may carry. The default, **Same as slots**, follows the Slots setting;
choose a number or Unlimited. When there are more questions than helpers, the helpers take them in turn.

## The panel

- **Think** (the toggle just above the chat box): the model reasons before replying. Slower, and the reasoning counts toward the reply token
  limit. It applies to the very next step, even while a question is running.
- **⚙ Settings**: number boxes (sliders only for temperature, top-p and the two routing fractions), checkboxes (flags) and text boxes (paths
  and names), grouped as Slots & connection / API & context / Agent & sampling / Chats & history / Tools & MCP / Docker, with a live estimate of the memory your slots can
  use. **Max tool steps**, **Helper tool steps** and **Reply token limit** have an **Unlimited** option; **Stop API when idle** has **Never**.
  Each setting is tagged **applies now**, **next question** or **needs restart**. The same settings are in VS Code's Settings (search "BlueCheese").
- **Chat**: Enter sends, Shift+Enter adds a line, **Stop** cancels. **☰** opens the chats of this project (saved as you go; **+ New chat** replaces the old Reset button; each chat comes back with the model's own memory of it when the server stored it). **🛠** lists every tool the model can use, built-in and MCP, with switches. Grey lines show each step;
  After each answer the bar shows the window, what slid out to SSD and what is pinned.
- **What the model does** is shown as thin text between your message and the answer: **Thinking** is written out live and folds into
  `thought for 6s`; each **tool is one row** (name, what it was asked, time) that opens to the call and result; helper branches are rows inside the
  `explore` row. The answer itself streams in token by token, and folds the activity into one line (`1 tool call · 3 helpers · 41s`) when it is done.
- **Speed** (prefill and decode tokens/s) is in small text right under each answer.
- **Context bar** under the text box: the window in RAM, the pinned system prompt, and how much has slid out to SSD.
- **Right-click → BlueCheese: Ask About Selection** pre-fills a question about the selected lines.
- **Commands**: Switch On/Off, Switch On, Switch Off, Restart, Open Chat, New Chat, Ask About Selection, Open MCP Servers Config, Reload MCP Servers, Stop Roaster API,
  Stop All BlueCheese API Containers.

## Good to know

- Only **needs restart** settings (Docker, ports, "Use existing API at", the container's default max tokens) need a restart; the bar offers it.
  Everything else, including the context window and routing, is applied to the running conversation without losing it. Changed during a
  question, Think / tool limit / reply limit / sampling apply at the next step, and context-window / routing / sliding changes the moment it ends.
- **Context sliding** is on by default: a long conversation never resets, the oldest part moves to the SSD (about 40 KB per token, in `roaster serve`'s
  `--state-dir`: keep it off tmpfs) and the instructions stay pinned. Turn it off in the settings to get the old reset-with-recap.
- If the model server has no free slot you get a clear message: lower **Slots** or free one.
- A chat is saved as you go. **Stop API when idle** (default 0 = never) stores the open chat's context first; opening the chat later restores it.
- For the model's memory to be saved, `roaster serve` needs a folder it can write to, and **Context folder on the server** must name it as the container sees it (default `/state/bluecheese`, under the `/state` mount of the documented `docker run`). Without it the chat still continues, from a short recap.
- MCP servers: see the main README. Each one asks for your permission once; tools that are not read-only ask before they run.
- Closing VS Code stops the API container BlueCheese started. If VS Code crashes, run **BlueCheese: Stop All BlueCheese API
  Containers**, or `docker rm -f $(docker ps -q --filter label=bluecheese.managed=1)`.
- Needs Docker usable without sudo. Any text project can be read; `diagnostics` is for TypeScript. Answers take minutes (prefill ~7 tokens/s).
- It can create and edit files (`write_file`, `edit_file`); every change asks first (setting *Ask before changing files*). Changes are written straight to disk: keep the project in git. MCP tools can do whatever their server does: that is what their approval prompt is for.
- It can search its own chat, including text that slid out of the context window, from the saved transcript.

## Develop

```bash
pnpm install
pnpm --filter bluecheese-vscode build      # then F5 in VS Code ("Run BlueCheese extension")
```
