# Kill Stack

A VS Code extension that lets you view, inspect, and Kill forgotten local server processes right from your editor.

---

## Features

### 🟢 Status Bar Button

A live button in the status bar shows how many local server processes are running. Click it to open the Kill Stack dashboard.

- **Grey** → No local server processes running
- **Green** → One or more local server processes detected

### 🧭 Kill Stack Dashboard

A dedicated webview dashboard gives you a fuller look at local dev servers, tunnels, and runtime processes before you kill anything:

| Field | Description |
|---|---|
| **Framework** | Detected framework, runtime, or tunnel type |
| **PID** | Process ID |
| **Memory** | Current memory usage |
| **Elapsed** | How long the process has been running, when available |
| **Executable** | Full binary path |
| **Arguments** | Full server arguments |

Each process gets its own card with framework labeling, the full command line, and a dedicated kill button, which makes it much easier to tell similar servers apart.

### ⚡ Commands

| Command | Description |
|---|---|
| `Kill Stack: Open Dashboard` | Open the Kill Stack webview |
| `Kill Stack: Kill All Local Servers` | Kill every detected local server process |
| `Kill Stack: Refresh Dashboard` | Manually refresh the dashboard |

### 🚪 Kill on Exit

When you close VS Code, the extension can prompt you to kill any remaining local server processes. On macOS, you’ll see a native system dialog asking whether to kill them or leave them running. You can also toggle this directly from the dashboard.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `kill Stack.killOnExit` | `true` | Kill local server processes when VS Code closes. On macOS, prompt first |
| `kill Stack.autoRefreshInterval` | `5` | Auto-refresh interval in seconds (0 = disabled) |

---

## Installation

### Option A — Install from VSIX (recommended)

1. Open VS Code
2. Press `Ctrl+Shift+P` / `Cmd+Shift+P`
3. Run **Extensions: Install from VSIX...**
4. Select the `.vsix` file

### Option B — Run from source

```bash
# 1. Clone / copy the extension folder
cd node-ext

# 2. Install dependencies
npm install

# 3. Compile TypeScript
npm run compile

# 4. Open in VS Code
code .

# 5. Press F5 to launch an Extension Development Host
```

### Packaging to VSIX

```bash
npm install -g @vscode/vsce
vsce package
# Produces: kill-stack-1.0.0.vsix
```

---

## Platform Notes

| Platform | Process Detection | Kill Method |
|---|---|---|
| macOS | `ps -axo pid=,pcpu=,pmem=,etime=,command=` | `kill -9 <pid>` |
| Linux | `ps -axo pid=,pcpu=,pmem=,etime=,command=` | `kill -9 <pid>` |
| Windows | `Get-CimInstance Win32_Process` | `taskkill /PID /F` |

On macOS, the kill-on-exit dialog is a native system alert via `osascript`. On Windows and Linux, processes are killed on exit without a blocking prompt at that point.

## Detection Scope

Kill Stack detects many common local server frameworks, runtimes, and tunnels, including Node-based dev servers, Python local servers, PHP built-in servers, Ruby app servers, Java/Go local server patterns, `ngrok`, and `cloudflared`.

It is designed to catch common forgotten local processes, not to guarantee detection of every custom framework or one-off command.

---

## License

MIT
