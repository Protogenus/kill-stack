// Windows only: checks Kill On Exit when a real VS Code window is closed.
// Runs integration/windowClose.ps1 with Kill On Exit on, then off as a control.
const path = require("path");
const { spawnSync } = require("child_process");
const { downloadAndUnzipVSCode } = require("@vscode/test-electron");

(async () => {
  if (process.platform !== "win32") {
    console.log("window-close check runs on Windows only; skipping");
    return;
  }

  const code = await downloadAndUnzipVSCode();
  const repo = path.resolve(__dirname, "..");
  const script = path.join(__dirname, "windowClose.ps1");
  let failed = false;

  for (const killOnExit of ["on", "off"]) {
    const result = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-Code",
        code,
        "-Repo",
        repo,
        "-KillOnExit",
        killOnExit,
      ],
      { stdio: "inherit" },
    );
    if (result.status !== 0) {
      failed = true;
    }
  }

  if (failed) {
    process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
