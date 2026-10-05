// Kill decisions and loops, kept free of the vscode API so they can be tested.
// The OS calls (signals, taskkill, liveness checks) are passed in by the caller.
import {
  collectDescendantPids,
  matchesIgnorePattern,
  ServerProcess,
} from "./processes";

export interface KillCounts {
  killed: number;
  errors: number;
}

// System processes (PIDs 0-4 on Windows, init and friends elsewhere), plus the
// extension host and its parent, which is VS Code itself.
export function isProtectedPid(
  pid: number,
  selfPid: number,
  parentPid: number,
): boolean {
  return pid <= 4 || pid === selfPid || pid === parentPid;
}

// Order for a POSIX tree kill: descendants deepest first, then the root.
export function posixTreeKillOrder(
  pid: number,
  children: Map<number, number[]>,
): number[] {
  return [...collectDescendantPids(pid, children), pid];
}

// Servers that Kill On Exit would stop: every detected server, unless the
// setting is off or the server is on the ignore list.
export function selectExitTargets(
  processes: ServerProcess[],
  ignorePatterns: string[],
  killOnExit: boolean,
): ServerProcess[] {
  if (!killOnExit) {
    return [];
  }

  return processes.filter((proc) => !matchesIgnorePattern(proc, ignorePatterns));
}

// PIDs with a listening socket on the port, in the order ports were reported.
export function pidsOnPort(
  ports: Map<number, number[]>,
  port: number,
): number[] {
  return [...ports]
    .filter(([, listed]) => listed.includes(port))
    .map(([pid]) => pid);
}

export interface SyncKillDeps {
  isAlive: (pid: number) => boolean;
  killTree: (pid: number) => void;
}

export interface AsyncKillDeps {
  isAlive: (pid: number) => boolean;
  killTree: (pid: number) => Promise<void>;
}

// A PID that is already gone is skipped, not counted as an error. That covers
// children removed by an earlier tree kill in the same batch.
export function killPidsSync(pids: number[], deps: SyncKillDeps): KillCounts {
  const counts: KillCounts = { killed: 0, errors: 0 };

  for (const pid of pids) {
    if (!deps.isAlive(pid)) {
      continue;
    }

    try {
      deps.killTree(pid);
      counts.killed++;
    } catch {
      // Keep going: one failed kill should not block the rest.
      counts.errors++;
    }
  }

  return counts;
}

export async function killPidsAsync(
  pids: number[],
  deps: AsyncKillDeps,
): Promise<KillCounts> {
  const counts: KillCounts = { killed: 0, errors: 0 };

  for (const pid of pids) {
    if (!deps.isAlive(pid)) {
      continue;
    }

    try {
      await deps.killTree(pid);
      counts.killed++;
    } catch {
      counts.errors++;
    }
  }

  return counts;
}
