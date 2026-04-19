import * as vscode from "vscode";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import {
  formatCpu,
  formatMemory,
  NodeProcess,
  parsePosixProcesses,
  parseWindowsProcesses,
} from "./processes";

const execFileAsync = promisify(execFile);

// ─── Process Fetching ─────────────────────────────────────────────────────────

async function getNodeProcesses(): Promise<NodeProcess[]> {
  try {
    if (process.platform === "win32") {
      const result = await execFileAsync("powershell", [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"name = 'node.exe'\" | Select-Object ProcessId, CommandLine, WorkingSetSize | ConvertTo-Json -Compress",
      ]);
      return parseWindowsProcesses(result.stdout);
    }

    const result = await execFileAsync("ps", [
      "-axo",
      "pid=,pcpu=,pmem=,etime=,command=",
    ]);
    return parsePosixProcesses(result.stdout);
  } catch {
    return [];
  }
}

function shouldPromptBeforeKillOnExit(): boolean {
  return process.platform === "darwin";
}

function confirmKillOnExit(processCount: number): boolean {
  if (!shouldPromptBeforeKillOnExit()) {
    return true;
  }

  const processLabel = `${processCount} Node.js process${
    processCount !== 1 ? "es are" : " is"
  } still running. Kill ${processCount !== 1 ? "them" : "it"} now?`;

  try {
    execFileSync("osascript", [
      "-e",
      `display dialog "${processLabel}" buttons {"Leave Running", "Kill All"} default button "Kill All" with icon caution`,
      "-e",
      "button returned of result",
    ]);
    return true;
  } catch {
    return false;
  }
}

async function killProcess(pid: number): Promise<void> {
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/PID", String(pid), "/F"]);
  } else {
    execFileSync("kill", ["-9", String(pid)]);
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
    const label = shortenCommand(process.command);
    super(label, vscode.TreeItemCollapsibleState.None);

    this.contextValue = "nodeProcess";
    this.description = `PID: ${process.pid}  CPU: ${formatCpu(
      process.cpu
    )}  MEM: ${formatMemory(process.memory)}`;
    this.tooltip = new vscode.MarkdownString(
      [
        `**PID:** ${process.pid}`,
        `**Command:** \`${process.command}\``,
        process.args ? `**Args:** \`${process.args}\`` : "",
        `**CPU:** ${formatCpu(process.cpu)}`,
        `**Memory:** ${formatMemory(process.memory)}`,
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
  private hasLoaded = false;

  async refresh(): Promise<NodeProcess[]> {
    this.processes = await getNodeProcesses();
    this.hasLoaded = true;
    this._onDidChangeTreeData.fire();
    return this.processes;
  }

  async getProcesses(): Promise<NodeProcess[]> {
    return this.refresh();
  }

  getCachedProcesses(): NodeProcess[] {
    return this.processes;
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    if (!this.hasLoaded) {
      this.processes = await getNodeProcesses();
      this.hasLoaded = true;
    }

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
  processes: NodeProcess[]
): Promise<void> {
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
        const processes = await provider.refresh();
        await vscode.commands.executeCommand("nodeProcesses.focus");
        await updateStatusBar(statusBarItem, processes);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "nodeProcessManager.refresh",
      async () => {
        const processes = await provider.refresh();
        await updateStatusBar(statusBarItem, processes);
        vscode.window.setStatusBarMessage(
          "$(sync~spin) Refreshed Node processes",
          2000
        );
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
          const processes = await provider.refresh();
          await updateStatusBar(statusBarItem, processes);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "nodeProcessManager.killAll",
      async () => {
        const processes = await provider.refresh();
        await updateStatusBar(statusBarItem, processes);

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
          const refreshedProcesses = await provider.refresh();
          await updateStatusBar(statusBarItem, refreshedProcesses);
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
        const processes = await provider.refresh();
        await updateStatusBar(statusBarItem, processes);
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
  const initialProcesses = await provider.getProcesses();
  await updateStatusBar(statusBarItem, initialProcesses);

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

      if (confirmKillOnExit(running.length)) {
        await killAllNodeProcesses(running);
      }
    },
  });
}

export function deactivate(): void {
  // Cleanup is handled via context.subscriptions dispose above
}
