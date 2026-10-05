// Launches a real VS Code with Kill Stack loaded and a temporary workspace
// folder, then runs the smoke suite inside that VS Code instance.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runTests } = require("@vscode/test-electron");

const SERVER_SOURCE = "setInterval(() => {}, 1000);\n";
// A real TCP listener, used to check that port detection reads OS output.
const LISTENER_SOURCE = [
  'const net = require("net");',
  "const port = Number(process.argv[2]);",
  'net.createServer().listen(port, "127.0.0.1");',
  "setInterval(() => {}, 1000);",
  "",
].join("\n");

(async () => {
  // Electron-based shells set this, which makes VS Code start as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  // Kill On Exit stops every server on the machine. This limits it to the
  // servers these tests start, so a local run never kills your own servers.
  process.env.KILLSTACK_TEST_ONLY_MATCH = "killstack-";

  const extensionDevelopmentPath = path.resolve(__dirname, "..");
  const extensionTestsPath = path.resolve(__dirname, "suite", "index.js");

  // The workspace folder holds server scripts, so the test can start a server
  // "inside" the open folder.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "killstack-ws-"));
  fs.writeFileSync(path.join(workspace, "server.js"), SERVER_SOURCE);
  fs.writeFileSync(path.join(workspace, "listener.js"), LISTENER_SOURCE);

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspace, "--disable-extensions"],
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
