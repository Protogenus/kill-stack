const test = require("node:test");
const assert = require("node:assert/strict");

const { collapseLauncherChildren, parseWindowsProcesses } = require("../out/processes.js");

const proc = (pid, ppid, command, args, ports = []) => ({
  pid,
  ppid,
  command,
  args,
  cpu: "?",
  memory: "?",
  elapsed: "?",
  framework: "Python HTTP Server",
  ports,
});

test("parseWindowsProcesses reads the parent process ID", () => {
  const raw = JSON.stringify({
    ProcessId: 5512,
    ParentProcessId: 18124,
    Name: "python.exe",
    CommandLine: "python.exe -m http.server 8000",
  });
  assert.equal(parseWindowsProcesses(raw)[0].ppid, 18124);
});

test("hides the real Python started by the Windows launcher and keeps its port", () => {
  const launcher = proc(
    18124,
    3416,
    "C:\Users\me\AppData\Local\Microsoft\WindowsApps\python.exe",
    "-m http.server 8000 --bind 127.0.0.1",
  );
  const real = proc(
    5512,
    18124,
    "C:\Users\me\AppData\Local\Python\pythoncore-3.14-64\python.exe",
    " -m http.server 8000 --bind  127.0.0.1",
    [8000],
  );

  const result = collapseLauncherChildren([launcher, real]);
  assert.deepEqual(result.map((p) => p.pid), [18124]);
  assert.deepEqual(result[0].ports, [8000]);
});

test("keeps a child that runs different arguments", () => {
  const parent = proc(10, 1, "node", "C:\work\shop\server.js --port 3000", [3000]);
  const worker = proc(11, 10, "node", "C:\work\shop\worker.js --port 3001", [3001]);

  const result = collapseLauncherChildren([parent, worker]);
  assert.deepEqual(result.map((p) => p.pid), [10, 11]);
  assert.deepEqual(result[0].ports, [3000]);
});

test("leaves processes without a listed parent alone", () => {
  const a = proc(20, 999, "node", "server.js", [4000]);
  const b = proc(21, undefined, "node", "server.js", [4001]);
  assert.deepEqual(collapseLauncherChildren([a, b]).map((p) => p.pid), [20, 21]);
});
