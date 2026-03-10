import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { Logger } from "../logger.ts";
import { createMessageReader, createMessageWriter, type JsonRpcFailure, type JsonRpcId, type JsonRpcMessage, type JsonRpcRequest, type JsonRpcSuccess } from "./protocol.ts";
import type { ServiceConfig, ServiceMetadata, ToolDefinition } from "../types.ts";

/**
 * Defines the default timeout applied to downstream JSON-RPC requests.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Defines the maximum number of restart attempts allowed for one service.
 */
const MAX_RESTART_ATTEMPTS = 3;

/**
 * Defines how long the gateway waits for a child process to exit gracefully.
 */
const PROCESS_EXIT_TIMEOUT_MS = 2_000;

/**
 * Provides one reusable stdio-backed MCP client for a downstream service.
 */
export class StdioMcpClient {
  /**
   * Stores the bound service config.
   */
  private readonly service: ServiceConfig;

  /**
   * Stores the shared logger instance.
   */
  private readonly logger: Logger;

  /**
   * Stores pending request resolvers keyed by request id.
   */
  private readonly pending = new Map<JsonRpcId, PendingRequest>();

  /**
   * Stores the current child process when connected.
   */
  private child: ChildProcessWithoutNullStreams | null = null;

  /**
   * Stores the writer bound to the child stdin.
   */
  private writer: ReturnType<typeof createMessageWriter> | null = null;

  /**
   * Tracks whether downstream initialization succeeded.
   */
  private initialized = false;

  /**
   * Stores the next request id used for downstream calls.
   */
  private nextId = 1;

  /**
   * Stores the downstream server info captured during initialization.
   */
  private serverInfo: Record<string, unknown> | null = null;

  /**
   * Stores the downstream protocol version captured during initialization.
   */
  private protocolVersion: string | null = null;

  /**
   * Counts automatic restart attempts after transport-level failures.
   */
  private restartAttempts = 0;

  /**
   * Stores the terminal unavailability reason once restart recovery is exhausted.
   */
  private unavailableReason: string | null = null;

  /**
   * Creates a client for one logical service.
   */
  public constructor(
    service: ServiceConfig,
    logger: Logger
  ) {
    this.service = service;
    this.logger = logger;
  }

  /**
   * Returns a stable key for logs.
   */
  public get key(): string {
    return this.service.serviceId;
  }

  /**
   * Indicates whether the service has become unavailable after recovery exhaustion.
   */
  public get isUnavailable(): boolean {
    return this.unavailableReason !== null;
  }

  /**
   * Returns the terminal unavailability reason when one exists.
   */
  public get unavailableMessage(): string | null {
    return this.unavailableReason;
  }

  /**
   * Returns the restart attempts consumed by the current lifecycle.
   */
  public get restartCount(): number {
    return this.restartAttempts;
  }

  /**
   * Checks whether the current client still matches a desired service config.
   */
  public matchesConfig(service: ServiceConfig): boolean {
    return JSON.stringify(this.service) === JSON.stringify(service);
  }

  /**
   * Ensures that the downstream process is started and initialized.
   */
  public async ensureConnected(): Promise<void> {
    if (this.unavailableReason) {
      throw new Error(this.unavailableReason);
    }

    if (this.initialized) {
      return;
    }

    const framingCandidates = this.service.transport.framing
      ? [this.service.transport.framing]
      : ["line", "content-length"] as const;

    let lastError: Error | null = null;
    for (const framing of framingCandidates) {
      try {
        await this.startProcess(framing);
        await this.initialize();
        return;
      } catch (error) {
        lastError = normalizeError(error);
        await this.disposeProcess();

        if (this.service.transport.framing) {
          break;
        }

        this.logger.warn("downstream.framing_probe_failed", {
          serviceId: this.key,
          framing,
          message: lastError.message
        });
      }
    }

    throw lastError ?? new Error(`Failed to initialize downstream service '${this.key}'.`);
  }

  /**
   * Stops the downstream process and clears runtime error state.
   */
  public async dispose(): Promise<void> {
    this.restartAttempts = 0;
    this.unavailableReason = null;
    await this.disposeProcess();
  }

  /**
   * Refreshes downstream metadata by calling tools/list after a valid initialization handshake.
   */
  public async getMetadata(): Promise<ServiceMetadata> {
    return this.executeWithRecovery(async () => {
      await this.ensureConnected();
      const tools = await this.requestToolsList();

      return {
        protocolVersion: this.protocolVersion,
        serverInfo: this.serverInfo,
        tools,
        refreshedAt: new Date().toISOString()
      };
    });
  }

  /**
   * Lists tools exposed by the downstream service.
   */
  public async listTools(): Promise<ToolDefinition[]> {
    return this.executeWithRecovery(async () => {
      await this.ensureConnected();
      return this.requestToolsList();
    });
  }

  /**
   * Calls one downstream tool with the provided arguments.
   */
  public async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.executeWithRecovery(async () => {
      await this.ensureConnected();
      return this.request("tools/call", {
        name,
        arguments: args
      });
    });
  }

  /**
   * Lists tools without applying an extra recovery loop.
   */
  private async requestToolsList(): Promise<ToolDefinition[]> {
    const result = await this.request("tools/list", {});
    if (!isRecord(result) || !Array.isArray(result.tools)) {
      throw new Error(`Downstream service '${this.key}' returned an invalid tools/list payload.`);
    }

    return result.tools.map((tool) => normalizeToolDefinition(this.key, tool));
  }

  /**
   * Runs one downstream operation with bounded restart recovery for transport failures.
   */
  private async executeWithRecovery<T>(operation: () => Promise<T>): Promise<T> {
    while (true) {
      if (this.unavailableReason) {
        throw new Error(this.unavailableReason);
      }

      try {
        const result = await operation();
        return result;
      } catch (error) {
        const normalizedError = normalizeError(error);
        if (normalizedError instanceof DownstreamRpcError) {
          throw normalizedError;
        }

        const canRetry = await this.tryRestart(normalizedError);
        if (!canRetry) {
          throw new Error(this.unavailableReason ?? normalizedError.message);
        }
      }
    }
  }

  /**
   * Attempts to restart the downstream service after a transport-level failure.
   */
  private async tryRestart(error: Error): Promise<boolean> {
    await this.disposeProcess();

    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      this.unavailableReason = `Service '${this.key}' is unavailable after ${MAX_RESTART_ATTEMPTS} restart attempts. Last error: ${error.message}`;
      this.logger.error("downstream.unavailable", {
        serviceId: this.key,
        attempts: this.restartAttempts,
        message: error.message
      });
      return false;
    }

    this.restartAttempts += 1;
    this.logger.warn("downstream.restart_attempt", {
      serviceId: this.key,
      attempt: this.restartAttempts,
      message: error.message
    });
    return true;
  }

  /**
   * Starts the configured child process and wires protocol handlers.
   */
  private async startProcess(framingMode: "line" | "content-length"): Promise<void> {
    if (this.child) {
      return;
    }

    if (this.service.transport.type !== "stdio") {
      throw new Error(`Unsupported transport '${String((this.service.transport as { type?: unknown }).type)}'.`);
    }

    const transport = this.service.transport;
    const cwd = transport.cwd ? resolve(transport.cwd) : process.cwd();
    const commandSpec = resolveCommandSpec(transport.command, transport.args ?? []);
    const child = spawn(commandSpec.command, commandSpec.args, {
      cwd,
      env: {
        ...process.env,
        ...transport.env
      },
      stdio: "pipe",
      windowsHide: true
    });

    this.child = child;
    this.writer = createMessageWriter(child.stdin, framingMode);

    const reader = createMessageReader(child.stdout, transport.framing ?? "auto");
    reader.on("message", (message: JsonRpcMessage) => this.handleMessage(message));
    reader.on("error", (error) => this.failAllPending(new Error(`Protocol error from ${this.key}: ${String(error)}`)));

    child.on("error", (error) => {
      this.initialized = false;
      this.child = null;
      this.writer = null;
      this.failAllPending(error);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.logger.warn("downstream.stderr", {
        serviceId: this.key,
        message: text.trim()
      });
    });

    child.on("close", (code, signal) => {
      this.initialized = false;
      this.child = null;
      this.writer = null;
      this.failAllPending(new Error(`Downstream service '${this.key}' exited with code=${String(code)} signal=${String(signal)}.`));
    });
  }

  /**
   * Stops the current downstream process without resetting terminal unavailability state.
   */
  private async disposeProcess(): Promise<void> {
    for (const pending of this.pending.values()) {
      pending.reject(new Error("The downstream client was disposed."));
    }
    this.pending.clear();
    this.initialized = false;

    if (!this.child) {
      return;
    }

    const child = this.child;
    this.child = null;
    this.writer = null;

    terminateChildProcess(child);
    await waitForChildExit(child);
    cleanupChildProcess(child);
  }

  /**
   * Performs the MCP initialization handshake once per process lifecycle.
   */
  private async initialize(): Promise<void> {
    const result = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {
        tools: {}
      },
      clientInfo: {
        name: "mcp-gateway",
        version: "0.3.0"
      }
    });

    if (isRecord(result)) {
      this.protocolVersion = typeof result.protocolVersion === "string" ? result.protocolVersion : null;
      this.serverInfo = isRecord(result.serverInfo) ? result.serverInfo : null;
    } else {
      this.protocolVersion = null;
      this.serverInfo = null;
    }

    this.initialized = true;
    this.notify("notifications/initialized", {});
  }

  /**
   * Sends one JSON-RPC request and waits for the correlated response.
   */
  private async request(method: string, params: unknown): Promise<unknown> {
    if (!this.writer) {
      throw new Error(`Downstream service '${this.key}' is not connected.`);
    }

    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    const responsePromise = new Promise<unknown>((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectResponse(new Error(`Downstream request '${method}' timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms for '${this.key}'.`));
      }, DEFAULT_REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolveResponse(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectResponse(error);
        }
      });
    });

    this.writer.write(request);
    return responsePromise;
  }

  /**
   * Sends one fire-and-forget JSON-RPC notification.
   */
  private notify(method: string, params: unknown): void {
    this.writer?.write({
      jsonrpc: "2.0",
      method,
      params
    });
  }

  /**
   * Routes one inbound response to the matching pending request.
   */
  private handleMessage(message: JsonRpcMessage): void {
    if (!("id" in message) || message.id === null) {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    this.pending.delete(message.id);

    if ("error" in message) {
      const failure = message as JsonRpcFailure;
      pending.reject(new DownstreamRpcError(failure.error.message));
      return;
    }

    const success = message as JsonRpcSuccess;
    pending.resolve(success.result);
  }

  /**
   * Rejects all pending requests after a transport-level failure.
   */
  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * Describes one pending downstream request.
 */
interface PendingRequest {
  /**
   * Resolves the request with a successful result payload.
   */
  resolve: (result: unknown) => void;
  /**
   * Rejects the request with a terminal error.
   */
  reject: (error: Error) => void;
}

/**
 * Marks a downstream JSON-RPC error response so it is not treated as a transport failure.
 */
class DownstreamRpcError extends Error {}

/**
 * Normalizes one raw downstream tool definition.
 */
function normalizeToolDefinition(clientKey: string, input: unknown): ToolDefinition {
  if (!isRecord(input)) {
    throw new Error(`Downstream tool definition from '${clientKey}' must be an object.`);
  }

  if (typeof input.name !== "string" || input.name.trim() === "") {
    throw new Error(`Downstream tool definition from '${clientKey}' is missing a valid name.`);
  }

  return {
    name: input.name,
    description: typeof input.description === "string" ? input.description : undefined,
    inputSchema: isRecord(input.inputSchema) ? input.inputSchema : undefined,
    outputSchema: isRecord(input.outputSchema) ? input.outputSchema : null
  };
}

/**
 * Normalizes unknown thrown values into Error instances.
 */
function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

/**
 * Resolves a configured command into a directly spawnable executable on Windows.
 */
function resolveCommandSpec(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32") {
    return { command, args };
  }

  if (/[\\/]/.test(command) || /\.[A-Za-z0-9]+$/.test(command)) {
    return { command, args };
  }

  const powershellResolved = resolveViaPowerShell(command);
  if (powershellResolved) {
    if (powershellResolved.toLowerCase().endsWith(".ps1")) {
      const powerShellHost = resolvePowerShellHost();
      if (!powerShellHost) {
        return { command, args };
      }

      return {
        command: powerShellHost,
        args: ["-File", powershellResolved, ...args]
      };
    }

    return {
      command: powershellResolved,
      args
    };
  }

  try {
    const output = execFileSync("where.exe", [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const candidates = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const preferred = candidates.find((candidate) => !candidate.toLowerCase().endsWith(".ps1")) ?? candidates[0];
    if (!preferred) {
      return { command, args };
    }

    if (preferred.toLowerCase().endsWith(".ps1")) {
      const powerShellHost = resolvePowerShellHost();
      if (!powerShellHost) {
        return { command, args };
      }

      return {
        command: powerShellHost,
        args: ["-File", preferred, ...args]
      };
    }

    return {
      command: preferred,
      args
    };
  } catch {
    return { command, args };
  }
}

/**
 * Resolves a command name through PowerShell so script shims map to their real targets.
 */
function resolveViaPowerShell(command: string): string | null {
  const powerShellHost = resolvePowerShellHost();
  if (!powerShellHost) {
    return null;
  }

  try {
    const output = execFileSync(powerShellHost, [
      "-NoProfile",
      "-Command",
      `(Get-Command '${escapePowerShellSingleQuotedString(command)}' -ErrorAction Stop).Source`
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });

    const resolved = output.trim();
    return resolved.length > 0 ? resolved : null;
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
 * Escapes a string for use inside a single-quoted PowerShell literal.
 */
function escapePowerShellSingleQuotedString(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Checks whether a command exists in the current PATH.
 */
function commandExists(command: string): boolean {
  try {
    execFileSync("where.exe", [command], {
      stdio: ["ignore", "ignore", "ignore"]
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Terminates one child process, using process-tree shutdown on Windows when possible.
 */
function terminateChildProcess(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: ["ignore", "ignore", "ignore"]
      });
      return;
    } catch {
      /**
       * Falls back to normal child termination when taskkill fails.
       */
    }
  }

  try {
    child.kill();
  } catch {
    /**
     * Ignores kill failures because the process may have already exited.
     */
  }
}

/**
 * Waits for one child process to exit and force-kills it if graceful shutdown stalls.
 */
async function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolveClose) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", onClose);
      resolveClose();
    };
    const onClose = () => finish();
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /**
         * Ignores force-kill failures because the process may already be exiting.
         */
      }
      finish();
    }, PROCESS_EXIT_TIMEOUT_MS);

    child.once("close", onClose);
  });
}

/**
 * Releases child process stdio resources after the process exits.
 */
function cleanupChildProcess(child: ChildProcessWithoutNullStreams): void {
  child.removeAllListeners();
  child.stdin.removeAllListeners();
  child.stdout.removeAllListeners();
  child.stderr.removeAllListeners();

  if (!child.stdin.destroyed) {
    child.stdin.destroy();
  }
  if (!child.stdout.destroyed) {
    child.stdout.destroy();
  }
  if (!child.stderr.destroyed) {
    child.stderr.destroy();
  }
}

/**
 * Checks whether a value is a plain object record.
 */
function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
