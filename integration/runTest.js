// Launches a real VS Code with Kill Stack loaded and a temporary workspace
// folder, then runs the smoke suite inside that VS Code instance.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runTests } = require("@vscode/test-electron");

const SERVER_SOURCE = "setInterval(() => {}, 1000);\n";

(async () => {
  // Electron-based shells set this, which makes VS Code start as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;

  const extensionDevelopmentPath = path.resolve(__dirname, "..");
  const extensionTestsPath = path.resolve(__dirname, "suite", "index.js");

  // The workspace folder holds a server script, so the test can start a server
  // "inside" the open folder.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "killstack-ws-"));
  fs.writeFileSync(path.join(workspace, "server.js"), SERVER_SOURCE);

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspace, "--disable-extensions"],
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
