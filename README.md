# Kill Stack

Kill Stack is a VS Code extension for finding and shutting down forgotten local dev servers without leaving your editor.

It gives you a live process count in the status bar, a dashboard for reviewing active local services, and one-click controls for cleaning them up when you are done.

## Why Use Kill Stack

- See which local servers are still running
- Inspect process details before killing anything
- Shut down individual processes or clear everything at once
- Optionally kill leftover servers when VS Code closes

## What You Get

### Status Bar Signal

Kill Stack adds a live status bar button that shows whether local server processes are running. Click it to open the dashboard.

- `Grey`: no local server processes detected
- `Green`: one or more local server processes detected

### Dashboard

The dashboard helps you review what is running before you take action.

| Field | Description |
|---|---|
| **Framework** | Detected framework, runtime, or tunnel |
| **PID** | Process ID |
| **Memory** | Current memory usage |
| **Elapsed** | How long the process has been running, when available |
| **Executable** | Full executable path |
| **Arguments** | Full command arguments |

Each process is shown in its own card so it is easier to distinguish similar local servers.

### Commands

| Command | Description |
|---|---|
| `Kill Stack: Open Dashboard` | Open the Kill Stack dashboard |
| `Kill Stack: Kill All Local Servers` | Kill every detected local server process |
| `Kill Stack: Refresh Dashboard` | Refresh the dashboard |

### Kill On Exit

Kill Stack can clean up local server processes when VS Code closes.

- On macOS, the extension prompts before killing processes
- On Windows and Linux, processes are killed on exit without a blocking prompt
- You can toggle this setting from the dashboard. This feature is OFF by default

## Settings

| Setting | Default | Description |
|---|---|---|
| `killStack.killOnExit` | `false` | Kill local server processes when VS Code closes |
| `killStack.autoRefreshInterval` | `5` | Auto-refresh interval in seconds. Use `0` to disable |

## Detection Scope

Kill Stack is built to detect common local development processes across multiple runtimes and tools, including:

- Node-based dev servers
- Python local servers
- PHP built-in servers
- Ruby app servers
- Common Java and Go local server patterns
- `ngrok`
- `cloudflared`

It is designed for real-world local development workflows, not as a guarantee that every custom process pattern will be detected.

## Getting Started

After installing Kill Stack, open the dashboard from the status bar or run `Kill Stack: Open Dashboard` from the Command Palette.

From there you can:

- review active local server processes
- kill individual processes
- kill everything in one action
- turn `Kill On Exit` on or off

## Platform Support

| Platform | Detection | Kill Method |
|---|---|---|
| macOS | `ps -axo pid=,pcpu=,pmem=,etime=,command=` | `kill -9 <pid>` |
| Linux | `ps -axo pid=,pcpu=,pmem=,etime=,command=` | `kill -9 <pid>` |
| Windows | `Get-CimInstance Win32_Process` | `taskkill /PID /F` |

## License

MIT
