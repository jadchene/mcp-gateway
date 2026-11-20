import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ConfigLoader } from "./config.ts";
import { Logger } from "./logger.ts";
import { StdioMcpClient } from "./mcp/client.ts";
import type { McpClient } from "./mcp/client-types.ts";
import type { DownstreamCallContext, DownstreamToolResult } from "./mcp/client-types.ts";
import { StreamableHttpClient } from "./mcp/http-client.ts";
import { matchesAnyToolNamePattern } from "./tool-name-pattern.ts";
import { createTransparentTool, type TransparentTool } from "./transparent-tools.ts";
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
  /**
   * Stores the current immutable runtime view used by request handlers.
   */
  private snapshots = new Map<string, ServiceRuntimeSnapshot>();

  /**
   * Stores reusable downstream clients keyed by service identifier.
   */
  private clients = new Map<string, McpClient>();

  /** null 表示路由模式；空目录表示透明模式下没有已发布工具。 */
  private transparentCatalog: Map<string, TransparentTool> | null = null;
  /** 只向订阅客户端发送一次完整目录的变更通知。 */
  public readonly catalogEvents = new EventTarget();

  /** 返回当前已发布的只读路由表。 */
  public get toolCatalog(): ReadonlyMap<string, TransparentTool> | null {
    return this.transparentCatalog;
  }

  /** 在切换快照前完成公开名校验，避免暴露半份目录。 */
  private buildToolCatalog(snapshots = this.snapshots, enabled = this.transparentCatalog !== null) {
    if (!enabled) return null;
    const next = new Map<string, TransparentTool>();
    for (const snapshot of snapshots.values()) {
      const { config } = snapshot;
      if (this.stopped.has(config.serviceId)) continue;
      for (const tool of visibleTools(snapshot)) {
        const entry = createTransparentTool(config, tool);
        const name = entry.definition.name;
        if (next.has(name)) throw new Error(`Duplicate transparent tool name '${name}'.`);
        next.set(name, entry);
      }
    }
    return next;
  }

  /** 同步发布工具声明和调用路由，跳过无变化的重载。 */
  private publishToolCatalog(next = this.buildToolCatalog()): void {
    for (const client of this.refreshRetries.keys()) {
      if (!next || this.clients.get(client.key) !== client || this.stopped.has(client.key)) {
        this.cancelRefreshRetry(client);
      }
    }
    if (isDeepStrictEqual(next, this.transparentCatalog)) return;
    this.transparentCatalog = next;
    this.catalogEvents.dispatchEvent(new Event("change"));
  }

  /**
   * Prevents overlapping config reload operations.
   */
  private reloadPromise: Promise<void> = Promise.resolve();

  private managementPromise: Promise<void> = Promise.resolve();
  /** 用户停止状态跨配置热重载保留，Gateway 重启后重新按配置加载。 */
  private stopped = new Set<string>();
  /** 当前执行中的生命周期动作，用于页面状态和调用拦截。 */
  private transitions = new Map<string, "starting" | "stopping">();
  /** 合并同一客户端尚未执行的目录刷新。 */
  private pendingRefresh = new Set<McpClient>();
  /** 等待重试的刷新独立计时，不占用服务生命周期队列。 */
  private refreshRetries = new Map<McpClient, NodeJS.Timeout>();

  /** 在生命周期队列中刷新仍属于当前快照的下游客户端。 */
  private watchTools(client: McpClient, enabled: boolean): void {
    client.watchTools(enabled ? () => this.queueToolRefresh(client) : undefined);
  }

  /** 新通知立即读取；临时错误按退避间隔补读，读取期间收到的新通知再排一次。 */
  private queueToolRefresh(client: McpClient, retryMs = 0): void {
    this.cancelRefreshRetry(client);
    if (this.pendingRefresh.has(client)) return;
    this.pendingRefresh.add(client);
    this.reloadPromise = this.reloadPromise.catch(() => undefined).then(async () => {
      this.pendingRefresh.delete(client);
      if (!this.transparentCatalog || this.clients.get(client.key) !== client || this.stopped.has(client.key)) return;
      const snapshot = this.requireService(client.key);
      if (!client.isConnected || (!client.cachedMetadata && snapshot.metadata.refreshedAt !== null)) {
        snapshot.metadata = emptyMetadata();
        this.markServiceUnavailable(client.key, client.unavailableMessage ?? "下游连接已关闭", client.restartCount);
        this.publishToolCatalog();
        if (client.isUnavailable) return;
        if (retryMs === 0 && !client.isConnected) {
          this.scheduleToolRefresh(client, 1000);
          return;
        }
      }
      try {
        const metadata = await client.getMetadata();
        if (this.clients.get(client.key) !== client || client.cachedMetadata !== metadata) return;
        snapshot.metadata = metadata;
        this.markServiceAvailable(client.key, client.restartCount);
        this.publishToolCatalog();
      } catch (error) {
        this.logger.warn("downstream.tools_refresh_failed", { serviceId: client.key, message: String(error) });
        if (this.clients.get(client.key) === client) {
          this.scheduleToolRefresh(client, retryMs ? Math.min(retryMs * 2, 30_000) : 1000);
        }
      }
    });
  }

  /** 重载和通知共用重试计时器，后续通知仍可提前触发补读。 */
  private scheduleToolRefresh(client: McpClient, delayMs: number): void {
    if (client.isUnavailable || this.pendingRefresh.has(client) || this.refreshRetries.has(client)) return;
    const timer = setTimeout(() => this.queueToolRefresh(client, delayMs), delayMs);
    this.refreshRetries.set(client, timer.unref());
  }

  /** 释放已由新通知、配置变更或关闭操作取代的定时器。 */
  private cancelRefreshRetry(client: McpClient): void {
    clearTimeout(this.refreshRetries.get(client));
    this.refreshRetries.delete(client);
  }

  /** 返回页面所需的运行信息，不包含启动参数和凭据。 */
  public listServiceStates() {
    return this.listServices().map(snapshot => {
      const id = snapshot.config.serviceId;
      const client = this.clients.get(id);
      return {
        serviceId: id,
        status: this.transitions.get(id) ?? (this.stopped.has(id) ? "stopped"
          : client?.isConnected ? "running" : "failed"),
        lastError: snapshot.runtime.lastError ?? (!client?.isConnected && !this.stopped.has(id) && !this.transitions.has(id) ? "下游连接已关闭" : null),
        lastConnectedAt: snapshot.runtime.lastConnectedAt,
        toolCount: this.listTools(id).length
      };
    });
  }

  /** 串行控制已启用服务，停止操作不修改配置文件。 */
  public controlService(serviceId: string, action: "start" | "stop" | "restart"): Promise<void> {
    const operation = this.reloadPromise.catch(() => undefined).then(async () => {
      const snapshot = this.requireService(serviceId);
      const current = this.clients.get(serviceId);
      if (action === "start" && current?.isConnected && !this.stopped.has(serviceId)) return;
      this.transitions.set(serviceId, action === "stop" ? "stopping" : "starting");
      try {
        this.stopped.add(serviceId);
        await current?.dispose();
        snapshot.runtime.available = false;
        snapshot.runtime.lastError = null;
        if (action === "stop") return;
        this.stopped.delete(serviceId);
        const next = createClient(snapshot.config, this.logger);
        this.watchTools(next, this.transparentCatalog !== null);
        this.clients.set(serviceId, next);
        snapshot.metadata = await next.getMetadata();
        this.markServiceAvailable(serviceId, next.restartCount);
      } catch (error) {
        snapshot.metadata = { ...snapshot.metadata, tools: [] };
        const message = error instanceof Error ? error.message : String(error);
        this.markServiceUnavailable(serviceId, message, this.clients.get(serviceId)?.restartCount ?? 0);
        throw error;
      } finally {
        this.transitions.delete(serviceId);
        this.publishToolCatalog();
      }
    });
    this.reloadPromise = operation.catch(() => undefined);
    return operation;
  }

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
  public async initialize(config?: GatewayConfig): Promise<void> {
    if (config?.transparentTools) this.transparentCatalog = new Map();
    await this.reloadStrict(config);
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
  public async reloadStrict(initialConfig?: GatewayConfig): Promise<void> {
    this.reloadPromise = this.reloadPromise.catch(() => undefined).then(async () => {
      const absolutePath = resolve(this.configPath);
      this.logger.info("config.reload.started", { configPath: absolutePath });

      const nextConfig = initialConfig ?? await this.configLoader.load(absolutePath);
      this.logger.configure(nextConfig.logging);
      const nextSnapshots = new Map<string, ServiceRuntimeSnapshot>();
      const nextClients = new Map<string, McpClient>();
      let catalog: Map<string, TransparentTool> | null;

      try {
        for (const service of nextConfig.services) {
          const snapshot = await this.buildServiceSnapshot(service, nextClients, nextConfig.transparentTools);
          nextSnapshots.set(service.serviceId, snapshot);
        }
        catalog = this.buildToolCatalog(nextSnapshots, nextConfig.transparentTools);
      } catch (error) {
        this.logger.error("config.reload.failed", {
          configPath: absolutePath,
          message: error instanceof Error ? error.message : String(error)
        });
        await disposeNewClients(this.clients, nextClients);
        for (const client of this.clients.values()) this.watchTools(client, this.transparentCatalog !== null);
        throw error;
      }

      const previousClients = this.clients;
      this.snapshots = nextSnapshots;
      this.clients = nextClients;
      this.publishToolCatalog(catalog);
      if (catalog) {
        for (const [id, snapshot] of nextSnapshots) {
          if (snapshot.runtime.lastError !== null) this.scheduleToolRefresh(nextClients.get(id)!, 1000);
        }
      }
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
    const tools = visibleTools(snapshot);
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
    if (this.stopped.has(serviceId) || this.transitions.has(serviceId)) {
      throw new Error(`Service '${serviceId}' is stopped or changing state.`);
    }
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
    const clients = this.clients;
    this.clients = new Map();
    for (const client of this.refreshRetries.keys()) this.cancelRefreshRetry(client);
    await disposeClientMap(clients);
  }

  /**
   * Reconnects one currently configured service and refreshes its metadata snapshot.
   */
  private async reconnectService(serviceId: string): Promise<ManageServiceResult> {
    // 与配置重载共用队列，防止两个替换操作同时启动同一服务。
    const operation = this.reloadPromise.catch(() => undefined)
      .then(() => this.reconnectServiceOnce(serviceId))
      .finally(() => this.publishToolCatalog());
    this.reloadPromise = operation.then(() => undefined, () => undefined);
    return operation;
  }

  /** 在注册表生命周期队列中执行一次重连。 */
  private async reconnectServiceOnce(serviceId: string): Promise<ManageServiceResult> {
    const snapshot = this.requireService(serviceId);
    const previousRuntime = snapshot.runtime;
    const currentClient = this.clients.get(serviceId);
    if (!currentClient) {
      throw new Error(`Service '${serviceId}' is unavailable.`);
    }

    const nextClient = createClient(snapshot.config, this.logger);
    this.watchTools(nextClient, this.transparentCatalog !== null);
    const restartProcess = snapshot.config.transport.type === "stdio";
    // stdio 子进程可能持有 Web 端口等独占资源，必须先关闭旧实例。
    if (restartProcess) await currentClient.dispose();

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
      this.stopped.delete(serviceId);
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
      let restored = false;
      if (restartProcess) {
        try {
          currentClient.activate();
          snapshot.metadata = await currentClient.getMetadata();
          restored = true;
        } catch {
          // 原配置也无法恢复时，保留明确的不可用状态。
        }
      }

      snapshot.runtime = {
        available: restartProcess ? restored : previousRuntime.available,
        lastError: `Reconnect failed; ${restartProcess ? (restored ? "previous configuration restored" : "previous configuration could not be restored") : "existing connection retained"}: ${message}`,
        lastConnectedAt: restored ? new Date().toISOString() : previousRuntime.lastConnectedAt,
        restartAttempts: currentClient.restartCount
      };
      if (restartProcess && !restored) snapshot.metadata = { ...snapshot.metadata, tools: [] };

      return {
        serviceId,
        action: "reconnect",
        enabled: true,
        available: snapshot.runtime.available
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
  private async buildServiceSnapshot(service: ServiceConfig, nextClients: Map<string, McpClient>, transparentTools: boolean): Promise<ServiceRuntimeSnapshot> {
    const reusedClient = this.clients.get(service.serviceId);
    const client = reusedClient && reusedClient.matchesConfig(service)
      ? reusedClient
      : createClient(service, this.logger);
    nextClients.set(service.serviceId, client);
    this.watchTools(client, transparentTools);
    if (reusedClient && reusedClient !== client
      && this.snapshots.get(service.serviceId)?.config.transport.type === "stdio") {
      // 配置切换前释放旧进程的监听端口，避免新旧实例争用同一端口。
      await reusedClient.dispose();
    }

    let metadata = emptyMetadata();

    let available = false;
    let lastError: string | null = null;
    let lastConnectedAt: string | null = null;

    try {
      if (this.stopped.has(service.serviceId)) {
        return { config: service, metadata, runtime: { available: false, lastError: null, lastConnectedAt: null, restartAttempts: 0 } };
      }
      metadata = await client.getMetadata();
      available = true;
      lastConnectedAt = new Date().toISOString();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (transparentTools && client.cachedMetadata) {
        metadata = client.cachedMetadata;
        lastConnectedAt = this.snapshots.get(service.serviceId)?.runtime.lastConnectedAt ?? metadata.refreshedAt;
      }
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
interface ManageServiceResult {
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

/** 表示当前连接尚无有效目录。 */
function emptyMetadata(): ServiceMetadata {
  return { protocolVersion: null, protocolEra: null, serverInfo: null, tools: [], refreshedAt: null };
}

/** 路由模式和透明模式使用相同的禁用规则。 */
function visibleTools(snapshot: ServiceRuntimeSnapshot): ToolDefinition[] {
  return snapshot.metadata.tools.filter(tool => !matchesAnyToolNamePattern(tool.name, snapshot.config.disabledTools));
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
