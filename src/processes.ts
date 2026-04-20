export interface NodeProcess {
  pid: number;
  command: string;
  args: string;
  cpu: string;
  memory: string;
  elapsed: string;
  framework: string;
}

interface WindowsProcessRecord {
  CommandLine?: unknown;
  Name?: unknown;
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
    const imageName = normalizeString(record.Name);
    if (pid === undefined) {
      continue;
    }

    const { command, args } = splitWindowsProcess(record);
    const framework = classifyLocalServerProcess(command, args, imageName);
    if (!framework) {
      continue;
    }

    processes.push({
      pid,
      command,
      args,
      cpu: "?",
      memory: formatWindowsMemory(record.WorkingSetSize),
      elapsed: "?",
      framework,
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
    "-p ",
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
