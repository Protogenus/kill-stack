# Node Process Manager

A VS Code extension that lets you view, inspect, and kill running Node.js processes — right from your editor.

---

## Features

### 🟢 Status Bar Button
A live button in the status bar shows how many Node processes are running. Click it to jump straight to the process panel.

- **Grey** → No Node processes running
- **Orange** → One or more Node processes detected

### 🌲 Node Processes Panel
A tree view in the Explorer sidebar lists every running Node process with:

| Field | Description |
|---|---|
| **PID** | Process ID |
| **CPU %** | Current CPU usage |
| **Memory %** | Current memory usage |
| **Elapsed** | How long the process has been running |

Hover over any entry for a full tooltip with the complete command and all arguments.

### ⚡ Commands

| Command | Description |
|---|---|
| `Node Process Manager: Show Running Node Processes` | Focus the process panel |
| `Node Process Manager: Kill All Node Processes` | Kill every Node process (with confirmation) |
| **Refresh** (toolbar icon) | Manually refresh the list |
| **Kill** (inline icon on each row) | Kill a single process |

### 🚪 Kill on Exit
When you close VS Code, the extension can prompt you to kill any remaining Node processes. You'll see a native system dialog asking whether to kill them or leave them running.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `nodeProcessManager.killOnExit` | `true` | Prompt to kill Node processes when VS Code closes |
| `nodeProcessManager.autoRefreshInterval` | `5` | Auto-refresh interval in seconds (0 = disabled) |

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
cd node-process-manager

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
# Produces: node-process-manager-1.0.0.vsix
```

---

## Platform Notes

| Platform | Process Detection | Kill Method |
|---|---|---|
| macOS | `ps aux` | `kill -9 <pid>` |
| Linux | `ps aux` | `kill -9 <pid>` |
| Windows | `wmic` | `taskkill /PID /F` |

On macOS/Linux, the kill-on-exit dialog is a native system alert via `osascript`. On Windows, processes are killed silently on exit (no blocking dialog is available at that point).

---

## License

MIT
