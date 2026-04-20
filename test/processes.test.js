const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyLocalServerProcess,
  formatCpu,
  formatMemory,
  parsePosixProcesses,
  parseWindowsProcesses,
} = require("../out/processes.js");

test("parsePosixProcesses keeps only real node executables", () => {
  const raw = [
    "  101  1.2  0.4  00:01:12 /usr/local/bin/node /workspace/server.js --port 3000",
    "  102  0.3  0.1  00:00:05 npm run dev",
    "  103  0.1  0.1  00:00:02 python3 -m http.server 8000",
    "  104  0.1  0.1  00:00:02 php -S localhost:8080",
  ].join("\n");

  assert.deepEqual(parsePosixProcesses(raw), [
    {
      pid: 101,
      command: "/usr/local/bin/node",
      args: "/workspace/server.js --port 3000",
      cpu: "1.2",
      memory: "0.4",
      elapsed: "00:01:12",
      framework: "Node.js",
    },
    {
      pid: 103,
      command: "python3",
      args: "-m http.server 8000",
      cpu: "0.1",
      memory: "0.1",
      elapsed: "00:00:02",
      framework: "Python HTTP Server",
    },
    {
      pid: 104,
      command: "php",
      args: "-S localhost:8080",
      cpu: "0.1",
      memory: "0.1",
      elapsed: "00:00:02",
      framework: "PHP Built-in Server",
    },
  ]);
});

test("parseWindowsProcesses handles single JSON objects and quoted paths", () => {
  const raw = JSON.stringify({
    Name: "node.exe",
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
      framework: "Node.js",
    },
  ]);
});

test("parseWindowsProcesses handles arrays and ignores non-node processes", () => {
  const raw = JSON.stringify([
    {
      Name: "python.exe",
      ProcessId: "5500",
      CommandLine: '"C:\\Python311\\python.exe" -m http.server 9000',
      WorkingSetSize: "2097152",
    },
    {
      Name: "npm.exe",
      ProcessId: 5501,
      CommandLine: "npm run dev",
      WorkingSetSize: 4096,
    },
  ]);

  assert.deepEqual(parseWindowsProcesses(raw), [
    {
      pid: 5500,
      command: "C:\\Python311\\python.exe",
      args: "-m http.server 9000",
      cpu: "?",
      memory: "2MB",
      elapsed: "?",
      framework: "Python HTTP Server",
    },
  ]);
});

test("classifyLocalServerProcess labels common frameworks and tools", () => {
  assert.equal(
    classifyLocalServerProcess(
      "/usr/local/bin/node",
      "/workspace/node_modules/next/dist/bin/next dev"
    ),
    "Next.js"
  );
  assert.equal(
    classifyLocalServerProcess(
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\app\\node_modules\\vite\\bin\\vite.js"
    ),
    "Vite"
  );
  assert.equal(
    classifyLocalServerProcess(
      "/usr/local/bin/node",
      "/workspace/node_modules/@nestjs/cli/bin/nest.js start"
    ),
    "NestJS"
  );
  assert.equal(
    classifyLocalServerProcess("/usr/local/bin/node", "/workspace/server-express.js"),
    "Express"
  );
  assert.equal(
    classifyLocalServerProcess("/usr/local/bin/node", "/workspace/scripts/jobs/worker.js"),
    "Worker"
  );
  assert.equal(
    classifyLocalServerProcess("python3", "-m http.server 8000"),
    "Python HTTP Server"
  );
  assert.equal(
    classifyLocalServerProcess("php", "-S localhost:8080"),
    "PHP Built-in Server"
  );
  assert.equal(
    classifyLocalServerProcess("ngrok", "http 3000"),
    "ngrok"
  );
  assert.equal(
    classifyLocalServerProcess("/usr/local/bin/node", "/workspace/server.js --port 3000"),
    "Node.js"
  );
  assert.equal(classifyLocalServerProcess("node", "build-script.js"), undefined);
});

test("format helpers keep platform-specific values readable", () => {
  assert.equal(formatCpu("1.5"), "1.5%");
  assert.equal(formatCpu("?"), "?");
  assert.equal(formatMemory("0.7"), "0.7%");
  assert.equal(formatMemory("125MB"), "125MB");
  assert.equal(formatMemory("?"), "?");
});
