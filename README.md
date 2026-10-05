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
| `Kill Stack: Quick Menu` | Pick a server from a list to kill it. The status bar item opens this menu |
| `Kill Stack: Kill Process on Port…` | Enter a port number and kill whatever is listening on it |

### Local Servers Sidebar

The Kill Stack icon in the activity bar opens a **Local Servers** list. Each row shows the framework, ports, memory, and uptime. Use the stop button on a row (or the Kill Server action from the keyboard or context menu) to stop one server. Kill Stack asks for confirmation first.

### Ports

Each server shows the TCP ports it is listening on. Ports come from `netstat -ano` on Windows, `ss` on Linux (with `lsof` as a fallback), and `lsof` on macOS. Kill Stack never stops PIDs 0 through 4, its own extension host, or VS Code itself, even when they hold a port.

### Kill On Exit

Kill Stack can clean up local server processes when VS Code closes.

- Only servers whose command line includes one of this window's workspace folder paths are stopped. Servers from other windows or terminals are left alone
- With no folder open, nothing is stopped
- Child processes of a stopped server (for example, the real server started by `npm run dev`) are stopped too
- On macOS, the extension prompts before killing processes. Choosing "Leave Running" keeps them alive
- On Windows and Linux, processes are killed on exit without a blocking prompt
- A server counts as belonging to a folder if its command line includes the folder path, or, on macOS and Linux, if it was started from inside the folder. On Windows only the command-line check applies, so a server started with a relative path like `node server.js` may not match
- You can toggle this setting from the dashboard. It is saved as a user setting and applies to every project. This feature is OFF by default

## Settings

| Setting | Default | Description |
|---|---|---|
| `killStack.killOnExit` | `false` | Kill local server processes when VS Code closes |
| `killStack.ignorePatterns` | `[]` | Servers whose command line contains any of these strings (case-insensitive) are never stopped by Kill All or Kill On Exit. Stopping one server at a time still works |
| `killStack.autoRefreshInterval` | `5` | Auto-refresh interval in seconds. Refreshes pause while VS Code is unfocused and slow to about every 30 seconds when the dashboard is closed. Use `0` to disable |

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
