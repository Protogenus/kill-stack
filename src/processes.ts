export interface NodeProcess {
  pid: number;
  command: string;
  args: string;
  cpu: string;
  memory: string;
  elapsed: string;
}

interface WindowsProcessRecord {
  CommandLine?: unknown;
  ProcessId?: unknown;
  WorkingSetSize?: unknown;
}

export function parsePosixProcesses(raw: string): NodeProcess[] {
  const processes: NodeProcess[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (!match) {
      continue;
    }

    const [, pidText, cpu, memory, elapsed, commandLine] = match;
    const pid = parseInt(pidText, 10);
    if (Number.isNaN(pid) || !isNodeCommandLine(commandLine)) {
      continue;
    }

    const { command, args } = splitCommandLine(commandLine);
    processes.push({ pid, command, args, cpu, memory, elapsed });
  }

  return processes;
}

export function parseWindowsProcesses(raw: string): NodeProcess[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  let parsed: WindowsProcessRecord | WindowsProcessRecord[];
  try {
    parsed = JSON.parse(trimmed) as WindowsProcessRecord | WindowsProcessRecord[];
  } catch {
    return [];
  }

  const records = Array.isArray(parsed) ? parsed : [parsed];
  const processes: NodeProcess[] = [];

  for (const record of records) {
    const pid = normalizeNumber(record.ProcessId);
    const commandLine = normalizeString(record.CommandLine);
    if (pid === undefined || !commandLine || !isNodeCommandLine(commandLine)) {
      continue;
    }

    const { command, args } = splitCommandLine(commandLine);
    processes.push({
      pid,
      command,
      args,
      cpu: "?",
      memory: formatWindowsMemory(record.WorkingSetSize),
      elapsed: "?",
    });
  }

  return processes;
}

export function formatCpu(cpu: string): string {
  return cpu === "?" ? "?" : `${cpu}%`;
}

export function formatMemory(memory: string): string {
  return /^(\d+(\.\d+)?)$/.test(memory) ? `${memory}%` : memory;
}

function splitCommandLine(commandLine: string): { command: string; args: string } {
  const trimmed = commandLine.trim();
  if (!trimmed) {
    return { command: "", args: "" };
  }

  const match = trimmed.match(/^(".*?"|\S+)(?:\s+([\s\S]*))?$/);
  const rawCommand = match?.[1] ?? trimmed;
  const command = rawCommand.replace(/^"(.*)"$/, "$1");
  const args = match?.[2]?.trim() ?? "";

  return { command, args };
}

function isNodeCommandLine(commandLine: string): boolean {
  const { command } = splitCommandLine(commandLine);
  const normalized = command.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
  return normalized === "node" || normalized === "node.exe";
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function formatWindowsMemory(value: unknown): string {
  const memBytes = normalizeNumber(value);
  return memBytes === undefined ? "?" : `${Math.round(memBytes / 1024 / 1024)}MB`;
}
