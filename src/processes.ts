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
  const executable = command.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  const image = imageName.toLowerCase();

  if (matchesAny(haystack, ["next/dist/bin/next", "@next", " next "])) {
    return "Next.js";
  }

  if (matchesAny(haystack, ["vite/bin/vite", " vite ", "/vite"])) {
    return "Vite";
  }

  if (matchesAny(haystack, ["vite\\bin\\vite", "\\vite\\"])) {
    return "Vite";
  }

  if (matchesAny(haystack, ["nuxt", "nuxi"])) {
    return "Nuxt";
  }

  if (matchesAny(haystack, ["svelte-kit", "@sveltejs/kit"])) {
    return "SvelteKit";
  }

  if (matchesAny(haystack, ["astro"])) {
    return "Astro";
  }

  if (matchesAny(haystack, ["remix", "@remix-run"])) {
    return "Remix";
  }

  if (matchesAny(haystack, ["nestjs", "@nestjs", " nest "])) {
    return "NestJS";
  }

  if (matchesAny(haystack, ["express"])) {
    return "Express";
  }

  if (matchesAny(haystack, ["socket.io"])) {
    return "Socket.IO";
  }

  if (matchesAny(haystack, ["fastify"])) {
    return "Fastify";
  }

  if (matchesAny(haystack, ["koa"])) {
    return "Koa";
  }

  if (
    matchesAny(haystack, [
      "bullmq",
      "/jobs/",
      "\\jobs\\",
      "/worker.js",
      "\\worker.js",
      "/workers/",
      "\\workers\\",
      " queue-worker",
      " worker:",
      " worker --",
    ])
  ) {
    return "Worker";
  }

  if (matchesAny(haystack, ["nodemon"])) {
    return "Nodemon";
  }

  if (matchesAny(haystack, ["ts-node"])) {
    return "ts-node";
  }

  if (matchesAny(haystack, ["tsx"])) {
    return "tsx";
  }

  if (matchesAny(haystack, ["bun"])) {
    return "Bun";
  }

  if (matchesAny(haystack, ["deno"])) {
    return "Deno";
  }

  if (matchesAny(haystack, ["webpack-dev-server", "webpack serve"])) {
    return "Webpack Dev Server";
  }

  if (
    matchesAny(haystack, [
      "python -m http.server",
      "python3 -m http.server",
      " -m http.server",
    ])
  ) {
    return "Python HTTP Server";
  }

  if (matchesAny(haystack, ["uvicorn"])) {
    return "Uvicorn";
  }

  if (matchesAny(haystack, ["gunicorn"])) {
    return "Gunicorn";
  }

  if (matchesAny(haystack, ["flask run", "flask.exe"])) {
    return "Flask";
  }

  if (matchesAny(haystack, ["manage.py runserver", "django"])) {
    return "Django";
  }

  if (matchesAny(haystack, ["php -s", "php.exe -s"])) {
    return "PHP Built-in Server";
  }

  if (matchesAny(haystack, ["rails server", "puma", "rackup"])) {
    return "Ruby Server";
  }

  if (matchesAny(haystack, ["ngrok"])) {
    return "ngrok";
  }

  if (matchesAny(haystack, ["cloudflared"])) {
    return "Cloudflare Tunnel";
  }

  if (matchesAny(haystack, ["java", "spring-boot", "quarkus", "jetty", "tomcat"])) {
    if (matchesAny(haystack, ["-jar", "spring-boot", "quarkus", "jetty", "tomcat"])) {
      return "Java Server";
    }
  }

  if (matchesAny(haystack, ["go run", "air ", "gin "])) {
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

function looksLikeServerCommand(value: string): boolean {
  return matchesAny(value, [
    " dev ",
    " start ",
    " server",
    " serve",
    " preview",
    " api",
    " watch",
    "localhost",
    "127.0.0.1",
    "--port",
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
