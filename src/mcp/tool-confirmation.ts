import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ElicitResult, InputRequiredResult } from "@modelcontextprotocol/client";
import type { DownstreamCallContext, DownstreamToolResult } from "./client-types.ts";

const CONFIRMATION_STATE_PREFIX = "mcp-gateway-tool-confirmation-v1.";
const APPROVED_STATE_PREFIX = "mcp-gateway-approved-tool-continuation-v1.";
const CONFIRMATION_RESPONSE_KEY = "confirm";
const DEFAULT_STATE_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_STATES = 1024;

/**
 * Gates configured downstream tools behind one upstream form elicitation round.
 */
export class ToolConfirmationInterceptor {
  private readonly stateTtlMs: number;
  private readonly maxStates: number;
  private readonly pending = new Map<string, InvocationState>();
  private readonly approvedContinuations = new Map<string, InvocationState>();
  private activeInvocations = 0;

  public constructor(options: { stateTtlMs?: number; maxStates?: number } = {}) {
    this.stateTtlMs = options.stateTtlMs ?? DEFAULT_STATE_TTL_MS;
    this.maxStates = options.maxStates ?? DEFAULT_MAX_STATES;
    if (!Number.isInteger(this.maxStates) || this.maxStates < 1) {
      throw new Error("Tool confirmation maxStates must be a positive integer.");
    }
  }

  /**
   * Checks whether a request state belongs to this interceptor.
   */
  public handlesState(requestState: string | undefined): boolean {
    return requestState?.startsWith(CONFIRMATION_STATE_PREFIX) === true
      || requestState?.startsWith(APPROVED_STATE_PREFIX) === true;
  }

  /**
   * Confirms a fresh invocation or resumes a previously approved downstream round.
   */
  public async execute(
    serviceId: string,
    toolName: string,
    args: Record<string, unknown>,
    context: DownstreamCallContext,
    invoke: (context: DownstreamCallContext) => Promise<DownstreamToolResult>
  ): Promise<DownstreamToolResult> {
    const requestState = context.requestState;
    if (requestState?.startsWith(APPROVED_STATE_PREFIX)) {
      const approved = this.consumeState(this.approvedContinuations, requestState, serviceId, toolName, args);
      if (!approved?.downstreamRequestState) {
        throw new Error("Tool confirmation state is invalid or has expired.");
      }
      return this.invokeReserved(
        serviceId,
        toolName,
        args,
        { ...context, requestState: approved.downstreamRequestState },
        invoke
      );
    }
    if (requestState?.startsWith(CONFIRMATION_STATE_PREFIX)) {
      return this.resumeConfirmation(requestState, serviceId, toolName, args, context, invoke);
    }

    if (requestState) {
      throw new Error("Tool confirmation state is invalid or has expired.");
    }

    if (!supportsFormElicitation(context.clientCapabilities)) {
      throw new Error(
        `Tool '${toolName}' in service '${serviceId}' requires confirmation, but the current MCP session does not support form elicitation.`
      );
    }

    if (this.stateCount() >= this.maxStates) {
      throw new Error(`Tool confirmation state capacity of ${this.maxStates} has been reached.`);
    }
    const state = this.createState(serviceId, toolName, args);
    this.pending.set(state.requestState, state);
    return buildConfirmationRequest(state);
  }

  /**
   * Consumes the upstream answer before invoking the downstream tool.
   */
  private async resumeConfirmation(
    requestState: string,
    serviceId: string,
    toolName: string,
    args: Record<string, unknown>,
    context: DownstreamCallContext,
    invoke: (context: DownstreamCallContext) => Promise<DownstreamToolResult>
  ): Promise<DownstreamToolResult> {
    const pending = this.consumeState(this.pending, requestState, serviceId, toolName, args);
    if (!pending) {
      throw new Error("Tool confirmation state is invalid or has expired.");
    }

    const response = context.inputResponses?.[CONFIRMATION_RESPONSE_KEY] as ElicitResult | undefined;
    if (!isConfirmed(response)) {
      throw new Error(`Tool '${toolName}' in service '${serviceId}' was not called because the user rejected the confirmation request.`);
    }

    return this.invokeReserved(
      serviceId,
      toolName,
      args,
      withoutConfirmationContinuation(context),
      invoke
    );
  }

  /**
   * Keeps a consumed state slot reserved while a downstream round is active.
   */
  private async invokeReserved(
    serviceId: string,
    toolName: string,
    args: Record<string, unknown>,
    context: DownstreamCallContext,
    invoke: (context: DownstreamCallContext) => Promise<DownstreamToolResult>
  ): Promise<DownstreamToolResult> {
    this.activeInvocations += 1;
    try {
      return await this.invokeAndTrack(serviceId, toolName, args, context, invoke);
    } finally {
      this.activeInvocations -= 1;
    }
  }

  /**
   * Records downstream MRTR state so later rounds do not ask for confirmation again.
   */
  private async invokeAndTrack(
    serviceId: string,
    toolName: string,
    args: Record<string, unknown>,
    context: DownstreamCallContext,
    invoke: (context: DownstreamCallContext) => Promise<DownstreamToolResult>
  ): Promise<DownstreamToolResult> {
    const result = await invoke(context);
    if (isInputRequiredResult(result) && typeof result.requestState === "string") {
      const state = this.createState(
        serviceId,
        toolName,
        args,
        `${APPROVED_STATE_PREFIX}${randomUUID()}`,
        result.requestState
      );
      this.approvedContinuations.set(state.requestState, state);
      return { ...result, requestState: state.requestState };
    }
    return result;
  }

  /**
   * Creates an expiring state record with an unguessable token when needed.
   */
  private createState(
    serviceId: string,
    toolName: string,
    args: Record<string, unknown>,
    requestState = `${CONFIRMATION_STATE_PREFIX}${randomUUID()}`,
    downstreamRequestState?: string
  ): InvocationState {
    const state: InvocationState = {
      serviceId,
      toolName,
      args: structuredClone(args),
      requestState,
      ...(downstreamRequestState ? { downstreamRequestState } : {}),
      expiryTimer: setTimeout(() => {
        this.pending.delete(requestState);
        this.approvedContinuations.delete(requestState);
      }, this.stateTtlMs)
    };
    state.expiryTimer.unref();
    return state;
  }

  /**
   * Atomically consumes a matching state record.
   */
  private consumeState(
    states: Map<string, InvocationState>,
    requestState: string,
    serviceId: string,
    toolName: string,
    args: Record<string, unknown>
  ): InvocationState | null {
    const state = states.get(requestState);
    if (
      !state
      || state.serviceId !== serviceId
      || state.toolName !== toolName
      || !isDeepStrictEqual(state.args, args)
    ) {
      return null;
    }
    states.delete(requestState);
    clearTimeout(state.expiryTimer);
    return state;
  }

  /**
   * Counts parked and currently executing confirmation-protected invocations.
   */
  private stateCount(): number {
    return this.pending.size + this.approvedContinuations.size + this.activeInvocations;
  }
}

interface InvocationState {
  serviceId: string;
  toolName: string;
  args: Record<string, unknown>;
  requestState: string;
  downstreamRequestState?: string;
  expiryTimer: NodeJS.Timeout;
}

/**
 * Creates the modern continuation result; the SDK bridges it for legacy clients.
 */
function buildConfirmationRequest(state: InvocationState): InputRequiredResult {
  return {
    resultType: "input_required",
    inputRequests: {
      [CONFIRMATION_RESPONSE_KEY]: {
        method: "elicitation/create",
        params: {
          mode: "form",
          message: buildConfirmationMessage(state),
          requestedSchema: {
            type: "object",
            properties: {
              decision: {
                type: "string",
                title: "Run this tool call?",
                description: "Choose yes to execute the displayed call or no to reject it.",
                enum: ["yes", "no"]
              }
            },
            required: ["decision"],
            additionalProperties: false
          }
        }
      }
    },
    requestState: state.requestState
  };
}

/**
 * Shows the exact protected invocation so the user can make an informed decision.
 */
function buildConfirmationMessage(state: InvocationState): string {
  return [
    "Review this gateway-protected tool call before execution.",
    `Service: ${JSON.stringify(state.serviceId)}`,
    `Tool: ${JSON.stringify(state.toolName)}`,
    "Risk: Gateway policy requires explicit confirmation.",
    "Arguments:",
    JSON.stringify(state.args, null, 2),
    "Choose yes to execute it or no to reject it."
  ].join("\n");
}

/**
 * Checks the explicit capability instead of relying on a later SDK failure.
 */
function supportsFormElicitation(capabilities: Record<string, unknown> | undefined): boolean {
  const elicitation = capabilities?.elicitation;
  return isRecord(elicitation) && isRecord(elicitation.form);
}

/**
 * Treats cancel, decline, malformed content, and a no decision as refusal.
 */
function isConfirmed(response: ElicitResult | undefined): boolean {
  return response?.action === "accept"
    && isRecord(response.content)
    && response.content.decision === "yes";
}

/**
 * Removes the gateway's private confirmation continuation before the first call.
 */
function withoutConfirmationContinuation(context: DownstreamCallContext): DownstreamCallContext {
  const { inputResponses: _inputResponses, requestState: _requestState, ...rest } = context;
  return rest;
}

/**
 * Detects a modern input-required tool result without depending on SDK internals.
 */
function isInputRequiredResult(result: DownstreamToolResult): result is InputRequiredResult {
  return "resultType" in result && result.resultType === "input_required";
}

/**
 * Checks whether a value is a plain record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
