# BlueCheese 🧀

**A local-first AI coding agent for VS Code, powered by Roaster.**

BlueCheese brings an AI coding agent directly into your VS Code workspace. It can explore your codebase, understand project structure, edit files with your approval, run syntax checks, and connect to external tools through the Model Context Protocol (MCP).

Conversations are saved locally, and supported Roaster context persistence lets you resume conversations with the model's KV cache intact.

> **Local-first means your model runs on your own machine.** BlueCheese does not use a hosted LLM API. You provide the Roaster model server and BlueCheese connects to it.

**Current release: v0.0.8**

---

## Installation

### Option 1: Install the VSIX (recommended)

1. Download `bluecheese-vscode-0.0.8.vsix` from the [latest GitHub Release](https://github.com/KKB007X/BlueCheese/releases/latest).
2. Open a terminal in the directory containing the downloaded file.
3. Run:

   ```bash
   code --install-extension bluecheese-vscode-0.0.8.vsix
   ```

Alternatively, in VS Code:

1. Open Extensions (`Ctrl+Shift+X`).
2. Open the `...` menu.
3. Select **Install from VSIX...**.
4. Choose the downloaded file.
5. Restart VS Code.

A cheese icon will appear in the Activity Bar.

### Option 2: Build from source

Requirements: Node.js 20+, pnpm 9.

```bash
git clone https://github.com/KKB007X/BlueCheese.git
cd BlueCheese

pnpm install
pnpm --filter bluecheese-vscode package:offline
```

The VSIX will be generated at:

```text
packages/vscode-ext/bluecheese-vscode-0.0.8.vsix
```

---

## Requirements

BlueCheese is a client for the Roaster inference server. Installing the VS Code extension alone is not enough to run the agent.

| Requirement | Purpose |
|---|---|
| VS Code 1.90+ | Extension host |
| Docker | Runs the BlueCheese API container |
| Roaster | Local model inference server |
| GGUF model | Model loaded by Roaster |
| SSD storage | Model files and persistent conversation contexts |

The reference configuration uses a Qwen3.6-35B-A3B GGUF model in Q4_K_M format.

See the [Roaster repository](https://github.com/KKB007X/Roaster) and its usage documentation for model setup, Docker configuration and GPU support.

**Platform note:** Development and testing have primarily targeted Linux with AMD Vulkan graphics. macOS and Windows have not been tested.

---

## Getting started

### 1. Start Roaster

Build the Roaster Docker image and start `roaster serve` with your model.

For example, the following is a reference configuration. Adjust the paths, image name and hardware settings to match your installation.

```bash
MODEL_DIR=/path/to/models
MODEL_FILE=your-model.gguf
GPU=/dev/dri/renderD128

GPU_GROUP=$(stat -c %g "$GPU")

SOCK_DIR=/tmp/roaster
STATE_DIR=/path/to/roaster-state

mkdir -p "$SOCK_DIR" "$STATE_DIR"

docker run --rm -it --name roaster \
  --device="$GPU" --group-add "$GPU_GROUP" \
  --ulimit memlock=-1:-1 \
  -v "$MODEL_DIR":/models:ro \
  -v "$SOCK_DIR":/run/roaster \
  -v "$STATE_DIR":/state \
  roaster:dev \
  serve --model "/models/$MODEL_FILE" \
        --socket /run/roaster/roaster.sock \
        --state-dir /state
```

Wait until Roaster reports that it is listening on its socket.

See the [Roaster documentation](https://github.com/KKB007X/Roaster) for the complete setup and performance configuration.

### 2. Open a project in VS Code

Open the folder you want BlueCheese to work on.

### 3. Connect

1. Click the cheese icon in the Activity Bar.
2. Press **Connect**.
3. BlueCheese checks the Roaster socket and starts its API container.
4. Once connected, start chatting.

You can ask questions such as:

- "Explore this project and explain its architecture."
- "Find where authentication is implemented."
- "Create a Minesweeper game in index.html."
- "Find and fix the syntax errors in this project."

---

## Features

### Project-aware coding agent

BlueCheese can explore your workspace using tools for:

- File and directory discovery.
- Text search with grep.
- Reading source files.
- Extracting code outlines.
- Syntax checking.
- TypeScript diagnostics.

It does not require a pre-built code index.

### Controlled file editing

The agent can create and modify files using small, targeted edits.

Before a change is applied, BlueCheese presents an approval card:

- **Allow once**
- **Always allow**
- **Deny**

After edits, supported files are automatically checked for syntax errors.

### Live tool execution

Tool calls are displayed as they happen, including their arguments, execution results and approval status.

You can inspect what the model is doing instead of waiting for an unexplained final response.

### Persistent conversations

Chats are stored per project. You can create, search, rename, delete and resume conversations.

With Roaster context persistence enabled, BlueCheese can save and restore the model's KV cache, allowing a conversation to continue without rebuilding its entire context.

### Context management

Long conversations can use context sliding. Older context is moved to SSD storage while the system prompt remains pinned.

The agent can also search previous conversation transcripts using `search_chat` and `read_turn`.

### MCP integration

Connect Model Context Protocol servers to extend the agent with additional tools.

Supported transports:

- Standard I/O (stdio)
- Streamable HTTP

MCP tools can require approval before execution.

### Parallel helpers

The `explore` tool can delegate codebase questions to helper conversations using additional Roaster slots.

Each helper has its own context and returns a concise result to the main conversation.

### Run to the end

An optional mode removes reply and tool-step limits and disables file-change approval prompts after confirmation.

This allows longer autonomous tasks, but should be used carefully.

---

## Architecture

```text
                 VS Code
             ┌───────────────┐
             │  BlueCheese   │
             │   Extension   │
             └───────┬───────┘
                     │ HTTP
                     ▼
             ┌───────────────┐
             │  Roaster API  │
             │ Docker        │
             └───────┬───────┘
                     │ Unix socket
                     ▼
             ┌───────────────┐
             │ roaster serve │
             │ Model + GPU   │
             └───────────────┘
```

BlueCheese manages the lightweight API container. The user starts and manages `roaster serve` separately.

The model server owns inference and GPU resources. BlueCheese manages the agent conversation, workspace tools, approvals and extension interface.

---

## Safety and limitations

BlueCheese is an experimental local coding agent. Local models can produce malformed tool calls, incorrect edits or unexpected results.

Keep your projects under version control and review changes.

Important limitations:

- File changes do not have an automatic undo mechanism.
- Run to the end can modify files without individual approval.
- Syntax checks cannot detect every logical or runtime bug.
- The code graph/index feature is not included in v0.0.8.
- MCP currently supports tools, not resources or prompts.
- OAuth and legacy HTTP+SSE transport are not supported.
- Stored contexts require disk space and the same model configuration for reliable restoration.

### Testing status

The project includes automated tests covering the agent controller, file tools, edit handling, syntax checks, MCP integration, conversation persistence, context restoration and the extension panel in a simulated environment.

**The real-model, end-to-end workflow has not yet been fully validated.** Real Roaster inference, Docker integration and the complete VS Code experience still require further testing.

---

## Project structure

```text
packages/
├── agent/       Roaster client, agent loop and runtime management
├── core/        File tools, conversations, MCP and chat controller
├── cli/         Command-line interface
└── vscode-ext/  VS Code extension and webview

docs/
├── ROASTER_USAGE.md
└── DEVELOPMENT.md
```

## Development

Install dependencies:

```bash
pnpm install
```

Type-check:

```bash
pnpm typecheck
```

Build the extension:

```bash
pnpm build:ext
```

Package the VSIX:

```bash
pnpm --filter bluecheese-vscode package:offline
```

Run tests:

```bash
pnpm tsx packages/core/scripts/chats-mcp-test.ts
pnpm tsx packages/core/scripts/live-settings-test.ts
```

For extension development, open the repository root in VS Code and press `F5`.

---

## License

No license has been specified yet.

---

**BlueCheese** — local models, persistent context, and coding tools inside VS Code.