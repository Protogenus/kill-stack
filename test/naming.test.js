const test = require("node:test");
const assert = require("node:assert/strict");

const { describeServer } = require("../out/processes.js");

const proc = (command, args, cwd) => ({
  pid: 1,
  command,
  args,
  cpu: "?",
  memory: "?",
  elapsed: "?",
  framework: "Node.js",
  cwd,
});

const name = (command, args, cwd) => describeServer(proc(command, args, cwd)).name;

test("names a script by its project folder and file", () => {
  assert.equal(
    name("C:\\Program Files\\nodejs\\node.exe", "C:\\work\\api-gateway\\server.js --port 3000"),
    "api-gateway · server.js",
  );
});

test("skips generic folders like src when finding the project", () => {
  assert.equal(name("node", "C:\\work\\billing\\src\\index.js"), "billing · src/index.js");
});

test("names tools run from node_modules after the package and project", () => {
  assert.equal(
    name("node", "C:\\work\\shop\\node_modules\\vite\\bin\\vite.js --port 5173"),
    "shop · vite",
  );
  assert.equal(
    name("node", '"C:\\Users\\me\\my-site\\node_modules\\next\\dist\\bin\\next" dev'),
    "my-site · next dev",
  );
  assert.equal(
    name("node", "/work/acme/node_modules/@nestjs/cli/bin/nest.js start"),
    "acme · @nestjs/cli start",
  );
});

test("names npm scripts after the script, not the Node install", () => {
  assert.equal(
    name(
      "C:\\Program Files\\nodejs\\node.exe",
      '"C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" run dev',
    ),
    "npm run dev",
  );
  assert.equal(
    name("node", "/usr/lib/node_modules/npm/bin/npm-cli.js run dev", "/home/me/blog"),
    "blog · npm run dev",
  );
});

test("uses the working directory for relative scripts when it is known", () => {
  assert.equal(name("node", "server.js --port 3000"), "server.js");
  assert.equal(name("node", "server.js --port 3000", "/home/me/blog"), "blog · server.js");
});

test("names python modules and command-line tools", () => {
  assert.equal(name("C:\\Python311\\python.exe", "-m http.server 8000"), "http.server");
  assert.equal(name("ngrok", "http 8080"), "ngrok http");
  assert.equal(name("C:\\tools\\cloudflared.exe", "tunnel run"), "cloudflared tunnel");
});
