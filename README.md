# Kill Stack

Kill Stack is a VS Code extension for finding and shutting down forgotten local
dev servers without leaving your editor.

It gives you a live process count in the status bar, a dashboard for reviewing
active local services, and one-click controls for cleaning them up when you are
done.

## Why Use Kill Stack

- See which local servers are still running
- Inspect process details before killing anything
- Shut down individual processes or clear everything at once
- Optionally kill leftover servers when VS Code closes

## What You Get

### Status Bar Signal

Kill Stack adds a status bar item that shows how many local server processes are
running, for example `Kill Stack (3)`. Click it to open the Quick Menu, which
lists running servers so you can stop one. Open the full dashboard from the
Quick Menu or the Command Palette.

- No count: no local server processes detected
- Count shown: one or more local server processes detected

### Dashboard

The dashboard helps you review what is running before you take action. Each
server is one row, named after its project and script so you can tell servers
apart, for example `shop · vite` or `api-gateway · server.js`.

| Field | Description |
| --- | --- |
| **Framework** | Detected framework, runtime, or tunnel |
| **Ports** | TCP ports the server is listening on |
| **Elapsed** | How long the process has been running, when available |
| **CPU** | CPU usage. On Windows it appears after the second refresh |
| **Memory** | Current memory usage |
| **Ignored** | On the ignore list, so Kill All and Kill On Exit skip it |
| **Command** | Expand a row to see the full executable and arguments |

The **Kill all** button leaves ignored servers running.

### Commands

| Command | Description |
| --- | --- |
| `Kill Stack: Open Dashboard` | Open the Kill Stack dashboard |
| `Kill Stack: Kill All Local Servers` | Kill all servers, except ignored ones |
| `Kill Stack: Refresh Dashboard` | Refresh the dashboard |
| `Kill Stack: Quick Menu` | Pick a server to stop from a list |
| `Kill Stack: Kill Process on Port…` | Kill whatever is listening on a port |

### Local Servers Sidebar

The Kill Stack icon in the activity bar opens a **Local Servers** list. Each row
shows the framework, ports, CPU, memory, and uptime. Use the stop button on a
row (or the Kill Server action from the keyboard or context menu) to stop one
server. Kill Stack asks for confirmation first.

### Ports

Each server shows the TCP ports it is listening on. Ports come from `netstat
-ano` on Windows, `ss` on Linux (with `lsof` as a fallback), and `lsof` on
macOS. Kill Stack never stops PIDs 0 through 4, its own extension host, or VS
Code itself, even when they hold a port.

### Kill On Exit

Kill Stack can clean up local server processes when VS Code closes.

- Every detected local server is stopped, including servers started from other
  windows or terminals
- Servers on the ignore list (see below) are never stopped
- Child processes of a stopped server (for example, the real server started by
  `npm run dev`) are stopped too
- On macOS, the extension prompts before killing processes. Choosing "Leave
  Running" keeps them alive
- On Windows and Linux, processes are killed on exit without a blocking prompt
- You can toggle this setting from the dashboard. It is saved as a user setting
  and applies to every project. This feature is OFF by default

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `killStack.killOnExit` | `false` | Kill servers when VS Code closes |
| `killStack.ignorePatterns` | `[]` | Servers to never stop automatically |
| `killStack.autoRefreshInterval` | `5` | Refresh interval in seconds; `0` off |

## Detection Scope

Kill Stack is built to detect common local development processes across multiple
runtimes and tools, including:

- Node-based dev servers
- Python local servers
- PHP built-in servers
- Ruby app servers
- Common Java and Go local server patterns
- `ngrok`
- `cloudflared`

A Node process is detected when its command line has a server hint, such as a
framework name (`vite`, `next`, `express`), a word like `server`, `dev`,
`start`, or `serve`, or a `--port` or `localhost` argument. `node server.js` is
detected. `node app.js` with no other hints is not.

It is designed for real-world local development workflows, not as a guarantee
that every custom process pattern will be detected.

## Getting Started

After installing Kill Stack, click the status bar item or open the Local Servers
sidebar from the activity bar. You can also run `Kill Stack: Open Dashboard`
from the Command Palette.

From there you can:

- review active local server processes
- stop an individual server from the Quick Menu, the sidebar, or the dashboard
- kill everything in one action (the dashboard's Kill all button or `Kill Stack:
  Kill All Local Servers`)
- stop whatever is listening on a port with
  `Kill Stack: Kill Process on Port…`
- turn `Kill On Exit` on or off, and add patterns to `killStack.ignorePatterns`

## Platform Support

| Platform | Detection | Kill method |
| --- | --- | --- |
| macOS | `ps` | `kill -9`, with children |
| Linux | `ps` | `kill -9`, with children |
| Windows | `Get-CimInstance` | `taskkill /T /F`, with children |

Ports come from `netstat -ano` on Windows, `ss` on Linux (with `lsof`
as a fallback), and `lsof` on macOS.

## License

MIT
