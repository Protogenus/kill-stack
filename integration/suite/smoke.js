// Smoke tests that run inside a real VS Code extension host.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
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

async function setKillOnExit(enabled) {
  await vscode.workspace
    .getConfiguration("killStack")
    .update("killOnExit", enabled, vscode.ConfigurationTarget.Global);
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

  test("kill on exit stops servers in the open folder and leaves others running", async function () {
    // macOS shows a confirmation dialog on exit, which cannot be answered in a test.
    if (process.platform === "darwin") {
      this.skip();
    }

    const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "killstack-outside-"));
    const outsideScript = path.join(outsideDir, "server.js");
    fs.writeFileSync(outsideScript, SERVER_SOURCE);

    const inside = await startServer(path.join(folder, "server.js"), 9101);
    const outside = await startServer(outsideScript, 9102);
    children.push(inside, outside);

    await setKillOnExit(true);
    callDeactivate();

    assert.ok(await waitForExit(inside.pid), "server in the open folder should stop");
    assert.ok(isAlive(outside.pid), "server outside the open folder should keep running");
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
