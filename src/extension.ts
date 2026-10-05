import * as vscode from "vscode";
import { execFile, execFileSync } from "child_process";
import * as fs from "fs";
import { promisify } from "util";
import {
  KillCounts,
  isProtectedPid,
  killPidsAsync,
  killPidsSync,
  pidsOnPort,
  posixTreeKillOrder,
  selectExitTargets,
} from "./killing";
import {
  applyWindowsCpu,
  CpuSample,
  formatCpu,
  formatMemory,
  isInWorkspaceFolders,
  matchesIgnorePattern,
  ServerProcess,
  parseLsofListeningPorts,
  parseLsofWorkingDirectories,
  parseNetstatListeningPorts,
  parsePosixProcesses,
  parseProcessTree,
  parseSsListeningPorts,
  parseWindowsProcesses,
} from "./processes";

const execFileAsync = promisify(execFile);
const KILL_STACK_GREEN = "#6CC24A";
const HIDDEN_REFRESH_SECONDS = 30;

type PanelMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "kill"; pid: number }
  | { type: "killAll" }
  | { type: "setKillOnExit"; enabled: boolean };

// Only the runtimes and tools the classifier recognizes. Filtering in WMI keeps
// PowerShell from returning every process on the machine.
const WINDOWS_SERVER_IMAGE_FILTER = [
  "Name = 'node.exe'",
  "Name = 'bun.exe'",
  "Name = 'deno.exe'",
  "Name = 'php.exe'",
  "Name = 'ruby.exe'",
  "Name = 'java.exe'",
  "Name = 'go.exe'",
  "Name = 'air.exe'",
  "Name = 'gin.exe'",
  "Name = 'ngrok.exe'",
  "Name = 'cloudflared.exe'",
  "Name = 'nodemon.exe'",
  "Name = 'ts-node.exe'",
  "Name = 'tsx.exe'",
  "Name LIKE 'python%'",
].join(" OR ");

const WINDOWS_PROCESS_LIST_COMMAND = [
  "powershell",
  [
    "-NoProfile",
    "-Command",
    `Get-CimInstance -ClassName Win32_Process -Filter "${WINDOWS_SERVER_IMAGE_FILTER}" | Select-Object ProcessId, Name, CommandLine, WorkingSetSize, KernelModeTime, UserModeTime, @{Name='CreationDate';Expression={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}}} | ConvertTo-Json -Compress`,
  ],
] as const;

const POSIX_PROCESS_LIST_COMMAND = [
  "ps",
  ["-axo", "pid=,pcpu=,pmem=,etime=,command="],
] as const;

function parseProcessList(stdout: string): ServerProcess[] {
  return process.platform === "win32"
    ? parseWindowsProcesses(stdout)
    : parsePosixProcesses(stdout);
}

function getProcessListCommand() {
  return process.platform === "win32"
    ? WINDOWS_PROCESS_LIST_COMMAND
    : POSIX_PROCESS_LIST_COMMAND;
}

// Windows reports cumulative CPU time, so the previous sample is kept to compute a percentage.
let windowsCpuSamples = new Map<string, CpuSample>();

async function listRunningProcesses(): Promise<ServerProcess[]> {
  try {
    const [file, args] = getProcessListCommand();
    const result = await execFileAsync(file, [...args]);
    const processes = parseProcessList(result.stdout);

    if (process.platform === "win32") {
      windowsCpuSamples = applyWindowsCpu(
        processes,
        windowsCpuSamples,
        Date.now(),
      );
    }
    return processes;
  } catch {
    return [];
  }
}

// PID -> listening TCP ports for every process on the machine, not just servers.
async function getListeningPorts(): Promise<Map<number, number[]>> {
  if (process.platform === "win32") {
    try {
      // Plain netstat (not -p TCP) so IPv6 listeners like [::]:3000 are included.
      const { stdout } = await execFileAsync("netstat", ["-ano"]);
      return parseNetstatListeningPorts(stdout);
    } catch {
      return new Map();
    }
  }

  if (process.platform === "linux") {
    try {
      // ss ships with iproute2 on nearly every Linux system. lsof is the fallback.
      const { stdout } = await execFileAsync("ss", ["-H", "-ltnp"]);
      return parseSsListeningPorts(stdout);
    } catch {
      // Fall through to lsof.
    }
  }

  try {
    const { stdout } = await execFileAsync("lsof", [
      "-nP",
      "-iTCP",
      "-sTCP:LISTEN",
      "-F",
      "pn",
    ]);
    return parseLsofListeningPorts(stdout);
  } catch (err) {
    // lsof exits non-zero when it cannot read some processes but still prints the rest.
    return parseLsofListeningPorts((err as { stdout?: string }).stdout ?? "");
  }
}

// Working directory of each process, used to match servers started with a
// relative path. Windows does not expose this without reading process memory.
async function attachWorkingDirectories(
  processes: ServerProcess[],
): Promise<void> {
  if (processes.length === 0 || process.platform === "win32") {
    return;
  }

  if (process.platform === "linux") {
    await Promise.all(
      processes.map(async (proc) => {
        try {
          proc.cwd = await fs.promises.readlink(`/proc/${proc.pid}/cwd`);
        } catch {
          // The process exited or belongs to another user.
        }
      }),
    );
    return;
  }

  try {
    const { stdout } = await execFileAsync("lsof", [
      "-a",
      "-d",
      "cwd",
      "-Fpn",
      "-p",
      processes.map((proc) => proc.pid).join(","),
    ]);
    applyWorkingDirectories(processes, parseLsofWorkingDirectories(stdout));
  } catch (err) {
    applyWorkingDirectories(
      processes,
      parseLsofWorkingDirectories((err as { stdout?: string }).stdout ?? ""),
    );
  }
}

function attachWorkingDirectoriesSync(processes: ServerProcess[]): void {
  if (processes.length === 0 || process.platform === "win32") {
    return;
  }

  if (process.platform === "linux") {
    for (const proc of processes) {
      try {
        proc.cwd = fs.readlinkSync(`/proc/${proc.pid}/cwd`);
      } catch {
        // The process exited or belongs to another user.
      }
    }
    return;
  }

  try {
    const stdout = execFileSync(
      "lsof",
      ["-a", "-d", "cwd", "-Fpn", "-p", processes.map((proc) => proc.pid).join(",")],
      { encoding: "utf8" },
    );
    applyWorkingDirectories(processes, parseLsofWorkingDirectories(stdout));
  } catch {
    // Without working directories, matching falls back to the command line.
  }
}

function applyWorkingDirectories(
  processes: ServerProcess[],
  directories: Map<number, string>,
): void {
  for (const proc of processes) {
    const cwd = directories.get(proc.pid);
    if (cwd) {
      proc.cwd = cwd;
    }
  }
}

async function getServerProcesses(): Promise<ServerProcess[]> {
  const [processes, ports] = await Promise.all([
    listRunningProcesses(),
    getListeningPorts(),
  ]);
  await attachWorkingDirectories(processes);

  return processes.map((proc) => ({
    ...proc,
    ports: ports.get(proc.pid) ?? [],
  }));
}

// Synchronous variant for deactivate(): VS Code does not wait for async work
// started during shutdown, so the kill-on-exit path must finish before returning.
function getServerProcessesSync(): ServerProcess[] {
  try {
    const [file, args] = getProcessListCommand();
    const stdout = execFileSync(file, [...args], { encoding: "utf8" });
    const processes = parseProcessList(stdout);
    attachWorkingDirectoriesSync(processes);
    return processes;
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

  const processLabel = `${processCount} local server process${
    processCount !== 1 ? "es are" : " is"
  } still running. Kill ${processCount !== 1 ? "them" : "it"} now?`;

  try {
    // osascript exits 0 for both buttons, so the chosen button has to be checked.
    const choice = execFileSync("osascript", [
      "-e",
      `display dialog "${processLabel}" buttons {"Leave Running", "Kill All"} default button "Kill All" with icon caution`,
      "-e",
      "button returned of result",
    ]).toString().trim();
    return choice === "Kill All";
  } catch {
    // Escape or closing the dialog makes osascript exit non-zero.
    return false;
  }
}

function getChildProcessMap(): Map<number, number[]> {
  if (process.platform === "win32") {
    // taskkill /T handles the tree on Windows, so no map is needed.
    return new Map();
  }

  try {
    const stdout = execFileSync("ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8",
    });
    return parseProcessTree(stdout);
  } catch {
    return new Map();
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Kills a server together with the child processes it started (for example,
// the real server behind `npm run dev`). Throws only if the root kill fails.
function killPosixTree(pid: number, children: Map<number, number[]>): void {
  for (const target of posixTreeKillOrder(pid, children)) {
    if (target === pid) {
      process.kill(pid, "SIGKILL");
      continue;
    }

    try {
      process.kill(target, "SIGKILL");
    } catch {
      // The child may have exited on its own; keep going.
    }
  }
}

function killProcessTreeSync(pid: number): void {
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
    return;
  }

  killPosixTree(pid, getChildProcessMap());
}

async function getChildProcessMapAsync(): Promise<Map<number, number[]>> {
  if (process.platform === "win32") {
    return new Map();
  }

  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid="]);
    return parseProcessTree(stdout);
  } catch {
    return new Map();
  }
}

// Async version for the dashboard, so Kill All does not block the extension host.
async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]);
    return;
  }

  killPosixTree(pid, await getChildProcessMapAsync());
}

function killPidsSyncWithOs(pids: number[]): void {
  killPidsSync(pids, { isAlive, killTree: killProcessTreeSync });
}

function killPids(pids: number[]): Promise<KillCounts> {
  return killPidsAsync(pids, { isAlive, killTree: killProcessTree });
}

function shortenCommand(cmd: string): string {
  const parts = cmd.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? cmd;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function createStatusBarButton(
  context: vscode.ExtensionContext,
): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  item.command = "killStack.statusMenu";
  item.text = "$(circuit-board) Kill Stack";
  item.tooltip = "Open Kill Stack local server dashboard";
  item.color = KILL_STACK_GREEN;
  item.show();
  context.subscriptions.push(item);
  return item;
}

function getKillStackConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("killStack");
}

function getIgnorePatterns(): string[] {
  return getKillStackConfig().get<string[]>("ignorePatterns") ?? [];
}

function getWorkspaceFolderPaths(): string[] {
  return vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
}

function isIgnored(proc: ServerProcess): boolean {
  return matchesIgnorePattern(proc, getIgnorePatterns());
}

// Kill on exit would stop this server: it is in an open folder and not ignored.
function stopsOnExit(proc: ServerProcess): boolean {
  return (
    isInWorkspaceFolders(proc, getWorkspaceFolderPaths()) && !isIgnored(proc)
  );
}

function getKillOnExitSetting(): boolean {
  return getKillStackConfig().get<boolean>("killOnExit") ?? false;
}

// Always user-level: the setting applies to every project, and kill on exit
// already limits itself to the open folders.
async function setKillOnExitSetting(enabled: boolean): Promise<void> {
  await getKillStackConfig().update(
    "killOnExit",
    enabled,
    vscode.ConfigurationTarget.Global,
  );
}

async function updateStatusBar(
  item: vscode.StatusBarItem,
  processes: ServerProcess[],
): Promise<void> {
  const count = processes.length;

  if (count === 0) {
    item.text = "$(circuit-board) Kill Stack";
    item.tooltip = "No local dev servers running";
    item.backgroundColor = undefined;
  } else {
    item.text = `$(circuit-board) Kill Stack (${count})`;
    item.tooltip = `${count} local server process${
      count !== 1 ? "es" : ""
    } running`;
    item.backgroundColor = undefined;
  }
  item.color = KILL_STACK_GREEN;
}

class KillStackPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel;
  private processes: ServerProcess[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private isDisposed = false;

  constructor(
    extensionUri: vscode.Uri,
    initialProcesses: ServerProcess[],
    private readonly onDisposePanel: () => void,
    private readonly onRefreshRequest: () => Promise<void>,
    private readonly onKillRequest: (pid: number) => Promise<void>,
    private readonly onKillAllRequest: () => Promise<void>,
    private readonly onSetKillOnExitRequest: (
      enabled: boolean,
    ) => Promise<void>,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "killStackDashboard",
      "Kill Stack",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    this.processes = initialProcesses;
    this.panel.webview.html = this.getHtml(extensionUri);
    this.panel.onDidDispose(
      () => {
        this.isDisposed = true;
        this.onDisposePanel();
        while (this.disposables.length > 0) {
          this.disposables.pop()?.dispose();
        }
      },
      null,
      this.disposables,
    );
    this.panel.webview.onDidReceiveMessage(
      (message: PanelMessage) => this.handleMessage(message),
      null,
      this.disposables,
    );
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.One);
  }

  async triggerKillAll(): Promise<void> {
    await this.onKillAllRequest();
  }

  async update(processes: ServerProcess[]): Promise<void> {
    if (this.isDisposed) {
      return;
    }
    this.processes = processes;
    const killOnExitEnabled = getKillOnExitSetting();
    await this.panel.webview.postMessage({
      type: "processes",
      killOnExitEnabled,
      processes: processes.map((process) => ({
        pid: process.pid,
        label: shortenCommand(process.command),
        framework: process.framework,
        command: process.command,
        args: process.args,
        memory: formatMemory(process.memory),
        cpu: formatCpu(process.cpu),
        elapsed: process.elapsed,
        ports: process.ports ?? [],
        ignored: isIgnored(process),
        stopsOnExit: killOnExitEnabled && stopsOnExit(process),
      })),
    });
  }

  isVisible(): boolean {
    return this.panel.visible;
  }

  private async handleMessage(message: PanelMessage): Promise<void> {
    switch (message.type) {
      case "ready":
      case "refresh":
        await this.onRefreshRequest();
        break;
      case "kill":
        await this.onKillRequest(message.pid);
        break;
      case "killAll":
        await this.onKillAllRequest();
        break;
      case "setKillOnExit":
        await this.onSetKillOnExitRequest(message.enabled);
        break;
    }
  }

  private getHtml(extensionUri: vscode.Uri): string {
    const { webview } = this.panel;
    const assetUri = (...segments: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...segments));
    const styleUri = assetUri("media", "dashboard.css");
    const scriptUri = assetUri("media", "dashboard.js");
    const iconUri = assetUri("images", "icon.png");
    const version = vscode.extensions.getExtension("RedRiverDesign.kill-stack")
      ?.packageJSON?.version as string | undefined;

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src ${webview.cspSource};"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Kill Stack</title>
    <link rel="stylesheet" href="${styleUri}" />
  </head>
  <body>
    <div class="app">
      <header class="topbar">
        <div class="brand">
          <img src="${iconUri}" alt="" width="28" height="28" />
          <div>
            <h1><span class="kill">Kill</span><span class="stack">Stack</span><span class="version">${escapeHtml(version ?? "")}</span></h1>
            <p>Local development servers</p>
          </div>
        </div>
        <div class="actions">
          <button type="button" class="btn" id="refresh">Refresh</button>
          <button type="button" class="btn btn-danger" id="killAll" disabled>Kill all</button>
        </div>
      </header>

      <section class="summary" aria-label="Summary">
        <div class="tile">
          <div class="tile-label">Running</div>
          <div class="tile-value is-accent" id="count">0</div>
        </div>
        <div class="tile">
          <div class="tile-label">Ports in use</div>
          <div class="tile-value" id="ports">0</div>
        </div>
        <div class="tile">
          <div class="tile-label">Stop on exit</div>
          <div class="tile-value" id="exitCount">0</div>
        </div>
      </section>

      <section class="setting">
        <div class="setting-text">
          <strong id="settingTitle">Kill on exit</strong>
          <span id="killOnExitHelp">Leaves servers running when VS Code closes.</span>
        </div>
        <label class="switch">
          <input
            type="checkbox"
            id="killOnExit"
            role="switch"
            aria-labelledby="settingTitle"
            aria-describedby="killOnExitHelp"
          />
          <span class="track"></span>
        </label>
      </section>

      <section aria-labelledby="listTitle">
        <div class="section-head">
          <h2 id="listTitle">Servers</h2>
          <span class="updated" id="updated">Waiting for data…</span>
        </div>
        <ul class="list" id="list" hidden></ul>
        <div class="empty" id="empty">
          <img class="empty-mark" src="${iconUri}" alt="" width="56" height="56" />
          <h3>No local servers running</h3>
          <p>When a dev server or tunnel starts, it appears here with its command, ports, and resource use.</p>
        </div>
      </section>

      <p class="sr-only" id="status" role="status"></p>
    </div>
    <script src="${scriptUri}"></script>
  </body>
</html>`;
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    this.onDisposePanel();
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
    this.panel.dispose();
  }
}

function formatPorts(proc: ServerProcess): string {
  return proc.ports && proc.ports.length
    ? proc.ports.map((port) => `:${port}`).join(", ")
    : "";
}

// One server row in the sidebar. The PID is the tree id, so keyboard focus
// survives the periodic redraws.
class ServerItem extends vscode.TreeItem {
  constructor(readonly proc: ServerProcess) {
    super(shortenCommand(proc.command), vscode.TreeItemCollapsibleState.None);

    const ports = formatPorts(proc);
    const exitState = isIgnored(proc)
      ? "ignored"
      : getKillOnExitSetting() && stopsOnExit(proc)
        ? "stops on exit"
        : "";

    this.id = String(proc.pid);
    this.contextValue = "server";
    this.iconPath = new vscode.ThemeIcon("server-process");
    this.description = [
      proc.framework,
      ports,
      proc.cpu !== "?" ? formatCpu(proc.cpu) : "",
      proc.memory !== "?" ? proc.memory : "",
      proc.elapsed !== "?" ? proc.elapsed : "",
      exitState,
    ]
      .filter(Boolean)
      .join(" · ");
    this.tooltip = [proc.command, proc.args].filter(Boolean).join(" ");
    this.accessibilityInformation = {
      label: [
        `${proc.framework} server ${shortenCommand(proc.command)}`,
        `PID ${proc.pid}`,
        ports,
        exitState,
      ]
        .filter(Boolean)
        .join(", "),
    };
  }
}

class ServerTreeProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private items: vscode.TreeItem[] = [];
  private signature = "";

  setServers(servers: ServerProcess[]): void {
    const items: vscode.TreeItem[] =
      servers.length === 0
        ? [emptyServerItem()]
        : servers.map((proc) => new ServerItem(proc));

    // Only redraw when something visible changed, so the tree is not rebuilt every poll.
    const signature = items
      .map((item) => `${item.id}|${String(item.label)}|${item.description}`)
      .join("\n");
    if (signature === this.signature) {
      return;
    }

    this.signature = signature;
    this.items = items;
    this.changed.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    return this.items;
  }

  dispose(): void {
    this.changed.dispose();
  }
}

function emptyServerItem(): vscode.TreeItem {
  const item = new vscode.TreeItem("No local servers running");
  item.id = "empty";
  item.description = "Start a dev server to see it here";
  return item;
}

interface ServerPick extends vscode.QuickPickItem {
  pid?: number;
  openDashboard?: boolean;
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  let processes: ServerProcess[] = [];
  let panel: KillStackPanel | undefined;
  const statusBarItem = createStatusBarButton(context);

  const serverTree = new ServerTreeProvider();
  context.subscriptions.push(
    serverTree,
    vscode.window.registerTreeDataProvider("killStack.servers", serverTree),
  );

  // Overlapping refreshes share one listing, so slow PowerShell calls don't pile up.
  let listing: Promise<ServerProcess[]> | undefined;
  const listProcesses = (): Promise<ServerProcess[]> => {
    if (!listing) {
      listing = getServerProcesses().finally(() => {
        listing = undefined;
      });
    }
    return listing;
  };

  const syncUi = async (): Promise<ServerProcess[]> => {
    processes = await listProcesses();
    await updateStatusBar(statusBarItem, processes);
    serverTree.setServers(processes);
    if (panel) {
      await panel.update(processes);
    }
    return processes;
  };

  // Shared by the dashboard, sidebar, and status bar menu. Always confirms first.
  const confirmAndKill = async (pid: number): Promise<void> => {
    const target = processes.find((process) => process.pid === pid);
    if (!target) {
      vscode.window.showWarningMessage(
        `Process PID ${pid} is no longer running.`,
      );
      await syncUi();
      return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      `Kill "${shortenCommand(target.command)}" (PID ${pid})?`,
      {
        modal: true,
        detail: target.args
          ? `${target.command} ${target.args}`
          : target.command,
      },
      "Kill",
    );

    if (confirmed === "Kill") {
      try {
        await killProcessTree(pid);
        vscode.window.showInformationMessage(
          `Killed local server process PID ${pid}`,
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to kill PID ${pid}: ${err}`);
      }
      await syncUi();
    }
  };

  const openPanel = async (): Promise<void> => {
    if (panel) {
      panel.reveal();
      await panel.update(processes);
      return;
    }

    panel = new KillStackPanel(
      context.extensionUri,
      processes,
      () => {
        panel = undefined;
      },
      async () => {
        await syncUi();
      },
      async (pid: number) => {
        await confirmAndKill(pid);
      },
      async () => {
        const current = await syncUi();
        if (current.length === 0) {
          vscode.window.showInformationMessage(
            "No local server processes to kill.",
          );
          return;
        }

        // Ignored servers are never part of Kill All. Single kills still work.
        const killable = current.filter((proc) => !isIgnored(proc));
        const ignoredCount = current.length - killable.length;
        if (killable.length === 0) {
          vscode.window.showInformationMessage(
            "All running servers are on your ignore list.",
          );
          return;
        }

        const detail = killable
          .slice(0, 5)
          .map((process) => `${process.pid}: ${process.command}`)
          .join("\n");
        const moreLines =
          killable.length > 5 ? `\n…and ${killable.length - 5} more` : "";
        const ignoredLine =
          ignoredCount > 0
            ? `\n${ignoredCount} ignored server${ignoredCount !== 1 ? "s" : ""} will be left running.`
            : "";

        const confirmed = await vscode.window.showWarningMessage(
          `Kill all ${killable.length} local server process${
            killable.length !== 1 ? "es" : ""
          }?`,
          {
            modal: true,
            detail: detail + moreLines + ignoredLine,
          },
          "Kill All",
        );

        if (confirmed === "Kill All") {
          const { killed, errors } = await killPids(
            killable.map((proc) => proc.pid),
          );
          vscode.window.showInformationMessage(
            `Killed ${killed} local server process${killed !== 1 ? "es" : ""}${
              errors > 0 ? ` (${errors} failed)` : ""
            }.`,
          );
          await syncUi();
        }
      },
      async (enabled: boolean) => {
        await setKillOnExitSetting(enabled);
        await syncUi();
      },
    );

    context.subscriptions.push(panel);
    await panel.update(processes);
  };

  const showStatusMenu = async (): Promise<void> => {
    await syncUi();

    const picks: ServerPick[] = processes.map((proc) => ({
      label: `$(server-process) ${shortenCommand(proc.command)}`,
      description: [proc.framework, formatPorts(proc)]
        .filter(Boolean)
        .join(" · "),
      detail: [proc.command, proc.args].filter(Boolean).join(" "),
      pid: proc.pid,
    }));
    picks.push({
      label: "$(dashboard) Open dashboard…",
      openDashboard: true,
      alwaysShow: true,
    });

    const picked = await vscode.window.showQuickPick(picks, {
      title: "Kill Stack",
      placeHolder:
        processes.length > 0
          ? "Select a local server to kill"
          : "No local servers running",
      matchOnDescription: true,
      matchOnDetail: true,
    });

    if (!picked) {
      return;
    }
    if (picked.openDashboard) {
      await openPanel();
    } else if (picked.pid !== undefined) {
      await confirmAndKill(picked.pid);
    }
  };

  const killPort = async (): Promise<void> => {
    const input = await vscode.window.showInputBox({
      title: "Kill Stack",
      prompt: "Port to free",
      placeHolder: "3000",
      validateInput: (value) => {
        const port = Number(value.trim());
        return /^\d+$/.test(value.trim()) && port >= 1 && port <= 65535
          ? undefined
          : "Enter a port number from 1 to 65535.";
      },
    });
    if (input === undefined) {
      return;
    }

    const port = Number(input.trim());
    const owners = pidsOnPort(await getListeningPorts(), port);

    if (owners.length === 0) {
      vscode.window.showInformationMessage(`Nothing is listening on port ${port}.`);
      return;
    }

    const targets = owners.filter(
      (pid) => !isProtectedPid(pid, process.pid, process.ppid),
    );
    if (targets.length === 0) {
      vscode.window.showErrorMessage(
        `Port ${port} is held by a protected process, so Kill Stack will not stop it.`,
      );
      return;
    }

    const describe = (pid: number): string => {
      const known = processes.find((proc) => proc.pid === pid);
      return known
        ? `${shortenCommand(known.command)} (PID ${pid})`
        : `PID ${pid}`;
    };
    const protectedCount = owners.length - targets.length;

    const confirmed = await vscode.window.showWarningMessage(
      `Kill ${targets.map(describe).join(", ")} listening on port ${port}?`,
      {
        modal: true,
        detail:
          protectedCount > 0
            ? `${protectedCount} protected process${protectedCount !== 1 ? "es" : ""} on this port will be left running.`
            : undefined,
      },
      "Kill",
    );
    if (confirmed !== "Kill") {
      return;
    }

    const { killed, errors } = await killPids(targets);
    vscode.window.showInformationMessage(
      `Killed ${killed} process${killed !== 1 ? "es" : ""} on port ${port}${
        errors > 0 ? ` (${errors} failed)` : ""
      }.`,
    );
    await syncUi();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("killStack.showProcesses", async () => {
      await syncUi();
      await openPanel();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("killStack.statusMenu", showStatusMenu),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("killStack.killPort", killPort),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "killStack.killServer",
      async (item?: ServerItem) => {
        if (item instanceof ServerItem) {
          await confirmAndKill(item.proc.pid);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("killStack.refresh", async () => {
      await syncUi();
      vscode.window.setStatusBarMessage(
        "$(sync~spin) Refreshed Kill Stack dashboard",
        2000,
      );
      if (panel) {
        panel.reveal();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("killStack.killAll", async () => {
      await openPanel();
      await panel?.triggerKillAll();
    }),
  );

  const config = getKillStackConfig();
  const intervalSec: number = config.get("autoRefreshInterval") ?? 5;

  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let windowFocused = vscode.window.state.focused;
  let ticksSinceRefresh = 0;

  // Polling pauses while VS Code is unfocused. With the dashboard closed, it
  // refreshes about every 30 seconds so the status bar count stays current.
  const startAutoRefresh = (seconds: number) => {
    if (refreshTimer) clearInterval(refreshTimer);
    if (seconds > 0) {
      const hiddenEveryTicks = Math.ceil(HIDDEN_REFRESH_SECONDS / seconds);
      refreshTimer = setInterval(async () => {
        if (!windowFocused) {
          return;
        }

        ticksSinceRefresh++;
        const dashboardOpen = panel?.isVisible() ?? false;
        if (!dashboardOpen && ticksSinceRefresh < hiddenEveryTicks) {
          return;
        }

        ticksSinceRefresh = 0;
        await syncUi();
      }, seconds * 1000);
    }
  };

  startAutoRefresh(intervalSec);

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      windowFocused = state.focused;
      if (windowFocused) {
        ticksSinceRefresh = 0;
        void syncUi();
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("killStack.autoRefreshInterval")) {
        const nextInterval =
          vscode.workspace
            .getConfiguration("killStack")
            .get<number>("autoRefreshInterval") ?? 5;
        startAutoRefresh(nextInterval);
      }

      // Ignore list and kill-on-exit change which rows are marked, so redraw.
      if (
        event.affectsConfiguration("killStack.ignorePatterns") ||
        event.affectsConfiguration("killStack.killOnExit")
      ) {
        void syncUi();
      }
    }),
  );

  await syncUi();

  context.subscriptions.push({
    dispose: () => {
      if (refreshTimer) clearInterval(refreshTimer);
    },
  });
}

export function deactivate(): void {
  if (!getKillOnExitSetting()) {
    return;
  }

  // Only stop servers that belong to this window's folders and are not on the
  // ignore list. With no folder open, nothing matches and nothing is killed.
  const running = selectExitTargets(
    getServerProcessesSync(),
    getWorkspaceFolderPaths(),
    getIgnorePatterns(),
    true,
  );
  if (running.length === 0) {
    return;
  }

  if (confirmKillOnExit(running.length)) {
    killPidsSyncWithOs(running.map((proc) => proc.pid));
  }
}
