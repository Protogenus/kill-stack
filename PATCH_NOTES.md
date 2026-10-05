# Patch Notes

## 1.1.0

### Added

- **Local Servers sidebar.** The Kill Stack icon in the activity bar lists your running servers with their framework, ports, memory, and uptime. Each row has a stop button, and the list works with the keyboard and screen readers.
- **Quick Menu.** Clicking the status bar item opens a list of running servers. Pick one to stop it.
- **Kill Process on Port.** Run "Kill Stack: Kill Process on Port…", enter a port number, and stop whatever is listening on it. System processes and VS Code itself are never stopped this way.
- **Ports on each server.** Dashboard cards and the sidebar show the ports each server is listening on.
- **Ignore list.** The new `killStack.ignorePatterns` setting names servers that Kill All and Kill On Exit should never stop. You can still stop them one at a time.
- **Kill On Exit preview.** The dashboard marks which servers will stop when VS Code closes, and which are on the ignore list.
- **Uptime on Windows.** Servers now show how long they have been running on Windows.
- **CPU usage.** Dashboard cards and the sidebar show each server's CPU usage. Windows shows it too.
- **Relative-path servers on macOS and Linux.** A server started from inside your project folder is stopped on exit even if its command line does not include the folder path.

### Fixed

- Kill On Exit now works. Local servers are stopped when VS Code closes.
- On macOS, choosing "Leave Running" in the prompt now keeps your servers running.
- Stopping a server also stops the processes it started, so ports are freed.
- "Kill All" no longer freezes VS Code while servers are stopped.
- Overlapping refreshes no longer pile up when the system is busy.

### Changed

- **Redesigned dashboard.** Cleaner layout that follows your VS Code theme, light or dark, with the new Kill Stack icon's blue accents and version badge. Each server is a single row with its ports, uptime, CPU, and memory, and the full command expands on demand. The list updates in place, so focus and open panels stay put while it refreshes.
- Clicking the status bar item now opens the Quick Menu. Open the full dashboard from the menu or the command palette.
- Kill On Exit only stops servers started from your open folders. Servers in other windows or terminals are left alone. With no folder open, nothing is stopped.
- Stopping a server from the dashboard also stops its child processes.
- Kill On Exit is saved as a user setting, so turning it on applies to every project. A value saved inside a project earlier still takes precedence there until it is changed.
- Lower background CPU use. Refreshes pause while VS Code is unfocused and slow to about every 30 seconds when the dashboard is closed. They resume right away when you return.
- Faster refreshes on Windows. Only Node, Python, and other supported server processes are checked, instead of every process on the machine.

### Known limitations

- On Windows, a server started with a relative path, such as `node server.js` from inside the project, is only recognized as belonging to your folder if its command line includes the folder path. Elsewhere, Kill Stack also checks the folder the server was started in.
- On Windows, CPU usage shows "?" until the second refresh, since it is measured from the change between two samples.

<!-- Add new versions above this line. -->
