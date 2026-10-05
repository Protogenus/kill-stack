const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyWindowsCpu,
  isInWorkspaceFolders,
  parseLsofWorkingDirectories,
  parseSsListeningPorts,
  parseWindowsProcesses,
} = require("../out/processes.js");

const proc = (overrides = {}) => ({
  pid: 42,
  command: "node",
  args: "server.js",
  cpu: "?",
  memory: "?",
  elapsed: "?",
  framework: "Node.js",
  ...overrides,
});

test("parseWindowsProcesses keeps CPU ticks and start time for sampling", () => {
  const raw = JSON.stringify({
    ProcessId: 7,
    Name: "node.exe",
    CommandLine: "node --port 3000",
    KernelModeTime: 2000000,
    UserModeTime: 3000000,
    CreationDate: "2026-10-05T11:55:30.0000000Z",
  });

  const [parsed] = parseWindowsProcesses(raw, Date.parse("2026-10-05T12:00:00Z"));
  assert.equal(parsed.cpuTicks, 5000000);
  assert.equal(parsed.startedAt, "2026-10-05T11:55:30.0000000Z");
});

test("applyWindowsCpu shows ? on the first sample and a percentage after that", () => {
  const first = [proc({ cpuTicks: 0, startedAt: "t0" })];
  const samples = applyWindowsCpu(first, new Map(), 1000);
  assert.equal(first[0].cpu, "?");

  // 5,000,000 ticks is 0.5 s of CPU time. Over 1 s of wall time that is 50%.
  const second = [proc({ cpuTicks: 5000000, startedAt: "t0" })];
  applyWindowsCpu(second, samples, 2000);
  assert.equal(second[0].cpu, "50.0");
});

test("applyWindowsCpu does not confuse a reused PID with the old process", () => {
  const before = applyWindowsCpu([proc({ cpuTicks: 9000000, startedAt: "old" })], new Map(), 1000);
  const after = [proc({ cpuTicks: 100, startedAt: "new" })];
  applyWindowsCpu(after, before, 2000);
  assert.equal(after[0].cpu, "?");
});

test("parseSsListeningPorts reads PID and port from ss output", () => {
  const raw = [
    'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=1234,fd=20))',
    'LISTEN 0 4096 [::]:5432 [::]:* users:(("postgres",pid=900,fd=5),("postgres",pid=901,fd=5))',
    "LISTEN 0 128 127.0.0.1:22 0.0.0.0:*",
  ].join("\n");

  assert.deepEqual([...parseSsListeningPorts(raw)], [[1234, [3000]], [900, [5432]], [901, [5432]]]);
});

test("parseLsofWorkingDirectories maps PID to its cwd", () => {
  const raw = ["p812", "fcwd", "n/Users/dev/app/api", "p55", "fcwd", "n/"].join("\n");
  assert.deepEqual([...parseLsofWorkingDirectories(raw)], [[812, "/Users/dev/app/api"], [55, "/"]]);
});

test("isInWorkspaceFolders matches a server started from a relative path via its working directory", () => {
  const relative = proc({ command: "node", args: "server.js", cwd: "/work/app/api" });
  assert.equal(isInWorkspaceFolders(relative, ["/work/app"]), true);
  assert.equal(isInWorkspaceFolders(relative, ["/work/other"]), false);

  // The folder must end at a path boundary, as with command-line matches.
  const sibling = proc({ command: "node", args: "server.js", cwd: "/work/app-old" });
  assert.equal(isInWorkspaceFolders(sibling, ["/work/app"]), false);

  // A root folder should not match every working directory.
  assert.equal(isInWorkspaceFolders(relative, ["/"]), false);
});
