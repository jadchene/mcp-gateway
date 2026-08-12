import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ConfigLoader } from "./config.ts";
import { Logger } from "./logger.ts";
import { StdioMcpClient } from "./mcp/client.ts";
import type { McpClient } from "./mcp/client-types.ts";
import type { DownstreamCallContext, DownstreamToolResult } from "./mcp/client-types.ts";
import { StreamableHttpClient } from "./mcp/http-client.ts";
import { matchesAnyToolNamePattern } from "./tool-name-pattern.ts";
import type { ServiceConfig, ServiceMetadata, ServiceRuntimeSnapshot, ToolDefinition } from "./types.ts";

/**
 * Maintains the active service pool, client instances, and cached metadata.
 */
export class ServiceRegistry {
  /**
   * Stores the config file path currently managed by the registry.
   */
  private readonly configPath: string;

  /**
   * Stores the loader used to parse and validate config files.
   */
  private readonly configLoader: ConfigLoader;

  /**
   * Stores the shared logger instance.
   */
  private readonly logger: Logger;

  /**
   * Stores the last valid config snapshot.
   */
  /**
   * Stores the current immutable runtime view used by request handlers.
   */
  private snapshots = new Map<string, ServiceRuntimeSnapshot>();

  /**
   * Stores reusable downstream clients keyed by service identifier.
   */
  private clients = new Map<string, McpClient>();

  /**
   * Prevents overlapping config reload operations.
   */
  private reloadPromise: Promise<void> = Promise.resolve();

  private managementPromise: Promise<void> = Promise.resolve();

  /**
   * Creates a registry bound to one config file path.
   */
  public constructor(
    configPath: string,
    configLoader: ConfigLoader,
    logger: Logger
  ) {
    this.configPath = configPath;
    this.configLoader = configLoader;
    this.logger = logger;
  }

  /**
   * Loads the initial config snapshot.
   */
  public async initialize(): Promise<void> {
    await this.reloadStrict();
  }

  /**
   * Reloads the config file and atomically swaps the runtime snapshot on success.
   */
  public async reload(): Promise<void> {
    try {
      await this.reloadStrict();
    } catch (error) {
      this.logger.error("config.reload.failed", {
        configPath: resolve(this.configPath),
        message: error instanceof Error ? error.message : String(error)
      });
      await this.logger.flush();
    }
  }

  /**
   * Serializes reloads and lets startup and management callers observe failures.
   */
  private async reloadStrict(): Promise<void> {
    this.reloadPromise = this.reloadPromise.catch(() => undefined).then(async () => {
      const absolutePath = resolve(this.configPath);
      this.logger.info("config.reload.started", { configPath: absolutePath });

      const nextConfig = await this.configLoader.load(absolutePath);
      this.logger.configure(nextConfig.logging);
      const nextSnapshots = new Map<string, ServiceRuntimeSnapshot>();
      const nextClients = new Map<string, McpClient>();

      try {
        for (const service of nextConfig.services) {
          const snapshot = await this.buildServiceSnapshot(service, nextClients);
          nextSnapshots.set(service.serviceId, snapshot);
        }
      } catch (error) {
        this.logger.error("config.reload.failed", {
          configPath: absolutePath,
          message: error instanceof Error ? error.message : String(error)
        });
        await disposeNewClients(this.clients, nextClients);
        throw error;
      }

      const previousClients = this.clients;
      this.snapshots = nextSnapshots;
      this.clients = nextClients;
      await disposeRemovedClients(previousClients, nextClients);

      this.logger.info("config.reload.succeeded", {
        configPath: absolutePath,
        serviceCount: nextConfig.services.length
      });
      await this.logger.flush();
    });

    await this.reloadPromise;
  }

  /**
   * Returns a sorted list of runtime service snapshots.
   */
  public listServices(): ServiceRuntimeSnapshot[] {
    return [...this.snapshots.values()].sort((left, right) => left.config.serviceId.localeCompare(right.config.serviceId));
  }

  /**
   * Returns one runtime snapshot by service identifier.
   */
  public getService(serviceId: string): ServiceRuntimeSnapshot | null {
    return this.snapshots.get(serviceId) ?? null;
  }

  /**
   * Lists tools for one logical service, optionally matching name or description keywords.
   */
  public listTools(serviceId: string, toolName?: string[], desc?: string[]): ToolDefinition[] {
    const snapshot = this.requireService(serviceId);
    const tools = snapshot.metadata.tools.filter(
      (tool) => !matchesAnyToolNamePattern(tool.name, snapshot.config.disabledTools)
    );
    const nameKeywords = normalizeKeywords(toolName);
    const descriptionKeywords = normalizeKeywords(desc);
    if (nameKeywords.length === 0 && descriptionKeywords.length === 0) {
      return tools;
    }

    return tools.filter((tool) => {
      const normalizedName = tool.name.toLowerCase();
      const normalizedDescription = tool.description?.toLowerCase() ?? "";
      return nameKeywords.some((keyword) => normalizedName.includes(keyword))
        || descriptionKeywords.some((keyword) => normalizedDescription.includes(keyword));
    });
  }

  /**
   * Returns one tool definition for a service.
   */
  public getTool(serviceId: string, toolName: string): ToolDefinition | null {
    const snapshot = this.requireService(serviceId);
    if (matchesAnyToolNamePattern(toolName, snapshot.config.disabledTools)) {
      return null;
    }
    return snapshot.metadata.tools.find((tool) => tool.name === toolName) ?? null;
  }

  /**
   * Calls one downstream tool using the only configured service process.
   */
  public async callTool(
    serviceId: string,
    toolName: string,
    args: Record<string, unknown>,
    context: DownstreamCallContext = {}
  ): Promise<CallToolResult> {
    const snapshot = this.requireService(serviceId);
    if (matchesAnyToolNamePattern(toolName, snapshot.config.disabledTools)) {
      throw new Error(`Tool '${toolName}' in service '${serviceId}' is disabled by gateway configuration.`);
    }
    const client = this.clients.get(serviceId);
    if (!client) {
      throw new Error(`Service '${serviceId}' is unavailable.`);
    }

    const startedAt = Date.now();
    try {
      const result = await client.callTool(toolName, args, context);
      this.markServiceAvailable(serviceId, client.restartCount);
      return {
        result,
        durationMs: Date.now() - startedAt,
        restartAttempts: client.restartCount
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.markServiceUnavailable(serviceId, message, client.restartCount);

      if (client.isUnavailable) {
        throw new Error(`Service '${serviceId}' is unavailable. ${client.unavailableMessage ?? message}`);
      }

      throw error;
    }
  }

  /**
   * Reconnects one service or persists its enabled state through the config file.
   */
  public async manageService(
    serviceId: string,
    action: "reconnect" | "enable" | "disable"
  ): Promise<ManageServiceResult> {
    switch (action) {
      case "reconnect":
        return this.reconnectService(serviceId);
      case "enable":
        return this.setServiceEnabled(serviceId, true);
      case "disable":
        return this.setServiceEnabled(serviceId, false);
      default:
        throw new Error(`Unsupported service action '${action satisfies never}'.`);
    }
  }

  /**
   * Disposes all downstream clients during shutdown.
   */
  public async dispose(): Promise<void> {
    await disposeClientMap(this.clients);
    this.clients.clear();
  }

  /**
   * Reconnects one currently configured service and refreshes its metadata snapshot.
   */
  private async reconnectService(serviceId: string): Promise<ManageServiceResult> {
    const snapshot = this.requireService(serviceId);
    const previousRuntime = snapshot.runtime;
    const currentClient = this.clients.get(serviceId);
    if (!currentClient) {
      throw new Error(`Service '${serviceId}' is unavailable.`);
    }

    const nextClient = createClient(snapshot.config, this.logger);

    try {
      const metadata = await nextClient.getMetadata();

      snapshot.metadata = metadata;
      snapshot.runtime = {
        available: true,
        lastError: null,
        lastConnectedAt: new Date().toISOString(),
        restartAttempts: nextClient.restartCount
      };
      this.clients.set(serviceId, nextClient);
      await currentClient.dispose().catch(() => undefined);

      return {
        serviceId,
        action: "reconnect",
        enabled: true,
        available: true
      };
    } catch (error) {
      await nextClient.dispose().catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);

      snapshot.runtime = {
        available: previousRuntime.available,
        lastError: `Reconnect failed; existing connection retained: ${message}`,
        lastConnectedAt: previousRuntime.lastConnectedAt,
        restartAttempts: currentClient.restartCount
      };

      return {
        serviceId,
        action: "reconnect",
        enabled: true,
        available: previousRuntime.available
      };
    }
  }

  /**
   * Persists the service enable flag to the config file and reloads the registry.
   */
  private async setServiceEnabled(serviceId: string, enabled: boolean): Promise<ManageServiceResult> {
    let result!: ManageServiceResult;
    const operation = this.managementPromise.catch(() => undefined).then(async () => {
      const { config: rawConfig, rawText: original } = await readRawConfig(this.configPath);
      if (!Array.isArray(rawConfig.services)) {
        throw new Error("The 'services' field must be an array.");
      }

      const service = rawConfig.services.find((candidate) => isRecord(candidate) && candidate.serviceId === serviceId);
      if (!service || !isRecord(service)) {
        throw new Error(`Unknown service '${serviceId}'.`);
      }

      service.enable = enabled;
      const absolutePath = resolve(this.configPath);
      await writeFileAtomically(absolutePath, `${JSON.stringify(rawConfig, null, 2)}\n`);
      try {
        await this.reloadStrict();
      } catch (error) {
        await writeFileAtomically(absolutePath, original);
        throw error;
      }

      result = {
        serviceId,
        action: enabled ? "enable" : "disable",
        enabled,
        available: enabled ? (this.getService(serviceId)?.runtime.available ?? false) : false
      };
    });
    this.managementPromise = operation;
    await operation;
    return result;
  }

  /**
   * Builds one runtime snapshot and initializes required metadata.
   */
  private async buildServiceSnapshot(service: ServiceConfig, nextClients: Map<string, McpClient>): Promise<ServiceRuntimeSnapshot> {
    const reusedClient = this.clients.get(service.serviceId);
    const client = reusedClient && reusedClient.matchesConfig(service)
      ? reusedClient
      : createClient(service, this.logger);
    nextClients.set(service.serviceId, client);

    let metadata: ServiceMetadata = {
      protocolVersion: null,
      protocolEra: null,
      serverInfo: null,
      tools: [],
      refreshedAt: null
    };

    let available = false;
    let lastError: string | null = null;
    let lastConnectedAt: string | null = null;

    try {
      metadata = await client.getMetadata();
      available = true;
      lastConnectedAt = new Date().toISOString();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn("service.metadata.refresh_failed", {
        serviceId: service.serviceId,
        message: lastError
      });
    }

    return {
      config: service,
      metadata,
      runtime: {
        available,
        lastError,
        lastConnectedAt,
        restartAttempts: client.restartCount
      }
    };
  }

  /**
   * Returns one existing service snapshot or throws a descriptive error.
   */
  private requireService(serviceId: string): ServiceRuntimeSnapshot {
    const snapshot = this.snapshots.get(serviceId);
    if (!snapshot) {
      throw new Error(`Unknown service '${serviceId}'.`);
    }
    return snapshot;
  }

  /**
   * Marks one service as available after a successful request.
   */
  private markServiceAvailable(serviceId: string, restartAttempts: number): void {
    const snapshot = this.snapshots.get(serviceId);
    if (!snapshot) {
      return;
    }

    snapshot.runtime = {
      available: true,
      lastError: null,
      lastConnectedAt: new Date().toISOString(),
      restartAttempts
    };
  }

  /**
   * Marks one service as unavailable after a failed request.
   */
  private markServiceUnavailable(serviceId: string, message: string, restartAttempts: number): void {
    const snapshot = this.snapshots.get(serviceId);
    if (!snapshot) {
      return;
    }

    snapshot.runtime = {
      available: false,
      lastError: message,
      lastConnectedAt: snapshot.runtime.lastConnectedAt,
      restartAttempts
    };
  }
}

/**
 * Describes the enriched result returned from a routed tool invocation.
 */
export interface CallToolResult {
  /**
   * Provides the downstream result payload.
   */
  result: DownstreamToolResult;
  /**
   * Provides the observed request latency in milliseconds.
   */
  durationMs: number;
  /**
   * Provides the restart attempts consumed by the service lifecycle.
   */
  restartAttempts: number;
}

/**
 * Describes the compact result returned from a service management action.
 */
export interface ManageServiceResult {
  /**
   * Identifies the logical service targeted by the action.
   */
  serviceId: string;
  /**
   * Echoes the applied management action.
   */
  action: "reconnect" | "enable" | "disable";
  /**
   * Indicates whether the service is enabled in the persisted config after the action.
   */
  enabled: boolean;
  /**
   * Indicates whether the service is currently available after the action.
   */
  available: boolean;
}

/**
 * Disposes all clients in one map.
 */
async function disposeClientMap(clientMap: Map<string, McpClient>): Promise<void> {
  await Promise.all([...clientMap.values()].map((client) => client.dispose().catch(() => undefined)));
}

/**
 * Disposes clients that no longer exist after a config swap.
 */
async function disposeRemovedClients(previous: Map<string, McpClient>, next: Map<string, McpClient>): Promise<void> {
  const removed: McpClient[] = [];
  for (const [key, client] of previous.entries()) {
    const nextClient = next.get(key);
    if (!nextClient || nextClient !== client) {
      removed.push(client);
    }
  }
  await Promise.all(removed.map((client) => client.dispose().catch(() => undefined)));
}

/** Disposes only clients created by a failed reload, preserving reused active clients. */
async function disposeNewClients(previous: Map<string, McpClient>, next: Map<string, McpClient>): Promise<void> {
  const created = [...next.entries()]
    .filter(([key, client]) => previous.get(key) !== client)
    .map(([, client]) => client);
  await Promise.all(created.map((client) => client.dispose().catch(() => undefined)));
}

/**
 * Creates a downstream client implementation for one service config.
 */
function createClient(service: ServiceConfig, logger: Logger): McpClient {
  switch (service.transport.type) {
    case "stdio":
      return new StdioMcpClient(service, logger);
    case "http":
      return new StreamableHttpClient(service, logger);
    default:
      throw new Error(`Unsupported transport '${String((service.transport as { type?: unknown }).type)}'.`);
  }
}

/**
 * Normalizes optional keywords for case-insensitive filtering.
 */
function normalizeKeywords(input: string[] | undefined): string[] {
  if (!input) {
    return [];
  }

  return input
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== "");
}

/**
 * Loads the raw config document for management edits that must preserve disabled services.
 */
async function readRawConfig(configPath: string): Promise<{
  config: Record<string, unknown>;
  rawText: string;
}> {
  const rawText = await readFile(resolve(configPath), "utf8");
  const parsed = JSON.parse(rawText) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("The gateway config must be a JSON object.");
  }
  return { config: parsed, rawText };
}

/**
 * Replaces a config file through a flushed same-directory temporary file.
 */
async function writeFileAtomically(path: string, content: string): Promise<void> {
  const tempPath = resolve(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
    const handle = await open(tempPath, "r");
    try {
      if (process.platform !== "win32") {
        await handle.sync();
      }
    } finally {
      await handle.close();
    }
    await rename(tempPath, path);
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), "r").catch(() => null);
      if (directory) {
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    }
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Checks whether a value is a plain record.
 */
function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
