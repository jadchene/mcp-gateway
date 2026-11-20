import { setTimeout as delay } from "node:timers/promises";
import {
  Client,
  CLIENT_INFO_META_KEY,
  ProtocolError,
  ProtocolErrorCode,
  isInputRequiredResult,
  SdkHttpError,
  type CallToolRequestParams,
  type CallToolResult,
  type ClientOptions,
  type ElicitRequestFormParams,
  type InputRequiredResult,
  type Tool,
  type Transport
} from "@modelcontextprotocol/client";
import { Logger } from "../logger.ts";
import type { ServiceConfig, ServiceMetadata, ToolDefinition } from "../types.ts";
import { VERSION } from "../version.ts";
import type { DownstreamCallContext, McpClient } from "./client-types.ts";
import { FormElicitationBridge } from "./form-elicitation-bridge.ts";
import { downstreamValidator } from "./input-schema.ts";
import { SUPPORTED_MCP_PROTOCOL_VERSIONS } from "./versions.ts";

const MAX_RESTART_ATTEMPTS = 3;
const CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const MAX_DOWNSTREAM_TOOLS = 5_000;
const MAX_TOOL_CATALOG_BYTES = 5 * 1024 * 1024;

/**
 * Creates one fresh SDK transport for a downstream connection attempt.
 */
type SdkTransportFactory = () => Transport;

/**
 * Implements shared MCP SDK v2 client behavior for stdio and HTTP transports.
 */
export class SdkMcpClient implements McpClient {
  /**
   * Identifies this client in logs.
   */
  public readonly key: string;

  private readonly service: ServiceConfig;
  private readonly logger: Logger;
  private readonly transportFactory: SdkTransportFactory;
  private client: Client | null = null;
  private disposed = false;
  private connecting: Promise<void> | null = null;
  private restartAttempts = 0;
  private unavailableReason: string | null = null;
  private tools = new Map<string, Tool>();
  /** 与当前 SDK 连接绑定的最近一次完整目录。 */
  private metadata: ServiceMetadata | null = null;
  /** 透明模式的注册表刷新回调和当前现代协议订阅。 */
  private toolsChanged?: () => void;
  private toolSubscription?: AbortController;
  private readonly formElicitationBridge = new FormElicitationBridge();

  /**
   * Creates a reusable SDK-backed downstream client.
   */
  public constructor(
    service: ServiceConfig,
    logger: Logger,
    transportFactory: SdkTransportFactory
  ) {
    this.service = structuredClone(service);
    this.key = service.serviceId;
    this.logger = logger;
    this.transportFactory = transportFactory;
  }

  /**
   * Indicates whether recovery attempts have been exhausted.
   */
  public get isUnavailable(): boolean {
    return this.unavailableReason !== null;
  }

  /** 显示实际连接状态，连接关闭后立即变为 false。 */
  public get isConnected(): boolean { return this.client !== null; }

  /** 配置热更新时可以沿用同一连接的有效目录。 */
  public get cachedMetadata(): ServiceMetadata | null { return this.metadata; }

  /** 仅由显式启动或恢复操作重新启用连接。 */
  public activate(): void { this.disposed = false; }

  /** 切换工具监听时保留已建立的下游会话。 */
  public watchTools(listener?: () => void): void {
    const changed = Boolean(this.toolsChanged) !== Boolean(listener);
    this.toolsChanged = listener;
    if (changed && this.client) this.configureToolSubscription(this.client);
  }

  /** 旧版协议直接推送通知，现代协议通过 SDK 订阅目录变更。 */
  private configureToolSubscription(client: Client): void {
    this.toolSubscription?.abort();
    this.toolSubscription = undefined;
    if (!this.toolsChanged || !client.getServerCapabilities()?.tools?.listChanged
      || client.getProtocolEra() !== "modern") return;
    const subscription = new AbortController();
    this.toolSubscription = subscription;
    void this.listenForToolChanges(client, subscription.signal);
  }

  /** 订阅结束后退避重连；每次订阅得到确认时补读中断期间的目录。 */
  private async listenForToolChanges(client: Client, signal: AbortSignal): Promise<void> {
    let retryMs = 1000;
    while (!signal.aborted) {
      try {
        const subscription = await client.listen({ toolsListChanged: true }, { signal });
        if (signal.aborted) return;
        this.toolsChanged?.();
        retryMs = 1000;
        await subscription.closed;
      } catch (error) {
        if (!signal.aborted) this.logger.warn("downstream.tools_subscription_failed", {
          serviceId: this.key, message: String(error)
        });
      }
      if (signal.aborted) return;
      await delay(retryMs, undefined, { signal, ref: false }).catch(() => undefined);
      retryMs = Math.min(retryMs * 2, 30_000);
    }
  }

  /**
   * Returns the terminal unavailability reason.
   */
  public get unavailableMessage(): string | null {
    return this.unavailableReason;
  }

  /**
   * Returns restart attempts consumed by this lifecycle.
   */
  public get restartCount(): number {
    return this.restartAttempts;
  }

  /**
   * Checks whether this client can be reused after config reload.
   */
  public matchesConfig(service: ServiceConfig): boolean {
    // 页面地址、名称及工具过滤由注册表处理，不应触发下游进程重启。
    return JSON.stringify(this.service.transport) === JSON.stringify(service.transport)
      && this.service.callTimeoutMs === service.callTimeoutMs;
  }

  /**
   * Establishes an SDK connection with the configured era negotiation policy.
   */
  public async ensureConnected(): Promise<void> {
    if (this.disposed) throw new Error(`Service '${this.key}' is stopped.`);
    if (this.client) {
      return;
    }
    if (this.unavailableReason) {
      throw new Error(this.unavailableReason);
    }
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = this.connectOnce();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  /**
   * Closes the SDK client and clears lifecycle errors.
   */
  public async dispose(): Promise<void> {
    this.disposed = true;
    await this.connecting?.catch(() => undefined);
    this.restartAttempts = 0;
    this.unavailableReason = null;
    await this.disposeConnection();
  }

  /**
   * Refreshes server identity and the complete tool catalog.
   */
  public async getMetadata(): Promise<ServiceMetadata> {
    return this.executeWithRecovery(async (client) => {
      const tools = await this.requestToolsList(client);
      if (this.client !== client) throw new Error("Downstream connection changed while reading its catalog.");
      this.metadata = {
        protocolVersion: client.getNegotiatedProtocolVersion() ?? null,
        protocolEra: client.getProtocolEra() ?? null,
        serverInfo: toJsonObject(client.getServerVersion()),
        tools,
        refreshedAt: new Date().toISOString()
      };
      return this.metadata;
    });
  }

  /**
   * Lists the downstream tools using SDK caching and pagination behavior.
   */
  public async listTools(): Promise<ToolDefinition[]> {
    return this.executeWithRecovery((client) => this.requestToolsList(client));
  }

  /**
   * Calls a downstream tool while preserving cancellation, custom headers, and MRTR state.
   */
  public async callTool(
    name: string,
    args: Record<string, unknown>,
    context: DownstreamCallContext = {}
  ): Promise<CallToolResult | InputRequiredResult> {
    let client: Client | null = null;
    try {
      client = await this.requireClient();
      const callClient = client;
      const params: CallToolRequestParams = {
        name,
        arguments: args,
        // 将原始客户端身份随调用传递，由下游自行选择元数据格式。
        ...(context.clientInfo ? { _meta: { [CLIENT_INFO_META_KEY]: structuredClone(context.clientInfo) } } : {}),
        ...(context.inputResponses ? { inputResponses: context.inputResponses } : {}),
        ...(context.requestState ? { requestState: context.requestState } : {})
      };
      const invoke = async (signal: AbortSignal): Promise<CallToolResult | InputRequiredResult> => {
        const callSignal = combineWithTimeout(signal, this.service.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
        const tool = this.tools.get(name);
        // 手动处理现代协议的确认轮次时，SDK 2.4 会过早校验中间结果。
        const finalOutput = callClient.getProtocolEra() === "modern" ? tool?.outputSchema : undefined;
        const validateOutput = finalOutput ? compileOutputSchema(name, finalOutput) : undefined;
        const result = await callClient.callTool(params, {
          signal: callSignal,
          allowInputRequired: true,
          toolDefinition: finalOutput && tool ? { ...tool, outputSchema: undefined } : tool
        });
        if (validateOutput && !isInputRequiredResult(result) && !result.isError) {
          const checked = validateOutput(result.structuredContent);
          if (result.structuredContent === undefined || !checked.valid) {
            throw new ProtocolError(ProtocolErrorCode.InvalidParams,
              `Invalid structured output for '${name}': ${checked.errorMessage ?? "missing structuredContent"}`);
          }
        }
        return result as CallToolResult | InputRequiredResult;
      };
      if (client.getProtocolEra() === "legacy") {
        return await this.formElicitationBridge.execute(name, args, context, invoke);
      }
      const result = await invoke(context.signal ?? new AbortController().signal);
      return result as CallToolResult | InputRequiredResult;
    } catch (error) {
      const normalized = normalizeError(error);
      if (this.isSessionExpired(normalized, client)) {
        await this.disposeConnection(client);
        throw new Error(
          `Downstream session expired while calling '${name}'; the gateway did not replay it. The next call will reconnect. ${normalized.message}`,
          { cause: normalized }
        );
      }
      if (isNonRetryable(normalized) || context.signal?.aborted) {
        throw normalized;
      }
      await this.disposeConnection(client);
      throw new Error(
        `Downstream tool '${name}' failed; execution status is unknown and the gateway did not replay it. ${normalized.message}`,
        { cause: normalized }
      );
    }
  }

  /** 判断传输层是否明确报告当前会话已失效，默认传输不作此判断。 */
  protected isSessionExpired(_error: Error, _client: Client | null): boolean {
    return false;
  }

  /**
   * Connects one fresh SDK client and transport.
   */
  private async connectOnce(): Promise<void> {
    await this.connectCandidate(this.transportFactory);
  }

  /**
   * Connects one transport candidate with its own protocol negotiation policy.
   */
  private async connectCandidate(transportFactory: SdkTransportFactory): Promise<void> {
    const options: ClientOptions = {
      jsonSchemaValidator: downstreamValidator,
      supportedProtocolVersions: [...SUPPORTED_MCP_PROTOCOL_VERSIONS],
      capabilities: {
        elicitation: {
          form: {}
        }
      },
      versionNegotiation: {
        mode: "auto",
        probe: {
          timeoutMs: 5_000
        }
      },
      inputRequired: {
        autoFulfill: false,
        maxRounds: 8
      }
    };
    const client = new Client({ name: "mcp-gateway", version: VERSION }, options);
    client.setNotificationHandler("notifications/tools/list_changed", () => {
      if (this.client === client) this.toolsChanged?.();
    });
    client.setRequestHandler("elicitation/create", async (request, context) => {
      const params = request.params as ElicitRequestFormParams;
      return this.formElicitationBridge.handle(params, context.mcpReq.signal);
    });
    client.onerror = (error) => {
      this.logger.warn("downstream.sdk_error", {
        serviceId: this.key,
        message: error.message
      });
    };
    client.onclose = () => this.clearConnection(client);

    const transport = transportFactory();
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      if (this.disposed) {
        await client.close();
        throw new Error(`Service '${this.key}' is stopped.`);
      }
      this.client = client;
      this.configureToolSubscription(client);
      this.logger.info("downstream.connected", {
        serviceId: this.key,
        protocolEra: client.getProtocolEra(),
        protocolVersion: client.getNegotiatedProtocolVersion()
      });
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Returns the connected client after awaiting any in-flight connection.
   */
  private async requireClient(): Promise<Client> {
    await this.ensureConnected();
    if (!this.client) {
      throw new Error(`Downstream service '${this.key}' is not connected.`);
    }
    return this.client;
  }

  /**
   * Fetches and stores full SDK tool definitions without simplifying JSON Schema.
   */
  private async requestToolsList(client: Client): Promise<ToolDefinition[]> {
    const result = await client.listTools(undefined, this.toolsChanged ? { cacheMode: "refresh" } : undefined);
    if (this.client !== client) throw new Error("Downstream connection changed while listing tools.");
    if (result.tools.length > MAX_DOWNSTREAM_TOOLS) {
      throw new ResourceLimitError(`Service '${this.key}' returned more than ${MAX_DOWNSTREAM_TOOLS} tools.`);
    }
    if (Buffer.byteLength(JSON.stringify(result.tools), "utf8") > MAX_TOOL_CATALOG_BYTES) {
      throw new ResourceLimitError(`Service '${this.key}' returned a tool catalog larger than ${MAX_TOOL_CATALOG_BYTES} bytes.`);
    }
    this.tools = new Map(result.tools.map((tool) => [tool.name, tool]));
    return result.tools.map(normalizeToolDefinition);
  }

  /**
   * 重试只读元数据请求的传输或会话错误，保留其他协议及 HTTP 错误。
   */
  private async executeWithRecovery<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    while (true) {
      if (this.unavailableReason) {
        throw new Error(this.unavailableReason);
      }
      let client: Client | null = null;
      try {
        client = await this.requireClient();
        return await operation(client);
      } catch (error) {
        const normalized = normalizeError(error);
        if (isNonRetryable(normalized) && !this.isSessionExpired(normalized, client)) {
          throw normalized;
        }
        await this.disposeConnection(client);
        if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
          this.unavailableReason = `Service '${this.key}' is unavailable after ${MAX_RESTART_ATTEMPTS} restart attempts. Last error: ${normalized.message}`;
          throw new Error(this.unavailableReason);
        }
        this.restartAttempts += 1;
        this.logger.warn("downstream.restart_attempt", {
          serviceId: this.key,
          attempt: this.restartAttempts,
          message: normalized.message
        });
      }
    }
  }

  /**
   * 关闭失败请求所属的连接，避免旧请求误关闭已经建立的新连接。
   */
  private async disposeConnection(expectedClient?: Client | null): Promise<void> {
    const client = this.client;
    if (expectedClient !== undefined && client !== expectedClient) {
      return;
    }
    if (client) {
      this.clearConnection(client);
      await client.close().catch(() => undefined);
    }
  }

  /** 清理当前连接的派生状态；已替换连接的关闭事件不影响新连接。 */
  private clearConnection(client: Client): void {
    if (this.client !== client) {
      return;
    }
    this.formElicitationBridge.reset(new Error(`Downstream service '${this.key}' connection was closed.`));
    this.toolSubscription?.abort();
    this.toolSubscription = undefined;
    this.client = null;
    this.tools.clear();
    this.metadata = null;
    if (!this.disposed) this.toolsChanged?.();
  }
}

/** 在发送调用前检查契约，使无效声明以协议错误返回并保留当前连接。 */
function compileOutputSchema(name: string, schema: NonNullable<Tool["outputSchema"]>) {
  try {
    return downstreamValidator.getValidator(schema);
  } catch (error) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams,
      `Tool '${name}' has an invalid outputSchema: ${normalizeError(error).message}`);
  }
}

/**
 * Preserves the complete MCP tool definition in the gateway metadata view.
 */
function normalizeToolDefinition(tool: Tool): ToolDefinition {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema ?? null,
    annotations: tool.annotations,
    icons: tool.icons,
    execution: tool.execution,
    _meta: tool._meta
  };
}

/**
 * Converts optional SDK identity values to the gateway JSON object type.
 */
function toJsonObject(input: Record<string, unknown> | undefined): Record<string, unknown> | null {
  return input ?? null;
}

/**
 * Prevents protocol and explicit HTTP failures from being disguised as reconnects.
 */
function isNonRetryable(error: Error): boolean {
  if (error instanceof ProtocolError || error instanceof ResourceLimitError) {
    return true;
  }
  return error instanceof SdkHttpError && error.status >= 400 && error.status < 500;
}

class ResourceLimitError extends Error {}

/**
 * Normalizes unknown thrown values into Error instances.
 */
function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Applies the configured deadline while preserving caller cancellation.
 */
function combineWithTimeout(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}
