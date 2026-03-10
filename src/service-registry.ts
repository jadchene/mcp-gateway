import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ConfigLoader } from "./config.ts";
import { Logger } from "./logger.ts";
import { StdioMcpClient } from "./mcp/client.ts";
import type { GatewayConfig, ServiceConfig, ServiceMetadata, ServiceRuntimeSnapshot, ToolDefinition } from "./types.ts";

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
  private currentConfig: GatewayConfig = { services: [] };

  /**
   * Stores the current immutable runtime view used by request handlers.
   */
  private snapshots = new Map<string, ServiceRuntimeSnapshot>();

  /**
   * Stores reusable downstream clients keyed by service identifier.
   */
  private clients = new Map<string, StdioMcpClient>();

  /**
   * Prevents overlapping config reload operations.
   */
  private reloadPromise: Promise<void> = Promise.resolve();

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
    await this.reload();
  }

  /**
   * Reloads the config file and atomically swaps the runtime snapshot on success.
   */
  public async reload(): Promise<void> {
    this.reloadPromise = this.reloadPromise.catch(() => undefined).then(async () => {
      const absolutePath = resolve(this.configPath);
      this.logger.info("config.reload.started", { configPath: absolutePath });

      const nextConfig = await this.configLoader.load(absolutePath);
      const nextSnapshots = new Map<string, ServiceRuntimeSnapshot>();
      const nextClients = new Map<string, StdioMcpClient>();

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
        await disposeClientMap(nextClients);
        throw error;
      }

      await disposeRemovedClients(this.clients, nextClients);
      this.currentConfig = nextConfig;
      this.snapshots = nextSnapshots;
      this.clients = nextClients;

      this.logger.info("config.reload.succeeded", {
        configPath: absolutePath,
        serviceCount: nextConfig.services.length
      });
    });

    try {
      await this.reloadPromise;
    } catch {
      /**
       * Keeps the last valid snapshot active while surfacing the error through logs.
       */
    }
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
   * Lists tools for one logical service.
   */
  public listTools(serviceId: string): ToolDefinition[] {
    return this.requireService(serviceId).metadata.tools;
  }

  /**
   * Returns one tool definition for a service.
   */
  public getTool(serviceId: string, toolName: string): ToolDefinition | null {
    return this.requireService(serviceId).metadata.tools.find((tool) => tool.name === toolName) ?? null;
  }

  /**
   * Calls one downstream tool using the only configured service process.
   */
  public async callTool(serviceId: string, toolName: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const snapshot = this.requireService(serviceId);
    const client = this.clients.get(serviceId);
    if (!client) {
      throw new Error(`Service '${serviceId}' is unavailable.`);
    }

    const startedAt = Date.now();
    try {
      const result = await client.callTool(toolName, args);
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
   * Manages one service runtime or persisted enable flag through a compact action interface.
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
    const currentClient = this.clients.get(serviceId);
    if (!currentClient) {
      throw new Error(`Service '${serviceId}' is unavailable.`);
    }

    const nextClient = new StdioMcpClient(snapshot.config, this.logger);

    try {
      await currentClient.dispose().catch(() => undefined);
      const metadata = await nextClient.getMetadata();

      snapshot.metadata = metadata;
      snapshot.runtime = {
        available: true,
        lastError: null,
        lastConnectedAt: new Date().toISOString(),
        restartAttempts: nextClient.restartCount
      };
      this.clients.set(serviceId, nextClient);

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
        available: false,
        lastError: message,
        lastConnectedAt: snapshot.runtime.lastConnectedAt,
        restartAttempts: currentClient.restartCount
      };
      this.clients.set(serviceId, currentClient);

      return {
        serviceId,
        action: "reconnect",
        enabled: true,
        available: false
      };
    }
  }

  /**
   * Persists the service enable flag to the config file and reloads the registry.
   */
  private async setServiceEnabled(serviceId: string, enabled: boolean): Promise<ManageServiceResult> {
    const rawConfig = await readRawConfig(this.configPath);
    if (!Array.isArray(rawConfig.services)) {
      throw new Error("The 'services' field must be an array.");
    }

    const service = rawConfig.services.find((candidate) => isRecord(candidate) && candidate.serviceId === serviceId);
    if (!service || !isRecord(service)) {
      throw new Error(`Unknown service '${serviceId}'.`);
    }

    service.enable = enabled;
    await writeFile(resolve(this.configPath), `${JSON.stringify(rawConfig, null, 2)}\n`, "utf8");
    await this.reload();

    return {
      serviceId,
      action: enabled ? "enable" : "disable",
      enabled,
      available: enabled ? (this.getService(serviceId)?.runtime.available ?? false) : false
    };
  }

  /**
   * Builds one runtime snapshot and initializes required metadata.
   */
  private async buildServiceSnapshot(service: ServiceConfig, nextClients: Map<string, StdioMcpClient>): Promise<ServiceRuntimeSnapshot> {
    const reusedClient = this.clients.get(service.serviceId);
    const client = reusedClient && reusedClient.matchesConfig(service)
      ? reusedClient
      : new StdioMcpClient(service, this.logger);
    nextClients.set(service.serviceId, client);

    let metadata: ServiceMetadata = {
      protocolVersion: null,
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
  result: unknown;
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
async function disposeClientMap(clientMap: Map<string, StdioMcpClient>): Promise<void> {
  await Promise.all([...clientMap.values()].map((client) => client.dispose().catch(() => undefined)));
}

/**
 * Disposes clients that no longer exist after a config swap.
 */
async function disposeRemovedClients(previous: Map<string, StdioMcpClient>, next: Map<string, StdioMcpClient>): Promise<void> {
  const removed: StdioMcpClient[] = [];
  for (const [key, client] of previous.entries()) {
    const nextClient = next.get(key);
    if (!nextClient || nextClient !== client) {
      removed.push(client);
    }
  }
  await Promise.all(removed.map((client) => client.dispose().catch(() => undefined)));
}

/**
 * Loads the raw config document for management edits that must preserve disabled services.
 */
async function readRawConfig(configPath: string): Promise<Record<string, unknown>> {
  const rawText = await readFile(resolve(configPath), "utf8");
  const parsed = JSON.parse(rawText) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("The gateway config must be a JSON object.");
  }
  return parsed;
}

/**
 * Checks whether a value is a plain record.
 */
function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
