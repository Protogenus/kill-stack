const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatCpu,
  formatMemory,
  parsePosixProcesses,
  parseWindowsProcesses,
} = require("../out/processes.js");

test("parsePosixProcesses keeps only real node executables", () => {
  const raw = [
    "  101  1.2  0.4  00:01:12 /usr/local/bin/node /workspace/server.js --watch",
    "  102  0.3  0.1  00:00:05 npm run dev",
    "  103  0.1  0.1  00:00:02 /usr/bin/node",
  ].join("\n");

  assert.deepEqual(parsePosixProcesses(raw), [
    {
      pid: 101,
      command: "/usr/local/bin/node",
      args: "/workspace/server.js --watch",
      cpu: "1.2",
      memory: "0.4",
      elapsed: "00:01:12",
    },
    {
      pid: 103,
      command: "/usr/bin/node",
      args: "",
      cpu: "0.1",
      memory: "0.1",
      elapsed: "00:00:02",
    },
  ]);
});

test("parseWindowsProcesses handles single JSON objects and quoted paths", () => {
  const raw = JSON.stringify({
    ProcessId: 4500,
    CommandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\apps\\server.js" --port 3000',
    WorkingSetSize: 104857600,
  });

  assert.deepEqual(parseWindowsProcesses(raw), [
    {
      pid: 4500,
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: '"C:\\apps\\server.js" --port 3000',
      cpu: "?",
      memory: "100MB",
      elapsed: "?",
    },
  ]);
});

test("parseWindowsProcesses handles arrays and ignores non-node processes", () => {
  const raw = JSON.stringify([
    {
      ProcessId: "5500",
      CommandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\apps\\api,worker.js"',
      WorkingSetSize: "2097152",
    },
    {
      ProcessId: 5501,
      CommandLine: "npm run dev",
      WorkingSetSize: 4096,
    },
  ]);

  assert.deepEqual(parseWindowsProcesses(raw), [
    {
      pid: 5500,
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: '"C:\\apps\\api,worker.js"',
      cpu: "?",
      memory: "2MB",
      elapsed: "?",
    },
  ]);
});

test("format helpers keep platform-specific values readable", () => {
  assert.equal(formatCpu("1.5"), "1.5%");
  assert.equal(formatCpu("?"), "?");
  assert.equal(formatMemory("0.7"), "0.7%");
  assert.equal(formatMemory("125MB"), "125MB");
  assert.equal(formatMemory("?"), "?");
});
