// Smoke tests that run inside a real VS Code extension host.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { execFileSync, spawn } = require("child_process");
const vscode = require("vscode");

const EXTENSION_ID = "RedRiverDesign.kill-stack";
const repoRoot = path.resolve(__dirname, "..", "..");
const SERVER_SOURCE = "setInterval(() => {}, 1000);\n";

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

async function waitForExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}

// Starts a Node server with a --port argument so the classifier recognizes it.
async function startServer(scriptPath, port) {
  const child = spawn("node", [scriptPath, "--port", String(port)], {
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return child;
}

async function setIgnorePatterns(patterns) {
  await vscode.workspace
    .getConfiguration("killStack")
    .update("ignorePatterns", patterns, vscode.ConfigurationTarget.Global);
}

async function setKillOnExit(enabled) {
  await vscode.workspace
    .getConfiguration("killStack")
    .update("killOnExit", enabled, vscode.ConfigurationTarget.Global);
}

// Reads listening ports from the OS with the same command the extension uses,
// parsed by the same parsers, so this checks real command output.
function readListeningPorts() {
  const processes = require(path.join(repoRoot, "out", "processes.js"));
  if (process.platform === "win32") {
    return processes.parseNetstatListeningPorts(
      execFileSync("netstat", ["-ano"], { encoding: "utf8" }),
    );
  }
  if (process.platform === "linux") {
    return processes.parseSsListeningPorts(
      execFileSync("ss", ["-H", "-ltnp"], { encoding: "utf8" }),
    );
  }
  try {
    return processes.parseLsofListeningPorts(
      execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"], {
        encoding: "utf8",
      }),
    );
  } catch (err) {
    return processes.parseLsofListeningPorts(err.stdout || "");
  }
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

// Starts a real TCP listener and waits until it accepts connections.
async function startListener(scriptPath, port) {
  const child = spawn("node", [scriptPath, String(port)], {
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await canConnect(port)) {
      return child;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGKILL");
  throw new Error(`listener on port ${port} did not start`);
}

// What VS Code calls on shutdown. Loaded from the compiled output of this checkout.
function callDeactivate() {
  require(path.join(repoRoot, "out", "extension.js")).deactivate();
}

suite("Kill Stack smoke tests", () => {
  const children = [];
  let extension;

  suiteSetup(async () => {
    extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);
    await extension.activate();
  });

  teardown(async () => {
    for (const child of children.splice(0)) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await setKillOnExit(false);
    await setIgnorePatterns(undefined);
  });

  test("activates and registers its commands", async () => {
    assert.ok(extension.isActive);
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      "killStack.showProcesses",
      "killStack.statusMenu",
      "killStack.killPort",
      "killStack.killServer",
      "killStack.refresh",
      "killStack.killAll",
    ]) {
      assert.ok(commands.includes(id), `missing command ${id}`);
    }
  });

  test("contributes the Local Servers sidebar view", () => {
    const views = extension.packageJSON.contributes.views.killStack;
    assert.ok(views.some((view) => view.id === "killStack.servers"));
  });

  test("kill on exit stops every server except ignored ones", async function () {
    // macOS shows a confirmation dialog on exit, which cannot be answered in a test.
    if (process.platform === "darwin") {
      this.skip();
    }

    // One server in the open folder, one elsewhere, and one on the ignore list.
    const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const elsewhereDir = fs.mkdtempSync(path.join(os.tmpdir(), "killstack-elsewhere-"));
    const keptDir = fs.mkdtempSync(path.join(os.tmpdir(), "killstack-keep-"));
    fs.writeFileSync(path.join(elsewhereDir, "server.js"), SERVER_SOURCE);
    fs.writeFileSync(path.join(keptDir, "server.js"), SERVER_SOURCE);

    const inFolder = await startServer(path.join(folder, "server.js"), 9101);
    const elsewhere = await startServer(path.join(elsewhereDir, "server.js"), 9102);
    const kept = await startServer(path.join(keptDir, "server.js"), 9103);
    children.push(inFolder, elsewhere, kept);

    await setIgnorePatterns(["killstack-keep"]);
    await setKillOnExit(true);
    callDeactivate();

    assert.ok(await waitForExit(inFolder.pid), "server in the open folder should stop");
    assert.ok(await waitForExit(elsewhere.pid), "server outside the open folder should stop");
    assert.ok(isAlive(kept.pid), "ignored server should keep running");
  });

  test("the OS port listing includes the port a real listener opens", async () => {
    const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const port = 9201;
    const listener = await startListener(path.join(folder, "listener.js"), port);
    children.push(listener);

    const ports = readListeningPorts();
    assert.ok(
      (ports.get(listener.pid) || []).includes(port),
      `expected port ${port} for PID ${listener.pid}, got ${JSON.stringify([...ports])}`,
    );
  });

  test("does nothing on exit when kill on exit is off", async function () {
    if (process.platform === "darwin") {
      this.skip();
    }

    const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const server = await startServer(path.join(folder, "server.js"), 9103);
    children.push(server);

    await setKillOnExit(false);
    callDeactivate();

    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(isAlive(server.pid), "server should keep running when the setting is off");
  });
});
