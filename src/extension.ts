import * as vscode from "vscode";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import {
  formatMemory,
  NodeProcess,
  parsePosixProcesses,
  parseWindowsProcesses,
} from "./processes";

const execFileAsync = promisify(execFile);
const KILL_STACK_GREEN = "#6CC24A";

type PanelMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "kill"; pid: number }
  | { type: "killAll" }
  | { type: "setKillOnExit"; enabled: boolean };

async function getNodeProcesses(): Promise<NodeProcess[]> {
  try {
    if (process.platform === "win32") {
      const result = await execFileAsync("powershell", [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId, Name, CommandLine, WorkingSetSize | ConvertTo-Json -Compress",
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

  const processLabel = `${processCount} local server process${
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
  processes: NodeProcess[],
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
  item.command = "killStack.showProcesses";
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

function getKillOnExitSetting(): boolean {
  return getKillStackConfig().get<boolean>("killOnExit") ?? false;
}

function getKillOnExitTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

async function setKillOnExitSetting(enabled: boolean): Promise<void> {
  await getKillStackConfig().update(
    "killOnExit",
    enabled,
    getKillOnExitTarget(),
  );
}

async function updateStatusBar(
  item: vscode.StatusBarItem,
  processes: NodeProcess[],
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
  private processes: NodeProcess[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private isDisposed = false;

  constructor(
    extensionUri: vscode.Uri,
    initialProcesses: NodeProcess[],
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

  async update(processes: NodeProcess[]): Promise<void> {
    if (this.isDisposed) {
      return;
    }
    this.processes = processes;
    await this.panel.webview.postMessage({
      type: "processes",
      killOnExitEnabled: getKillOnExitSetting(),
      processes: processes.map((process) => ({
        pid: process.pid,
        label: shortenCommand(process.command),
        framework: process.framework,
        command: process.command,
        args: process.args,
        memory: formatMemory(process.memory),
        elapsed: process.elapsed,
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
    const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const iconUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "images", "icon.png"),
    );

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${
        this.panel.webview.cspSource
      } https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Kill Stack</title>
    <style>
      :root {
        color-scheme: light dark;
        --ss-red-500: #d94c4c;
        --ss-red-700: #a92c2c;
        --ss-blue-900: #0b5cab;
        --ss-blue-800: #1b73c8;
        --ss-blue-700: #3191e0;
        --ss-blue-500: #5faeff;
        --ss-blue-200: #cde6ff;
        --ss-white-100: #f5fbff;
        --ss-white-050: #eef7ff;
        --ss-ink: #1b2a40;
        --ss-ink-soft: #445b78;
        --ss-shadow: rgba(10, 44, 86, 0.22);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        padding: 18px;
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background:
          radial-gradient(circle at -10% 10%, rgba(205, 230, 255, 0.55) 0, rgba(205, 230, 255, 0.55) 18%, rgba(205, 230, 255, 0) 44%),
          linear-gradient(145deg, var(--ss-blue-800) 0%, var(--ss-blue-900) 64%, #0f4f91 100%);
      }

      .shell {
        max-width: 900px;
        margin: 0 auto;
        display: grid;
        gap: 12px;
      }

      .hero {
        display: grid;
        grid-template-columns: minmax(88px, 104px) 1fr auto;
        gap: 16px;
        align-items: center;
        padding: 18px 20px;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 0;
        background:
          linear-gradient(135deg, rgba(246, 255, 246, 0.12), rgba(255, 255, 255, 0.04)),
          rgba(255, 255, 255, 0.04);
        box-shadow: 0 18px 36px var(--ss-shadow);
      }

      .hero-mark {
        width: 96px;
        height: 96px;
        padding: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 0;
        background:
          linear-gradient(180deg, rgba(250, 253, 255, 0.92), rgba(232, 243, 255, 0.8));
        box-shadow:
          inset 0 0 0 1px rgba(95, 174, 255, 0.18),
          0 12px 22px rgba(9, 45, 88, 0.16);
      }

      .hero img {
        width: 100%;
        height: 100%;
        display: block;
        object-fit: contain;
        object-position: center;
      }

      .hero h1 {
        margin: 0;
        font-size: 30px;
        line-height: 1.05;
        color: rgba(255, 255, 255, 0.98);
        letter-spacing: -0.02em;
      }

      .hero h1 .kill-word {
        color: var(--ss-red-500);
        font-weight: 900;
        letter-spacing: -0.04em;
      }

      .hero p {
        margin: 6px 0 0;
        max-width: 44ch;
        color: rgba(255, 255, 255, 0.86);
      }

      .actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      .toggle-card {
        display: grid;
        gap: 6px;
        min-width: 180px;
        padding: 10px 12px;
        border: 1px solid rgba(95, 174, 255, 0.22);
        background: rgba(245, 250, 255, 0.92);
      }

      .toggle-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }

      .toggle-title {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--ss-ink);
      }

      .toggle-help {
        font-size: 11px;
        color: rgba(68, 91, 120, 0.8);
      }

      .switch {
        position: relative;
        display: inline-flex;
        align-items: center;
        width: 48px;
        height: 28px;
        flex: 0 0 auto;
      }

      .switch input {
        position: absolute;
        inset: 0;
        margin: 0;
        opacity: 0;
        cursor: pointer;
        z-index: 1;
      }

      .slider {
        position: absolute;
        inset: 0;
        border-radius: 999px;
        background: linear-gradient(135deg, rgba(68, 91, 120, 0.2), rgba(68, 91, 120, 0.32));
        border: 1px solid rgba(68, 91, 120, 0.22);
        box-shadow:
          inset 0 1px 1px rgba(255, 255, 255, 0.28),
          inset 0 -1px 1px rgba(11, 92, 171, 0.08);
        transition:
          background 120ms ease,
          border-color 120ms ease,
          box-shadow 120ms ease;
      }

      .slider::after {
        content: "";
        position: absolute;
        top: 3px;
        left: 3px;
        width: 20px;
        height: 20px;
        background: #ffffff;
        border-radius: 50%;
        border: 1px solid rgba(27, 42, 64, 0.08);
        box-shadow:
          0 1px 3px rgba(11, 32, 58, 0.24),
          inset 0 1px 0 rgba(255, 255, 255, 0.8);
        transition:
          transform 120ms ease,
          box-shadow 120ms ease;
      }

      .switch input:checked + .slider {
        background: linear-gradient(135deg, var(--ss-red-500), var(--ss-red-700));
        border-color: rgba(169, 44, 44, 0.5);
      }

      .switch input:checked + .slider::after {
        transform: translateX(20px);
      }

      .switch input:focus-visible + .slider {
        box-shadow:
          0 0 0 2px rgba(255, 255, 255, 0.7),
          0 0 0 4px rgba(95, 174, 255, 0.5),
          inset 0 1px 1px rgba(255, 255, 255, 0.28),
          inset 0 -1px 1px rgba(11, 92, 171, 0.08);
      }

      button {
        border: 1px solid rgba(32, 50, 39, 0.12);
        border-radius: 0;
        padding: 9px 15px;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
        transition:
          transform 120ms ease,
          opacity 120ms ease,
          background 120ms ease,
          box-shadow 120ms ease;
      }

      button:hover {
        transform: translateY(-1px);
        box-shadow: 0 12px 20px rgba(13, 71, 48, 0.18);
      }

      button:disabled {
        opacity: 0.5;
        cursor: default;
        transform: none;
      }

      .primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }

      .secondary {
        background: linear-gradient(135deg, #dff0ff, #bfe1ff);
        color: var(--ss-ink);
        border-color: rgba(95, 174, 255, 0.36);
      }

      .danger {
        background: linear-gradient(135deg, var(--ss-blue-500), #3f8fe2);
        color: #0d1c30;
        border-color: rgba(16, 32, 21, 0.08);
      }

      .danger-all {
        background: linear-gradient(135deg, var(--ss-red-500), var(--ss-red-700));
        color: #ffffff;
        border-color: rgba(120, 20, 20, 0.22);
      }

      .stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
        gap: 8px;
      }

      .stat {
        padding: 9px 10px;
        border-radius: 0;
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(247, 251, 255, 0.9);
        box-shadow: 0 8px 14px rgba(10, 44, 86, 0.08);
      }

      .stat-label {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgba(27, 42, 64, 0.66);
      }

      .stat-value {
        margin-top: 4px;
        font-size: 17px;
        font-weight: 700;
        color: var(--ss-ink);
      }

      .surface {
        border-radius: 0;
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(226, 238, 250, 0.96);
        overflow: hidden;
        box-shadow: 0 16px 30px rgba(10, 44, 86, 0.11);
      }

      .surface-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        padding: 12px 14px;
        border-bottom: 1px solid rgba(49, 145, 224, 0.16);
        background: linear-gradient(90deg, rgba(205, 230, 255, 0.36), rgba(255, 255, 255, 0.7));
      }

      .surface-header h2 {
        margin: 0;
        font-size: 18px;
        color: var(--ss-ink);
      }

      .surface-header p {
        margin: 4px 0 0;
        color: rgba(68, 91, 120, 0.8);
      }

      .last-updated {
        font-size: 12px;
        color: rgba(68, 91, 120, 0.78);
      }

      .empty {
        padding: 30px 18px 36px;
        text-align: center;
        color: rgba(68, 91, 120, 0.82);
      }

      .grid {
        display: grid;
        gap: 6px;
        padding: 8px;
      }

      .card {
        display: grid;
        gap: 6px;
        padding: 9px;
        border-radius: 0;
        border: 1px solid rgba(27, 92, 171, 0.34);
        background:
          linear-gradient(180deg, rgba(220, 235, 250, 0.98), rgba(206, 225, 244, 0.96));
      }

      .card-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      .process-title {
        display: grid;
        gap: 3px;
        min-width: 0;
      }

      .process-title strong {
        font-size: 14px;
        color: var(--ss-ink);
      }

      .badge-row {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }

      .badge {
        padding: 4px 7px;
        border-radius: 0;
        font-size: 10px;
        color: var(--ss-ink-soft);
        background: rgba(95, 174, 255, 0.18);
      }

      .metrics {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 5px;
      }

      .metric {
        padding: 6px 8px;
        border-radius: 0;
        background: rgba(198, 220, 243, 0.92);
        border: 1px solid rgba(49, 145, 224, 0.24);
        min-width: 0;
      }

      .metric-label {
        font-size: 11px;
        color: rgba(68, 91, 120, 0.72);
      }

      .metric-value {
        margin-top: 2px;
        font-weight: 600;
        font-size: 12px;
        color: var(--ss-ink);
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .details {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 5px;
      }

      .details.single {
        grid-template-columns: 1fr;
      }

      .stack {
        display: grid;
        gap: 4px;
        min-width: 0;
      }

      .stack label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgba(68, 91, 120, 0.74);
        font-weight: 800;
      }

      pre {
        margin: 0;
        padding: 6px 8px;
        border-radius: 0;
        background: rgba(194, 216, 240, 0.94);
        border: 1px solid rgba(27, 92, 171, 0.24);
        overflow-x: auto;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: var(--vscode-editor-font-family);
        font-size: 10px;
        line-height: 1.3;
        color: var(--ss-ink);
        max-height: 72px;
      }

      @media (max-width: 760px) {
        body {
          padding: 14px;
        }

        .hero {
          grid-template-columns: 1fr;
        }

        .hero-mark {
          width: 84px;
          height: 84px;
        }

        .actions {
          justify-content: flex-start;
        }

        .card-top {
          align-items: flex-start;
          flex-direction: column;
        }

        .details {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <section class="hero">
        <div class="hero-mark">
          <img src="${iconUri}" alt="Kill Stack icon" />
        </div>
        <div>
          <h1><span class="kill-word">Kill</span> Stack</h1>
          <p>Inspect local dev servers before you stop anything. Built to make cleanup safer across runtimes and frameworks.</p>
        </div>
        <div class="actions">
          <div class="toggle-card">
            <div class="toggle-top">
              <div class="toggle-title">Kill On Exit</div>
              <label class="switch" aria-label="Toggle kill on exit">
                <input type="checkbox" id="killOnExitToggle" />
                <span class="slider"></span>
              </label>
            </div>
            <div class="toggle-help" id="killOnExitLabel">Stops detected local servers when VS Code closes.</div>
          </div>
          <button class="secondary" id="refreshButton">Refresh</button>
          <button class="danger-all" id="killAllButton">Kill All</button>
        </div>
      </section>

      <section class="stats">
        <article class="stat">
          <div class="stat-label">Running Processes</div>
          <div class="stat-value" id="countValue">0</div>
        </article>
        <article class="stat">
          <div class="stat-label">Auto Refresh</div>
          <div class="stat-value" id="refreshValue">Live</div>
        </article>
        <article class="stat">
          <div class="stat-label">Kill Safety</div>
          <div class="stat-value">Full Command View</div>
        </article>
      </section>

      <section class="surface">
        <div class="surface-header">
          <div>
            <h2>Process Dashboard</h2>
            <p>Each card shows the detected framework, executable path, full args, and runtime details for local servers people forget to close.</p>
          </div>
          <div class="last-updated" id="updatedLabel">Waiting for process data…</div>
        </div>
        <div id="content"></div>
      </section>
    </div>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const content = document.getElementById("content");
      const countValue = document.getElementById("countValue");
      const updatedLabel = document.getElementById("updatedLabel");
      const refreshButton = document.getElementById("refreshButton");
      const killAllButton = document.getElementById("killAllButton");
      const killOnExitToggle = document.getElementById("killOnExitToggle");
      const killOnExitLabel = document.getElementById("killOnExitLabel");

      refreshButton.addEventListener("click", () => {
        vscode.postMessage({ type: "refresh" });
      });

      killAllButton.addEventListener("click", () => {
        vscode.postMessage({ type: "killAll" });
      });

      killOnExitToggle.addEventListener("change", () => {
        vscode.postMessage({
          type: "setKillOnExit",
          enabled: killOnExitToggle.checked,
        });
      });

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (message.type !== "processes") {
          return;
        }

        const processes = message.processes;
        killOnExitToggle.checked = Boolean(message.killOnExitEnabled);
        killOnExitLabel.textContent = killOnExitToggle.checked
          ? "Stops detected local servers when VS Code closes."
          : "Leaves local servers running when VS Code closes.";
        countValue.textContent = String(processes.length);
        updatedLabel.textContent = "Updated " + new Date().toLocaleTimeString();
        killAllButton.disabled = processes.length === 0;

        if (processes.length === 0) {
          content.innerHTML = '<div class="empty"><h3>No local server processes running</h3><p>When a dev server, local tunnel, or one-off local host starts, it will appear here with its full command line and a dedicated kill action.</p></div>';
          return;
        }

        const cards = processes.map((process) => {
          const fullCommand = process.args
            ? process.command + " " + process.args
            : process.command;
          const hasArgs = Boolean(process.args);
          const elapsedBadge = process.elapsed && process.elapsed !== "?"
            ? '<span class="badge">' + escapeHtml(process.elapsed) + ' elapsed</span>'
            : '';
          const detailClass = hasArgs ? "details" : "details single";
          const argsBlock = hasArgs
            ? \`
              <div class="stack">
                <label>Arguments</label>
                <pre>\${escapeHtml(process.args)}</pre>
              </div>
            \`
            : "";

          return \`
            <article class="card">
              <div class="card-top">
                <div class="process-title">
                  <strong>\${escapeHtml(process.label)}</strong>
                  <div class="badge-row">
                    <span class="badge">\${escapeHtml(process.framework)}</span>
                    <span class="badge">PID \${escapeHtml(String(process.pid))}</span>
                    \${elapsedBadge}
                  </div>
                </div>
                <button class="danger-all" data-kill="\${escapeHtml(String(process.pid))}">
                  Kill PID \${escapeHtml(String(process.pid))}
                </button>
              </div>
              <div class="metrics">
                <div class="metric">
                  <div class="metric-label">Memory</div>
                  <div class="metric-value">\${escapeHtml(process.memory)}</div>
                </div>
                <div class="metric">
                  <div class="metric-label">Executable</div>
                  <div class="metric-value">\${escapeHtml(process.command)}</div>
                </div>
              </div>
              <div class="\${detailClass}">
                <div class="stack">
                  <label>Full Command</label>
                  <pre>\${escapeHtml(fullCommand)}</pre>
                </div>
                \${argsBlock}
              </div>
            </article>
          \`;
        }).join("");

        content.innerHTML = '<div class="grid">' + cards + "</div>";
        content.querySelectorAll("[data-kill]").forEach((button) => {
          button.addEventListener("click", () => {
            const pid = Number(button.getAttribute("data-kill"));
            if (!Number.isNaN(pid)) {
              vscode.postMessage({ type: "kill", pid });
            }
          });
        });
      });

      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      vscode.postMessage({ type: "ready" });
    </script>
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

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  let processes: NodeProcess[] = [];
  let panel: KillStackPanel | undefined;
  const statusBarItem = createStatusBarButton(context);

  const syncUi = async (): Promise<NodeProcess[]> => {
    processes = await getNodeProcesses();
    await updateStatusBar(statusBarItem, processes);
    if (panel) {
      await panel.update(processes);
    }
    return processes;
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
            await killProcess(pid);
            vscode.window.showInformationMessage(
              `Killed local server process PID ${pid}`,
            );
          } catch (err) {
            vscode.window.showErrorMessage(`Failed to kill PID ${pid}: ${err}`);
          }
          await syncUi();
        }
      },
      async () => {
        const current = await syncUi();
        if (current.length === 0) {
          vscode.window.showInformationMessage(
            "No local server processes to kill.",
          );
          return;
        }

        const detail = current
          .slice(0, 5)
          .map((process) => `${process.pid}: ${process.command}`)
          .join("\n");

        const confirmed = await vscode.window.showWarningMessage(
          `Kill all ${current.length} local server process${
            current.length !== 1 ? "es" : ""
          }?`,
          {
            modal: true,
            detail:
              current.length > 5
                ? `${detail}\n…and ${current.length - 5} more`
                : detail,
          },
          "Kill All",
        );

        if (confirmed === "Kill All") {
          const { killed, errors } = await killAllNodeProcesses(current);
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

  context.subscriptions.push(
    vscode.commands.registerCommand("killStack.showProcesses", async () => {
      await syncUi();
      await openPanel();
    }),
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

  const startAutoRefresh = (seconds: number) => {
    if (refreshTimer) clearInterval(refreshTimer);
    if (seconds > 0) {
      refreshTimer = setInterval(async () => {
        await syncUi();
      }, seconds * 1000);
    }
  };

  startAutoRefresh(intervalSec);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("killStack.autoRefreshInterval")) {
        const nextInterval =
          vscode.workspace
            .getConfiguration("killStack")
            .get<number>("autoRefreshInterval") ?? 5;
        startAutoRefresh(nextInterval);
      }
    }),
  );

  await syncUi();

  context.subscriptions.push({
    dispose: async () => {
      if (refreshTimer) clearInterval(refreshTimer);

      const killOnExit = getKillOnExitSetting();

      if (!killOnExit) {
        return;
      }

      const running = await getNodeProcesses();
      if (running.length === 0) {
        return;
      }

      if (confirmKillOnExit(running.length)) {
        await killAllNodeProcesses(running);
      }
    },
  });
}

export function deactivate(): void {
  // Cleanup is handled through context subscriptions.
}
