import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Logger } from "../logger.ts";
import type { ServiceConfig, StdioTransportConfig } from "../types.ts";
import { SdkMcpClient } from "./sdk-client.ts";

/**
 * Connects to a downstream stdio service through the official MCP SDK v2.
 */
export class StdioMcpClient extends SdkMcpClient {
  /**
   * Creates the standards-compliant newline-delimited stdio transport.
   */
  public constructor(service: ServiceConfig, logger: Logger) {
    const transport = requireStdioTransport(service);
    const commandSpec = resolveCommandSpec(transport.command, transport.args ?? []);
    const cwd = transport.cwd ? resolve(transport.cwd) : process.cwd();
    const environment = mergeEnvironment(transport.env);

    super(
      service,
      logger,
      () => createStandardTransport(commandSpec.command, commandSpec.args, cwd, environment, logger, service.serviceId)
    );
  }
}

/**
 * Creates the SDK's standards-compliant newline-delimited stdio transport.
 */
function createStandardTransport(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  logger: Logger,
  serviceId: string
): StdioClientTransport {
  const transport = new StdioClientTransport({
    command,
    args,
    cwd,
    env,
    stderr: "pipe"
  });
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    const message = (typeof chunk === "string" ? chunk : chunk.toString("utf8")).trim();
    if (message) {
      logger.warn("downstream.stderr", { serviceId, message });
    }
  });
  return transport;
}

/**
 * Resolves a configured command into a directly spawnable executable on Windows.
 */
function resolveCommandSpec(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32" || /[\\/]/.test(command) || /\.[A-Za-z0-9]+$/.test(command)) {
    return { command, args };
  }

  const resolved = resolveViaPowerShell(command) ?? resolveViaWhere(command);
  if (!resolved) {
    return { command, args };
  }
  if (resolved.toLowerCase().endsWith(".ps1")) {
    const host = resolvePowerShellHost();
    return host ? { command: host, args: ["-File", resolved, ...args] } : { command, args };
  }
  return { command: resolved, args };
}

/**
 * Resolves a command name through PowerShell so script shims map to their real targets.
 */
function resolveViaPowerShell(command: string): string | null {
  const host = resolvePowerShellHost();
  if (!host) {
    return null;
  }
  try {
    const output = execFileSync(host, [
      "-NoProfile",
      "-Command",
      `(Get-Command '${command.replace(/'/g, "''")}' -ErrorAction Stop).Source`
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return output.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolves an executable through the Windows where command.
 */
function resolveViaWhere(command: string): string | null {
  try {
    const output = execFileSync("where.exe", [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return output.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.toLowerCase().endsWith(".ps1")) ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolves the preferred PowerShell host on Windows.
 */
export function resolvePowerShellHost(
  probe: (command: string) => boolean = commandExists
): string | null {
  if (probe("pwsh")) {
    return "pwsh";
  }
  if (probe("powershell.exe")) {
    return "powershell.exe";
  }
  return null;
}

/**
 * Checks whether one command exists on the current PATH.
 */
function commandExists(command: string): boolean {
  try {
    execFileSync("where.exe", [command], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Narrows a service config to stdio.
 */
function requireStdioTransport(service: ServiceConfig): StdioTransportConfig {
  if (service.transport.type !== "stdio") {
    throw new Error(`Unsupported transport '${String((service.transport as { type?: unknown }).type)}'.`);
  }
  return service.transport;
}

/**
 * Merges configured values into the current process environment without undefined entries.
 */
function mergeEnvironment(overrides: Record<string, string> | undefined): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  return { ...inherited, ...overrides };
}
