import * as vscode from "vscode";
import { exec, execSync } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// ─── Data Model ───────────────────────────────────────────────────────────────

export interface NodeProcess {
  pid: number;
  command: string;
  args: string;
  cpu: string;
  memory: string;
  elapsed: string;
}

// ─── Process Fetching ─────────────────────────────────────────────────────────

async function getNodeProcesses(): Promise<NodeProcess[]> {
  try {
    let stdout = "";

    if (process.platform === "win32") {
      // Windows: use WMIC
      const result = await execAsync(
        `wmic process where "name='node.exe'" get ProcessId,CommandLine,WorkingSetSize /format:csv`
      );
      stdout = result.stdout;
      return parseWindowsProcesses(stdout);
    } else {
      // macOS / Linux: use ps
      const result = await execAsync(
        `ps aux | grep -E "^\\S+\\s+[0-9]+.*node" | grep -v grep`
      );
      stdout = result.stdout;
      return parsePosixProcesses(stdout);
    }
  } catch {
    // grep returns exit code 1 when no matches — that's fine
    return [];
  }
}

function parsePosixProcesses(raw: string): NodeProcess[] {
  const processes: NodeProcess[] = [];

  for (const line of raw.trim().split("\n")) {
    if (!line.trim()) continue;

    // ps aux columns: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
    const parts = line.trim().split(/\s+/);
    if (parts.length < 11) continue;

    const pid = parseInt(parts[1], 10);
    if (isNaN(pid)) continue;

    const cpu = parts[2];
    const memory = parts[3];
    const elapsed = parts[9];
    const fullCommand = parts.slice(10).join(" ");

    // Only include actual node processes (not grep itself, not other tools)
    if (!fullCommand.includes("node")) continue;

    // Split command from args
    const cmdParts = fullCommand.split(" ");
    const command = cmdParts[0];
    const args = cmdParts.slice(1).join(" ");

    processes.push({ pid, command, args, cpu, memory, elapsed });
  }

  return processes;
}

function parseWindowsProcesses(raw: string): NodeProcess[] {
  const processes: NodeProcess[] = [];
  const lines = raw.trim().split("\n").slice(1); // skip CSV header

  for (const line of lines) {
    const parts = line.split(",");
    if (parts.length < 3) continue;

    const pid = parseInt(parts[2]?.trim(), 10);
    const cmdLine = parts[1]?.trim() ?? "";
    const memBytes = parseInt(parts[3]?.trim(), 10);

    if (isNaN(pid)) continue;

    const cmdParts = cmdLine.split(" ");
    const command = cmdParts[0];
    const args = cmdParts.slice(1).join(" ");
    const memory = isNaN(memBytes)
      ? "?"
      : `${Math.round(memBytes / 1024 / 1024)}MB`;

    processes.push({ pid, command, args, cpu: "?", memory, elapsed: "?" });
  }

  return processes;
}

async function killProcess(pid: number): Promise<void> {
  if (process.platform === "win32") {
    execSync(`taskkill /PID ${pid} /F`);
  } else {
    execSync(`kill -9 ${pid}`);
  }
}

async function killAllNodeProcesses(
  processes: NodeProcess[]
): Promise<{ killed: number; errors: number }> {
  let killed = 0;
  let errors = 0;

  for (const proc of processes) {
    try {
      await killProcess(proc.pid);
      killed++;
    } catch {
      errors++;
    }
  }

  return { killed, errors };
}

// ─── Tree View ────────────────────────────────────────────────────────────────

class NodeProcessItem extends vscode.TreeItem {
  constructor(public readonly process: NodeProcess) {
    // Shorten very long command strings for the label
    const label = shortenCommand(process.command);
    super(label, vscode.TreeItemCollapsibleState.None);

    this.contextValue = "nodeProcess";
    this.description = `PID: ${process.pid}  CPU: ${process.cpu}%  MEM: ${process.memory}%`;
    this.tooltip = new vscode.MarkdownString(
      [
        `**PID:** ${process.pid}`,
        `**Command:** \`${process.command}\``,
        process.args ? `**Args:** \`${process.args}\`` : "",
        `**CPU:** ${process.cpu}%`,
        `**Memory:** ${process.memory}%`,
        `**Elapsed:** ${process.elapsed}`,
      ]
        .filter(Boolean)
        .join("\n\n")
    );

    this.iconPath = new vscode.ThemeIcon(
      "circuit-board",
      new vscode.ThemeColor("charts.green")
    );
  }
}

class EmptyItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("info");
    this.contextValue = "empty";
  }
}

class NodeProcessProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    vscode.TreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private processes: NodeProcess[] = [];

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  async getProcesses(): Promise<NodeProcess[]> {
    this.processes = await getNodeProcesses();
    return this.processes;
  }

  getCachedProcesses(): NodeProcess[] {
    return this.processes;
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    this.processes = await getNodeProcesses();

    if (this.processes.length === 0) {
      return [new EmptyItem("No Node.js processes running")];
    }

    return this.processes.map((p) => new NodeProcessItem(p));
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shortenCommand(cmd: string): string {
  // Show just the filename, not the full path
  const parts = cmd.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1];
}

// ─── Status Bar Button ────────────────────────────────────────────────────────

function createStatusBarButton(
  context: vscode.ExtensionContext
): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  item.command = "nodeProcessManager.showProcesses";
  item.text = "$(circuit-board) Node";
  item.tooltip = "Click to view running Node.js processes";
  item.show();
  context.subscriptions.push(item);
  return item;
}

async function updateStatusBar(
  item: vscode.StatusBarItem,
  provider: NodeProcessProvider
): Promise<void> {
  const processes = provider.getCachedProcesses();
  const count = processes.length;

  if (count === 0) {
    item.text = "$(circuit-board) Node";
    item.tooltip = "No Node.js processes running";
    item.backgroundColor = undefined;
  } else {
    item.text = `$(circuit-board) Node (${count})`;
    item.tooltip = `${count} Node.js process${count !== 1 ? "es" : ""} running — click to manage`;
    item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
  }
}

// ─── Extension Lifecycle ──────────────────────────────────────────────────────

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  const provider = new NodeProcessProvider();

  // Register tree view
  const treeView = vscode.window.createTreeView("nodeProcesses", {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  context.subscriptions.push(treeView);

  // Status bar button
  const statusBarItem = createStatusBarButton(context);

  // ── Commands ──────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "nodeProcessManager.showProcesses",
      async () => {
        // Focus the tree view in the sidebar
        await vscode.commands.executeCommand("nodeProcesses.focus");
        provider.refresh();
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "nodeProcessManager.refresh",
      async () => {
        provider.refresh();
        await updateStatusBar(statusBarItem, provider);
        vscode.window.setStatusBarMessage("$(sync~spin) Refreshed Node processes", 2000);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "nodeProcessManager.killProcess",
      async (item: NodeProcessItem) => {
        if (!item?.process) return;

        const { pid, command } = item.process;
        const confirmed = await vscode.window.showWarningMessage(
          `Kill process "${shortenCommand(command)}" (PID ${pid})?`,
          { modal: true },
          "Kill"
        );

        if (confirmed === "Kill") {
          try {
            await killProcess(pid);
            vscode.window.showInformationMessage(
              `Killed Node process PID ${pid}`
            );
          } catch (err) {
            vscode.window.showErrorMessage(`Failed to kill PID ${pid}: ${err}`);
          }
          provider.refresh();
          await updateStatusBar(statusBarItem, provider);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "nodeProcessManager.killAll",
      async () => {
        const processes = provider.getCachedProcesses();

        if (processes.length === 0) {
          vscode.window.showInformationMessage("No Node.js processes to kill.");
          return;
        }

        const confirmed = await vscode.window.showWarningMessage(
          `Kill all ${processes.length} Node.js process${
            processes.length !== 1 ? "es" : ""
          }?`,
          { modal: true },
          "Kill All"
        );

        if (confirmed === "Kill All") {
          const { killed, errors } = await killAllNodeProcesses(processes);
          vscode.window.showInformationMessage(
            `Killed ${killed} Node process${killed !== 1 ? "es" : ""}${
              errors > 0 ? ` (${errors} failed)` : ""
            }.`
          );
          provider.refresh();
          await updateStatusBar(statusBarItem, provider);
        }
      }
    )
  );

  // ── Auto-refresh ──────────────────────────────────────────────────────────

  const config = vscode.workspace.getConfiguration("nodeProcessManager");
  const intervalSec: number = config.get("autoRefreshInterval") ?? 5;

  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  const startAutoRefresh = (seconds: number) => {
    if (refreshTimer) clearInterval(refreshTimer);
    if (seconds > 0) {
      refreshTimer = setInterval(async () => {
        provider.refresh();
        await updateStatusBar(statusBarItem, provider);
      }, seconds * 1000);
    }
  };

  startAutoRefresh(intervalSec);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("nodeProcessManager.autoRefreshInterval")) {
        const newInterval =
          vscode.workspace
            .getConfiguration("nodeProcessManager")
            .get<number>("autoRefreshInterval") ?? 5;
        startAutoRefresh(newInterval);
      }
    })
  );

  // Initial status bar update
  await provider.getProcesses();
  await updateStatusBar(statusBarItem, provider);

  // ── Kill-on-exit ──────────────────────────────────────────────────────────

  context.subscriptions.push({
    dispose: async () => {
      if (refreshTimer) clearInterval(refreshTimer);

      const killOnExit =
        vscode.workspace
          .getConfiguration("nodeProcessManager")
          .get<boolean>("killOnExit") ?? true;

      if (!killOnExit) return;

      // Re-fetch fresh process list at exit time
      const running = await getNodeProcesses();
      if (running.length === 0) return;

      // VS Code is closing — we can't show async modals reliably at this point,
      // so we use a synchronous native dialog via a child process on macOS/Linux.
      // On Windows we skip the prompt and kill immediately if configured.
      if (process.platform !== "win32") {
        try {
          execSync(
            `osascript -e 'display dialog "${running.length} Node.js process${
              running.length !== 1 ? "es are" : " is"
            } still running. Kill ${
              running.length !== 1 ? "them" : "it"
            } now?" buttons {"Leave Running", "Kill All"} default button "Kill All" with icon caution' -e 'button returned of result'`
          );
          // If osascript returns without error, the user clicked "Kill All"
          await killAllNodeProcesses(running);
        } catch {
          // User clicked "Leave Running" or dialog failed — do nothing
        }
      } else {
        // Windows: kill silently on exit (no blocking dialog available)
        await killAllNodeProcesses(running);
      }
    },
  });
}

export function deactivate(): void {
  // Cleanup is handled via context.subscriptions dispose above
}
