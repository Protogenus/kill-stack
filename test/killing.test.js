const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isProtectedPid,
  killPidsAsync,
  killPidsSync,
  pidsOnPort,
  posixTreeKillOrder,
  selectExitTargets,
} = require("../out/killing.js");

const server = (pid, args, command = "node") => ({
  pid,
  command,
  args,
  cpu: "?",
  memory: "?",
  elapsed: "?",
  framework: "Node.js",
});

test("isProtectedPid protects system PIDs, this extension host, and its parent", () => {
  for (const pid of [0, 1, 4]) {
    assert.equal(isProtectedPid(pid, 9000, 8000), true, `pid ${pid}`);
  }
  assert.equal(isProtectedPid(9000, 9000, 8000), true, "own process");
  assert.equal(isProtectedPid(8000, 9000, 8000), true, "parent process");
  assert.equal(isProtectedPid(5, 9000, 8000), false);
  assert.equal(isProtectedPid(3000, 9000, 8000), false);
});

test("posixTreeKillOrder lists descendants deepest first, then the root", () => {
  const children = new Map([
    [10, [11, 13]],
    [11, [12]],
  ]);

  assert.deepEqual(posixTreeKillOrder(10, children), [12, 11, 13, 10]);
  assert.deepEqual(posixTreeKillOrder(99, children), [99]);
});

test("selectExitTargets returns nothing when kill on exit is off", () => {
  const procs = [server(1, "/work/app/server.js")];
  assert.deepEqual(selectExitTargets(procs, [], false), []);
});

test("selectExitTargets stops every server except ignored ones", () => {
  const procs = [
    server(1, "/work/app/server.js"),
    server(2, "/somewhere/else/server.js"),
    server(3, "/work/app/db-tunnel.js"),
  ];

  const targets = selectExitTargets(procs, ["tunnel"], true);
  assert.deepEqual(targets.map((proc) => proc.pid), [1, 2]);
});

test("pidsOnPort returns every PID listening on the port", () => {
  const ports = new Map([
    [100, [3000, 3001]],
    [200, [5432]],
    [300, [3000]],
  ]);

  assert.deepEqual(pidsOnPort(ports, 3000), [100, 300]);
  assert.deepEqual(pidsOnPort(ports, 9999), []);
});

test("killPidsSync skips PIDs that are already gone and counts failures", () => {
  const alive = new Set([10, 12, 13]);
  const killed = [];

  const counts = killPidsSync([10, 11, 12, 13], {
    isAlive: (pid) => alive.has(pid),
    killTree: (pid) => {
      if (pid === 12) {
        throw new Error("access denied");
      }
      killed.push(pid);
    },
  });

  assert.deepEqual(killed, [10, 13]);
  assert.deepEqual(counts, { killed: 2, errors: 1 });
});

test("killPidsSync does not count a child removed by an earlier tree kill", () => {
  // Killing PID 10 also removes its child 11, so 11 must not be attempted.
  const alive = new Set([10, 11]);
  const attempted = [];

  const counts = killPidsSync([10, 11], {
    isAlive: (pid) => alive.has(pid),
    killTree: (pid) => {
      attempted.push(pid);
      alive.delete(pid);
      alive.delete(11);
    },
  });

  assert.deepEqual(attempted, [10]);
  assert.deepEqual(counts, { killed: 1, errors: 0 });
});

test("killPidsAsync awaits each kill in order and keeps going after a failure", async () => {
  const alive = new Set([1, 2, 3]);
  const order = [];

  const counts = await killPidsAsync([1, 2, 3], {
    isAlive: (pid) => alive.has(pid),
    killTree: async (pid) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      order.push(pid);
      if (pid === 2) {
        throw new Error("taskkill failed");
      }
    },
  });

  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(counts, { killed: 2, errors: 1 });
});
