import {
  Client,
  ProtocolError,
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
import { SUPPORTED_MCP_PROTOCOL_VERSIONS } from "./versions.ts";

const MAX_RESTART_ATTEMPTS = 3;
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * Creates one fresh SDK transport for a downstream connection attempt.
 */
export type SdkTransportFactory = () => Transport;

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
  private connecting: Promise<void> | null = null;
  private restartAttempts = 0;
  private unavailableReason: string | null = null;
  private tools = new Map<string, Tool>();
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
    return JSON.stringify(this.service) === JSON.stringify(service);
  }

  /**
   * Establishes an SDK connection with the configured era negotiation policy.
   */
  public async ensureConnected(): Promise<void> {
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
    this.restartAttempts = 0;
    this.unavailableReason = null;
    await this.disposeConnection();
  }

  /**
   * Refreshes server identity and the complete tool catalog.
   */
  public async getMetadata(): Promise<ServiceMetadata> {
    return this.executeWithRecovery(async () => {
      const client = await this.requireClient();
      const tools = await this.requestToolsList(client);
      return {
        protocolVersion: client.getNegotiatedProtocolVersion() ?? null,
        protocolEra: client.getProtocolEra() ?? null,
        serverInfo: toJsonObject(client.getServerVersion()),
        tools,
        refreshedAt: new Date().toISOString()
      };
    });
  }

  /**
   * Lists the downstream tools using SDK caching and pagination behavior.
   */
  public async listTools(): Promise<ToolDefinition[]> {
    return this.executeWithRecovery(async () => this.requestToolsList(await this.requireClient()));
  }

  /**
   * Calls a downstream tool while preserving cancellation, custom headers, and MRTR state.
   */
  public async callTool(
    name: string,
    args: Record<string, unknown>,
    context: DownstreamCallContext = {}
  ): Promise<CallToolResult | InputRequiredResult> {
    return this.executeWithRecovery(async () => {
      const client = await this.requireClient();
      const params: CallToolRequestParams = {
        name,
        arguments: args,
        ...(context.inputResponses ? { inputResponses: context.inputResponses } : {}),
        ...(context.requestState ? { requestState: context.requestState } : {})
      };
      const invoke = async (signal: AbortSignal): Promise<CallToolResult | InputRequiredResult> => {
        const result = await client.callTool(params, {
          signal,
          allowInputRequired: true,
          toolDefinition: this.tools.get(name)
        });
        return result as CallToolResult | InputRequiredResult;
      };
      if (client.getProtocolEra() === "legacy") {
        return this.formElicitationBridge.execute(name, args, context, invoke);
      }
      const result = await invoke(context.signal ?? new AbortController().signal);
      return result as CallToolResult | InputRequiredResult;
    });
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

    const transport = transportFactory();
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      this.client = client;
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
    const result = await client.listTools();
    this.tools = new Map(result.tools.map((tool) => [tool.name, tool]));
    return result.tools.map(normalizeToolDefinition);
  }

  /**
   * Retries transport failures while leaving protocol and HTTP client errors untouched.
   */
  private async executeWithRecovery<T>(operation: () => Promise<T>): Promise<T> {
    while (true) {
      if (this.unavailableReason) {
        throw new Error(this.unavailableReason);
      }
      try {
        return await operation();
      } catch (error) {
        const normalized = normalizeError(error);
        if (isNonRetryable(normalized)) {
          throw normalized;
        }
        await this.disposeConnection();
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
   * Closes the active SDK connection and clears derived tool views.
   */
  private async disposeConnection(): Promise<void> {
    this.formElicitationBridge.reset(new Error(`Downstream service '${this.key}' connection was closed.`));
    const client = this.client;
    this.client = null;
    this.tools.clear();
    await client?.close().catch(() => undefined);
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
  if (error instanceof ProtocolError) {
    return true;
  }
  return error instanceof SdkHttpError && error.status >= 400 && error.status < 500;
}

/**
 * Normalizes unknown thrown values into Error instances.
 */
function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
