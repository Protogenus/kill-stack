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
    classifyLocalServerProcess("go", "run main.go"),
    "Go Server"
  );
  assert.equal(
    classifyLocalServerProcess("bun", "run --hot server.ts"),
    "Bun"
  );
  assert.equal(
    classifyLocalServerProcess("deno", "run --allow-net server.ts"),
    "Deno"
  );
  assert.equal(
    classifyLocalServerProcess("/usr/local/bin/node", "/workspace/server.js --port 3000"),
    "Node.js"
  );
  assert.equal(classifyLocalServerProcess("node", "build-script.js"), undefined);
  assert.equal(
    classifyLocalServerProcess("/usr/local/bin/node", "/workspace/scripts/watch-assets.js"),
    undefined
  );
  assert.equal(
    classifyLocalServerProcess("/usr/local/bin/node", "/workspace/api-client.js"),
    undefined
  );
  assert.equal(
    classifyLocalServerProcess("/usr/local/bin/node", "/workspace/node_modules/typescript/bin/tsc --watch -p ./"),
    undefined
  );
  assert.equal(
    classifyLocalServerProcess("/usr/local/bin/node", "/workspace/expression.js"),
    undefined
  );
  assert.equal(
    classifyLocalServerProcess("/usr/local/bin/node", "/workspace/koala.js"),
    undefined
  );
  assert.equal(
    classifyLocalServerProcess("/usr/local/bin/node", "/workspace/astronaut.js"),
    undefined
  );
  assert.equal(
    classifyLocalServerProcess("/usr/local/bin/node", "/workspace/bundle.js"),
    undefined
  );
  assert.equal(
    classifyLocalServerProcess("/usr/local/bin/node", "/workspace/denote.js"),
    undefined
  );
  assert.equal(
    classifyLocalServerProcess(
      "C:\\Users\\vapor\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
      "--max-old-space-size=3072 c:\\Users\\vapor\\.vscode\\extensions\\ms-vscode.vscode-typescript-next-6.0.20260416\\node_modules\\typescript\\lib\\tsserver.js --serverMode partialSemantic --useInferredProjectPerProjectRoot --disableAutomaticTypingAcquisition --cancellationPipeName C:\\Users\\vapor\\AppData\\Local\\Temp\\vscode-typescript\\tmp* --globalPlugins @vscode/copilot-typescript-server-plugin --pluginProbeLocations c:\\Users\\vapor\\.vscode\\extensions\\github.copilot-chat-0.44.1 --locale en --noGetErrOnBackgroundUpdate --canUseWatchEvents --validateDefaultNpmLocation --useNodeIpc",
      "Code.exe"
    ),
    undefined
  );
});

test("format helpers keep platform-specific values readable", () => {
  assert.equal(formatCpu("1.5"), "1.5%");
  assert.equal(formatCpu("?"), "?");
  assert.equal(formatMemory("0.7"), "0.7%");
  assert.equal(formatMemory("125MB"), "125MB");
  assert.equal(formatMemory("?"), "?");
});

test("parseProcessTree and collectDescendantPids return children deepest first", () => {
  const { parseProcessTree, collectDescendantPids } = require("../out/processes.js");
  const tree = parseProcessTree(["  10 1", "  11 10", "  12 11", "  13 10", "  14 1"].join("\n"));

  assert.deepEqual(collectDescendantPids(10, tree), [12, 11, 13]);
  assert.deepEqual(collectDescendantPids(14, tree), []);
});

test("parseWindowsProcesses derives elapsed time from CreationDate", () => {
  const { parseWindowsProcesses } = require("../out/processes.js");
  const now = Date.parse("2026-10-05T12:00:00Z");
  const raw = JSON.stringify({
    ProcessId: 7,
    Name: "node.exe",
    CommandLine: "node server.js",
    WorkingSetSize: 1048576,
    CreationDate: "2026-10-05T11:55:30.0000000Z",
  });

  const [proc] = parseWindowsProcesses(raw, now);
  assert.equal(proc.elapsed, "04:30");
});

test("formatElapsed matches ps etime style", () => {
  const { formatElapsed } = require("../out/processes.js");
  assert.equal(formatElapsed(59), "00:59");
  assert.equal(formatElapsed(3723), "01:02:03");
  assert.equal(formatElapsed(90061), "1-01:01:01");
});

test("parseNetstatListeningPorts reads IPv4 and IPv6 listeners", () => {
  const { parseNetstatListeningPorts } = require("../out/processes.js");
  const raw = [
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4321",
    "  TCP    [::]:3000              [::]:0                 LISTENING       4321",
    "  TCP    127.0.0.1:5432         0.0.0.0:0              LISTENING       999",
    "  TCP    127.0.0.1:52000        127.0.0.1:3000         ESTABLISHED     4321",
  ].join("\r\n");

  assert.deepEqual([...parseNetstatListeningPorts(raw)], [[4321, [3000]], [999, [5432]]]);
});

test("parseLsofListeningPorts reads pid and port fields", () => {
  const { parseLsofListeningPorts } = require("../out/processes.js");
  const raw = ["p812", "n*:8080", "n127.0.0.1:9229", "p55", "n[::1]:5173"].join("\n");

  assert.deepEqual([...parseLsofListeningPorts(raw)], [[812, [8080, 9229]], [55, [5173]]]);
});

test("matchesIgnorePattern matches command lines case-insensitively", () => {
  const { matchesIgnorePattern } = require("../out/processes.js");
  const proc = {
    pid: 1, command: "/usr/bin/docker-proxy", args: "-host-port 5432", cpu: "?", memory: "?", elapsed: "?", framework: "Node.js",
  };

  assert.equal(matchesIgnorePattern(proc, ["DOCKER-PROXY"]), true);
  assert.equal(matchesIgnorePattern(proc, ["5432"]), true);
  assert.equal(matchesIgnorePattern(proc, ["  "]), false);
  assert.equal(matchesIgnorePattern(proc, ["ngrok"]), false);
});
