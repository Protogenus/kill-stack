export interface ServerProcess {
  pid: number;
  command: string;
  args: string;
  cpu: string;
  memory: string;
  elapsed: string;
  framework: string;
  ports?: number[];
  // Parent process ID, when the platform listing includes it (Windows).
  ppid?: number;
  // Directory the process was started in, when the platform exposes it.
  cwd?: string;
  // Windows only: cumulative CPU time in 100-ns ticks, and the start time used to tell PIDs apart over time.
  cpuTicks?: number;
  startedAt?: string;
}

interface WindowsProcessRecord {
  CommandLine?: unknown;
  CreationDate?: unknown;
  KernelModeTime?: unknown;
  Name?: unknown;
  ParentProcessId?: unknown;
  ProcessId?: unknown;
  UserModeTime?: unknown;
  WorkingSetSize?: unknown;
}

export interface CpuSample {
  ticks: number;
  at: number;
}

export function parsePosixProcesses(raw: string): ServerProcess[] {
  const processes: ServerProcess[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (!match) {
      continue;
    }

    const [, pidText, cpu, memory, elapsed, commandLine] = match;
    const pid = parseInt(pidText, 10);
    if (Number.isNaN(pid)) {
      continue;
    }

    const { command, args } = splitCommandLine(commandLine);
    const framework = classifyLocalServerProcess(command, args);
    if (!framework) {
      continue;
    }
    processes.push({
      pid,
      command,
      args,
      cpu,
      memory,
      elapsed,
      framework,
    });
  }

  return processes;
}

export function parseWindowsProcesses(
  raw: string,
  now = Date.now(),
): ServerProcess[] {
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
  const processes: ServerProcess[] = [];

  for (const record of records) {
    const pid = normalizeNumber(record.ProcessId);
    const commandLine = normalizeString(record.CommandLine);
    const imageName = normalizeString(record.Name);
    if (pid === undefined) {
      continue;
    }

    const { command, args } = splitWindowsProcess(record);
    const framework = classifyLocalServerProcess(command, args, imageName);
    if (!framework) {
      continue;
    }

    const cpuTicks = normalizeCpuTicks(record);
    const ppid = normalizeNumber(record.ParentProcessId);
    const startedAt = normalizeString(record.CreationDate);

    processes.push({
      pid,
      command,
      args,
      cpu: "?",
      memory: formatWindowsMemory(record.WorkingSetSize),
      elapsed: formatWindowsElapsed(record.CreationDate, now),
      framework,
      ...(cpuTicks !== undefined ? { cpuTicks } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(ppid !== undefined ? { ppid } : {}),
    });
  }

  return processes;
}

function normalizeCpuTicks(record: WindowsProcessRecord): number | undefined {
  const kernel = normalizeNumber(record.KernelModeTime);
  const user = normalizeNumber(record.UserModeTime);
  return kernel === undefined || user === undefined ? undefined : kernel + user;
}

// Fills in cpu percentages from the change in CPU time since the previous
// sample. Returns the samples to keep for the next call. Like `ps pcpu`, a value
// of 100 means one full core. The first sample of a process stays "?".
// Hides a process whose parent is also listed with the same arguments, such as
// the real Python started by the Windows python.exe launcher. The parent row
// stays, because killing it stops the child too, and it takes the child's ports
// so the port is still shown.
export function collapseLauncherChildren(
  processes: ServerProcess[],
): ServerProcess[] {
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const sameArgs = (a: string, b: string) =>
    a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
  const hidden = new Set<number>();

  for (const proc of processes) {
    const parent = proc.ppid !== undefined ? byPid.get(proc.ppid) : undefined;
    if (parent && parent !== proc && sameArgs(parent.args, proc.args)) {
      hidden.add(proc.pid);
    }
  }

  return processes
    .filter((proc) => !hidden.has(proc.pid))
    .map((proc) => {
      const childPorts = processes
        .filter((child) => hidden.has(child.pid) && child.ppid === proc.pid)
        .flatMap((child) => child.ports ?? []);
      if (childPorts.length === 0) {
        return proc;
      }
      const ports = [...new Set([...(proc.ports ?? []), ...childPorts])].sort(
        (a, b) => a - b,
      );
      return { ...proc, ports };
    });
}

export function applyWindowsCpu(
  processes: ServerProcess[],
  previous: Map<string, CpuSample>,
  now: number,
): Map<string, CpuSample> {
  const next = new Map<string, CpuSample>();

  for (const proc of processes) {
    if (proc.cpuTicks === undefined || !proc.startedAt) {
      continue;
    }

    const key = `${proc.pid}|${proc.startedAt}`;
    next.set(key, { ticks: proc.cpuTicks, at: now });

    const prior = previous.get(key);
    if (prior && now > prior.at && proc.cpuTicks >= prior.ticks) {
      // 10,000 ticks of 100 ns make one millisecond.
      const percent =
        ((proc.cpuTicks - prior.ticks) / ((now - prior.at) * 10000)) * 100;
      proc.cpu = percent.toFixed(1);
    }
  }

  return next;
}

// Parses `ss -H -ltnp` output into PID -> listening ports (Linux).
export function parseSsListeningPorts(raw: string): Map<number, number[]> {
  const ports = new Map<number, number[]>();

  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("LISTEN")) {
      continue;
    }

    const portMatch = line.match(/:(\d+)\s+\S+\s+users:/);
    if (!portMatch) {
      continue;
    }

    const port = Number(portMatch[1]);
    for (const pidMatch of line.matchAll(/pid=(\d+)/g)) {
      addListeningPort(ports, Number(pidMatch[1]), port);
    }
  }

  return ports;
}

// Parses `lsof -a -d cwd -Fpn -p <pids>` output into PID -> working directory (macOS).
export function parseLsofWorkingDirectories(raw: string): Map<number, string> {
  const directories = new Map<number, string>();
  let pid: number | undefined;

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("p")) {
      pid = parseInt(line.slice(1), 10);
    } else if (line.startsWith("n") && pid !== undefined) {
      directories.set(pid, line.slice(1));
    }
  }

  return directories;
}

// Parses `netstat -ano` output into PID -> listening ports. The state column is
// translated on non-English Windows, so a listener is identified by its foreign
// address having port 0 instead of by the word LISTENING.
export function parseNetstatListeningPorts(raw: string): Map<number, number[]> {
  const ports = new Map<number, number[]>();

  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+:0\s+\S+\s+(\d+)\s*$/);
    if (match) {
      addListeningPort(ports, Number(match[2]), Number(match[1]));
    }
  }

  return ports;
}

// Parses `lsof -nP -iTCP -sTCP:LISTEN -F pn` output into PID -> listening ports.
export function parseLsofListeningPorts(raw: string): Map<number, number[]> {
  const ports = new Map<number, number[]>();
  let pid: number | undefined;

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("p")) {
      pid = parseInt(line.slice(1), 10);
    } else if (line.startsWith("n") && pid !== undefined) {
      const match = line.match(/:(\d+)$/);
      if (match) {
        addListeningPort(ports, pid, Number(match[1]));
      }
    }
  }

  return ports;
}

function addListeningPort(
  ports: Map<number, number[]>,
  pid: number,
  port: number,
): void {
  const existing = ports.get(pid) ?? [];
  if (!existing.includes(port)) {
    ports.set(pid, [...existing, port].sort((a, b) => a - b));
  }
}

// True when the command line contains any ignore pattern (case-insensitive).
export function matchesIgnorePattern(
  proc: ServerProcess,
  patterns: string[],
): boolean {
  const haystack = `${proc.command} ${proc.args}`.toLowerCase();
  return patterns.some((pattern) => {
    const needle = pattern.trim().toLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  });
}

// Formats seconds like ps etime: mm:ss, hh:mm:ss, or d-hh:mm:ss.
export function formatElapsed(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  const clock = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;

  if (days > 0) {
    return `${days}-${clock}`;
  }
  if (hours > 0) {
    return clock;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

function formatWindowsElapsed(value: unknown, now: number): string {
  if (typeof value !== "string") {
    return "?";
  }

  // PowerShell emits ISO strings with 7 fractional digits; Date needs 3 or fewer.
  const started = Date.parse(value.replace(/(\.\d{3})\d*Z$/, "$1Z"));
  if (Number.isNaN(started)) {
    return "?";
  }

  return formatElapsed((now - started) / 1000);
}

// Maps each parent PID to its direct child PIDs. Input is `ps -axo pid=,ppid=` output.
export function parseProcessTree(raw: string): Map<number, number[]> {
  const children = new Map<number, number[]>();

  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (!match) {
      continue;
    }

    const pid = parseInt(match[1], 10);
    const ppid = parseInt(match[2], 10);
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }

  return children;
}

// Returns every descendant of pid, deepest first, so children are killed before their parents.
export function collectDescendantPids(
  pid: number,
  children: Map<number, number[]>,
): number[] {
  const descendants: number[] = [];

  for (const child of children.get(pid) ?? []) {
    descendants.push(...collectDescendantPids(child, children), child);
  }

  return descendants;
}

// Folder names that say nothing about which project a script belongs to.
const GENERIC_DIRS = new Set([
  "src", "dist", "build", "out", "lib", "bin", "app", "server", "scripts",
  "api", "backend", "frontend", "web", "client", ".bin", "cli",
]);

const RUNNERS = new Set(["npm", "npx", "yarn", "pnpm", "bun"]);

export interface ServerName {
  // Short name, such as "shop · vite" or "api · server.js".
  name: string;
  // Project folder the server belongs to, when it can be worked out.
  project?: string;
  // Script, tool, or command that is running.
  entry: string;
}

// Works out a recognizable name from the command line. A bare "node" tells the
// user nothing, so this looks for the script path, the package running from
// node_modules, or the npm script, and the project folder around it.
export function describeServer(proc: ServerProcess): ServerName {
  const tokens = splitArgs(proc.args);
  const executable = baseName(proc.command).replace(/\.exe$/i, "");
  const scriptIndex = tokens.findIndex((token) => looksLikePath(token));
  const script = scriptIndex >= 0 ? tokens[scriptIndex] : undefined;
  let project = proc.cwd ? baseName(proc.cwd) : undefined;
  let entry = executable;

  if (script) {
    const parts = script.replace(/\\/g, "/").split("/").filter(Boolean);
    const modules = parts.lastIndexOf("node_modules");

    if (modules >= 0 && parts[modules + 1]) {
      // A tool installed in node_modules, such as vite or next.
      const scoped = parts[modules + 1].startsWith("@");
      const pkg = scoped
        ? `${parts[modules + 1]}/${parts[modules + 2] ?? ""}`
        : parts[modules + 1];
      const projectIndex = projectFolderIndex(parts, modules);
      project = projectIndex >= 0 ? parts[projectIndex] : project;

      if (RUNNERS.has(pkg)) {
        // npm, yarn, and friends: show the script they run, such as "npm run dev".
        const rest = tokens.slice(scriptIndex + 1).filter((t) => !t.startsWith("-"));
        entry = [pkg, ...rest.slice(0, 2)].join(" ");
        // The runner lives in the Node install, not in the project.
        project = proc.cwd ? baseName(proc.cwd) : undefined;
      } else {
        const command = tokens.slice(scriptIndex + 1).find((t) => /^[a-z][\w:-]*$/i.test(t));
        entry = command && ["dev", "start", "serve", "preview"].includes(command)
          ? `${pkg} ${command}`
          : pkg;
      }
    } else {
      const file = parts[parts.length - 1] ?? script;
      const projectIndex = projectFolderIndex(parts, parts.length - 1);
      if (projectIndex >= 0) {
        project = parts[projectIndex];
        const inner = parts.slice(projectIndex + 1);
        entry = inner.length > 0 ? inner.join("/") : file;
      } else {
        entry = file;
      }
    }
  } else if (tokens[0] === "-m" && tokens[1]) {
    // python -m http.server, python -m uvicorn, and similar.
    entry = tokens[1];
  } else if (tokens[0] && !tokens[0].startsWith("-") && executable !== "node") {
    // Tools like "ngrok http 8080" or "rails server".
    entry = `${executable} ${tokens[0]}`;
  }

  const name = project && project.toLowerCase() !== entry.toLowerCase()
    ? `${project} · ${entry}`
    : entry;
  return { name, project, entry };
}

// Index of the nearest folder above `before` that names a project, skipping
// generic names like src or dist.
function projectFolderIndex(parts: string[], before: number): number {
  for (let i = before - 1; i >= 0; i--) {
    const part = parts[i];
    if (/^[a-z]:$/i.test(part) || part === "node_modules") {
      continue;
    }
    if (!GENERIC_DIRS.has(part.toLowerCase())) {
      return i;
    }
  }
  return -1;
}

function looksLikePath(token: string): boolean {
  if (token.startsWith("-")) {
    return false;
  }
  return /[\\/]/.test(token) || /\.(c|m)?[jt]sx?$|\.py$|\.rb$|\.php$/i.test(token);
}

function baseName(value: string): string {
  const parts = value.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

// Splits an argument string on spaces, keeping quoted segments together.
function splitArgs(args: string): string[] {
  const tokens: string[] = [];
  for (const match of args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

export function formatCpu(cpu: string): string {
  return cpu === "?" ? "?" : `${cpu}%`;
}

export function formatMemory(memory: string): string {
  return /^(\d+(\.\d+)?)$/.test(memory) ? `${memory}%` : memory;
}

export function classifyLocalServerProcess(
  command: string,
  args: string,
  imageName = ""
): string | undefined {
  const haystack = ` ${command} ${args} ${imageName} `.toLowerCase();
  const normalizedHaystack = haystack.replace(/\\/g, "/");
  const executable = command.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  const image = imageName.toLowerCase();

  if (
    normalizedHaystack.includes("next/dist/bin/next") ||
    /\bnext\s+(dev|start)\b/.test(haystack)
  ) {
    return "Next.js";
  }

  if (
    normalizedHaystack.includes("/vite/bin/vite") ||
    /\bvite(?:\.js)?(?:\s|$)/.test(haystack)
  ) {
    return "Vite";
  }

  if (containsAnyToken(haystack, ["nuxt", "nuxi"])) {
    return "Nuxt";
  }

  if (
    containsToken(haystack, "svelte-kit") ||
    normalizedHaystack.includes("@sveltejs/kit")
  ) {
    return "SvelteKit";
  }

  if (containsToken(haystack, "astro")) {
    return "Astro";
  }

  if (containsToken(haystack, "remix") || normalizedHaystack.includes("@remix-run")) {
    return "Remix";
  }

  if (containsAnyToken(haystack, ["nestjs", "@nestjs"]) || /\bnest\s+start\b/.test(haystack)) {
    return "NestJS";
  }

  if (containsToken(haystack, "express")) {
    return "Express";
  }

  if (containsToken(haystack, "socket.io")) {
    return "Socket.IO";
  }

  if (containsToken(haystack, "fastify")) {
    return "Fastify";
  }

  if (containsToken(haystack, "koa")) {
    return "Koa";
  }

  if (
    isJavaScriptRuntime(executable, image) &&
    (
      containsToken(haystack, "bullmq") ||
      normalizedHaystack.includes("/jobs/") ||
      normalizedHaystack.includes("/worker.js") ||
      normalizedHaystack.includes("/workers/") ||
      containsToken(haystack, "queue-worker") ||
      /\bworker:(?=\s|$)/.test(haystack) ||
      /\bworker\s+--/.test(haystack)
    )
  ) {
    return "Worker";
  }

  if (containsToken(haystack, "nodemon")) {
    return "Nodemon";
  }

  if (containsToken(haystack, "ts-node")) {
    return "ts-node";
  }

  if (containsToken(haystack, "tsx")) {
    return "tsx";
  }

  if (isBunRuntime(executable, image) || containsToken(haystack, "bun")) {
    return "Bun";
  }

  if (isDenoRuntime(executable, image) || containsToken(haystack, "deno")) {
    return "Deno";
  }

  if (containsToken(haystack, "webpack-dev-server") || /\bwebpack\s+serve\b/.test(haystack)) {
    return "Webpack Dev Server";
  }

  if (
    /\bpython(?:\d+(?:\.\d+)*)?\s+-m\s+http\.server\b/.test(haystack) ||
    /(^|[^a-z0-9])-m\s+http\.server\b/.test(haystack)
  ) {
    return "Python HTTP Server";
  }

  if (containsToken(haystack, "uvicorn")) {
    return "Uvicorn";
  }

  if (containsToken(haystack, "gunicorn")) {
    return "Gunicorn";
  }

  if (/\bflask(?:\.exe)?\s+run\b/.test(haystack) || containsToken(haystack, "flask.exe")) {
    return "Flask";
  }

  if (/\bmanage\.py\s+runserver\b/.test(haystack) || containsToken(haystack, "django")) {
    return "Django";
  }

  if (/\bphp(?:\.exe)?\s+-s\b/.test(haystack)) {
    return "PHP Built-in Server";
  }

  if (/\brails\s+server\b/.test(haystack) || containsAnyToken(haystack, ["puma", "rackup"])) {
    return "Ruby Server";
  }

  if (containsToken(haystack, "ngrok")) {
    return "ngrok";
  }

  if (containsToken(haystack, "cloudflared")) {
    return "Cloudflare Tunnel";
  }

  if (
    isJavaRuntime(executable, image) &&
    (
      haystack.includes(" -jar ") ||
      containsAnyToken(haystack, ["spring-boot", "quarkus", "jetty", "tomcat"])
    )
  ) {
    return "Java Server";
  }

  if (
    (isGoRuntime(executable, image) && matchesAny(haystack, ["go run", " run "])) ||
    isAirRuntime(executable, image) ||
    isGinRuntime(executable, image)
  ) {
    return "Go Server";
  }

  if (isPlainNodeRuntime(executable, image) && looksLikeServerCommand(haystack)) {
    return "Node.js";
  }

  if (isPythonRuntime(executable, image) && looksLikePythonServer(haystack)) {
    return "Python Server";
  }

  if (isPhpRuntime(executable, image) && looksLikePhpServer(haystack)) {
    return "PHP Server";
  }

  if (isRubyRuntime(executable, image) && looksLikeRubyServer(haystack)) {
    return "Ruby Server";
  }

  return undefined;
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

function splitWindowsProcess(record: WindowsProcessRecord): {
  command: string;
  args: string;
} {
  const commandLine = normalizeString(record.CommandLine);
  if (commandLine) {
    return splitCommandLine(commandLine);
  }

  return {
    command: normalizeString(record.Name),
    args: "",
  };
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

function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => value.includes(pattern));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsToken(value: string, token: string): boolean {
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(token)}(?=$|[^a-z0-9])`);
  return pattern.test(value);
}

function containsAnyToken(value: string, tokens: string[]): boolean {
  return tokens.some((token) => containsToken(value, token));
}

function isPlainNodeRuntime(executable: string, image: string): boolean {
  return executable === "node" || executable === "node.exe" || image === "node.exe";
}

function isPythonRuntime(executable: string, image: string): boolean {
  return (
    executable.startsWith("python") ||
    image.startsWith("python")
  );
}

function isPhpRuntime(executable: string, image: string): boolean {
  return executable === "php" || executable === "php.exe" || image === "php.exe";
}

function isRubyRuntime(executable: string, image: string): boolean {
  return executable === "ruby" || executable === "ruby.exe" || image === "ruby.exe";
}

function isBunRuntime(executable: string, image: string): boolean {
  return executable === "bun" || executable === "bun.exe" || image === "bun.exe";
}

function isDenoRuntime(executable: string, image: string): boolean {
  return executable === "deno" || executable === "deno.exe" || image === "deno.exe";
}

function isJavaRuntime(executable: string, image: string): boolean {
  return executable === "java" || executable === "java.exe" || image === "java.exe";
}

function isGoRuntime(executable: string, image: string): boolean {
  return executable === "go" || executable === "go.exe" || image === "go.exe";
}

function isAirRuntime(executable: string, image: string): boolean {
  return executable === "air" || executable === "air.exe" || image === "air.exe";
}

function isGinRuntime(executable: string, image: string): boolean {
  return executable === "gin" || executable === "gin.exe" || image === "gin.exe";
}

function isJavaScriptRuntime(executable: string, image: string): boolean {
  return (
    isPlainNodeRuntime(executable, image) ||
    isBunRuntime(executable, image) ||
    isDenoRuntime(executable, image) ||
    containsAnyToken(` ${executable} ${image} `, ["nodemon", "ts-node", "tsx"])
  );
}

function looksLikeServerCommand(value: string): boolean {
  return matchesAny(value, [
    " dev ",
    " start ",
    " server",
    " serve",
    " preview",
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "--port",
    "--host",
    "--hostname",
    "http://",
  ]);
}

function looksLikePythonServer(value: string): boolean {
  return matchesAny(value, [
    "http.server",
    "uvicorn",
    "gunicorn",
    "flask run",
    "runserver",
    "localhost",
    "127.0.0.1",
    "--host",
    "--port",
  ]);
}

function looksLikePhpServer(value: string): boolean {
  return matchesAny(value, [" -s ", "localhost", "127.0.0.1"]);
}

function looksLikeRubyServer(value: string): boolean {
  return matchesAny(value, ["rails server", "puma", "rackup", "localhost", "-p "]);
}
