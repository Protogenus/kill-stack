// Kill Stack dashboard script. Rows are keyed by PID and updated in place, so
// keyboard focus, open command panels, and text selection survive each refresh.
(function () {
  const vscode = acquireVsCodeApi();

  const el = (id) => document.getElementById(id);
  const countEl = el("count");
  const portsEl = el("ports");
  const exitCountEl = el("exitCount");
  const updatedEl = el("updated");
  const listEl = el("list");
  const emptyEl = el("empty");
  const statusEl = el("status");
  const refreshButton = el("refresh");
  const killAllButton = el("killAll");
  const killOnExitToggle = el("killOnExit");
  const killOnExitHelp = el("killOnExitHelp");

  const rows = new Map();
  let lastCount = -1;

  refreshButton.addEventListener("click", () => {
    vscode.postMessage({ type: "refresh" });
  });

  killAllButton.addEventListener("click", () => {
    if (!killAllButton.disabled) {
      vscode.postMessage({ type: "killAll" });
    }
  });

  killOnExitToggle.addEventListener("change", () => {
    vscode.postMessage({
      type: "setKillOnExit",
      enabled: killOnExitToggle.checked,
    });
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message && message.type === "processes") {
      render(message);
    }
  });

  function createRow(pid) {
    const item = document.createElement("li");
    item.className = "row";
    item.dataset.pid = String(pid);
    item.innerHTML = `
      <div class="row-main">
        <div class="row-info">
          <div class="row-title-line">
            <span class="chip" data-field="framework"></span>
            <span class="row-title" data-field="title"></span>
            <span class="pill" data-field="pill" hidden></span>
          </div>
          <div class="row-meta" data-field="meta"></div>
        </div>
        <dl class="row-stats">
          <div><dt>CPU</dt><dd data-field="cpu"></dd></div>
          <div><dt>Memory</dt><dd data-field="memory"></dd></div>
        </dl>
        <button type="button" class="btn btn-danger" data-field="kill">Kill</button>
      </div>
      <details class="row-details">
        <summary>Command</summary>
        <pre data-field="command"></pre>
      </details>`;

    item.querySelector('[data-field="kill"]').addEventListener("click", () => {
      vscode.postMessage({ type: "kill", pid });
    });

    const refs = {};
    item.querySelectorAll("[data-field]").forEach((node) => {
      refs[node.dataset.field] = node;
    });
    rows.set(pid, { item, refs });
    return rows.get(pid);
  }

  function fillRow(row, proc) {
    const { refs } = row;
    const fullCommand = proc.args ? `${proc.command} ${proc.args}` : proc.command;

    row.item.classList.toggle("is-ignored", Boolean(proc.ignored));

    refs.framework.textContent = proc.framework;
    refs.title.textContent = proc.label;
    refs.title.title = fullCommand;

    // Every server stops on exit unless it is ignored, so only ignored ones are marked.
    refs.pill.textContent = "Ignored";
    refs.pill.className = "pill pill-ignored";
    refs.pill.hidden = !proc.ignored;

    const meta = [];
    if (proc.ports && proc.ports.length) {
      meta.push(proc.ports.map((port) => `:${port}`).join(", "));
    }
    if (proc.elapsed && proc.elapsed !== "?") {
      meta.push(proc.elapsed);
    }
    meta.push(`PID ${proc.pid}`);
    refs.meta.replaceChildren(
      ...meta.map((text) => {
        const span = document.createElement("span");
        span.textContent = text;
        return span;
      }),
    );

    refs.cpu.textContent = proc.cpu;
    refs.memory.textContent = proc.memory;
    refs.command.textContent = fullCommand;

    refs.kill.setAttribute("aria-label", `Kill ${proc.label}, PID ${proc.pid}`);
  }

  function render(message) {
    const processes = message.processes || [];
    const killable = processes.filter((proc) => !proc.ignored).length;
    const ports = processes.reduce(
      (total, proc) => total + (proc.ports ? proc.ports.length : 0),
      0,
    );
    const stopping = processes.filter((proc) => proc.stopsOnExit).length;

    countEl.textContent = String(processes.length);
    portsEl.textContent = String(ports);
    exitCountEl.textContent = String(stopping);
    updatedEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;

    killOnExitToggle.checked = Boolean(message.killOnExitEnabled);
    killOnExitHelp.textContent = killOnExitToggle.checked
      ? "Stops all detected servers when VS Code closes, except ignored ones."
      : "Leaves servers running when VS Code closes.";

    killAllButton.disabled = killable === 0;
    killAllButton.setAttribute(
      "aria-disabled",
      String(killAllButton.disabled),
    );

    emptyEl.hidden = processes.length > 0;
    listEl.hidden = processes.length === 0;

    // Keep rows in the order the extension sent them, reusing existing nodes.
    const seen = new Set();
    let cursor = listEl.firstElementChild;
    for (const proc of processes) {
      seen.add(proc.pid);
      const row = rows.get(proc.pid) || createRow(proc.pid);
      fillRow(row, proc);
      if (row.item !== cursor) {
        listEl.insertBefore(row.item, cursor);
      } else {
        cursor = cursor.nextElementSibling;
      }
    }

    for (const [pid, row] of rows) {
      if (!seen.has(pid)) {
        row.item.remove();
        rows.delete(pid);
      }
    }

    if (processes.length !== lastCount) {
      lastCount = processes.length;
      statusEl.textContent =
        processes.length === 0
          ? "No local servers running"
          : `${processes.length} local server${processes.length === 1 ? "" : "s"} running`;
    }
  }

  vscode.postMessage({ type: "ready" });
})();
