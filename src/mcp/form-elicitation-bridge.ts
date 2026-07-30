import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  ProtocolError,
  ProtocolErrorCode,
  type ElicitRequestFormParams,
  type ElicitResult,
  type InputRequiredResult
} from "@modelcontextprotocol/client";
import type { DownstreamCallContext, DownstreamToolResult } from "./client-types.ts";

const BRIDGE_STATE_PREFIX = "mcp-gateway-form-elicitation-v1.";
const INPUT_RESPONSE_KEY = "form";

/**
 * Serializes 2025-era downstream calls and bridges their push-style form elicitation.
 */
export class FormElicitationBridge {
  private readonly mutex = new AsyncMutex();
  private activeCall: ActiveCall | null = null;

  /**
   * Executes or resumes one 2025-era downstream tool call.
   */
  public async execute(
    name: string,
    args: Record<string, unknown>,
    context: DownstreamCallContext,
    invoke: (signal: AbortSignal) => Promise<DownstreamToolResult>
  ): Promise<DownstreamToolResult> {
    const requestState = context.requestState;
    if (requestState?.startsWith(BRIDGE_STATE_PREFIX)) {
      return this.resume(requestState, name, args, context);
    }

    const release = await this.mutex.acquire(context.signal);
    const state = createActiveCall(name, args, context.elicitForm, release);
    this.activeCall = state;
    void invoke(state.abortController.signal).then(
      (value) => this.settle(state, { status: "fulfilled", value }),
      (error: unknown) => this.settle(state, { status: "rejected", error: normalizeError(error) })
    );
    return this.waitForResult(state, context);
  }

  /**
   * Handles one downstream form elicitation request for the active tool call.
   */
  public async handle(
    params: ElicitRequestFormParams,
    signal: AbortSignal
  ): Promise<ElicitResult> {
    const state = this.activeCall;
    if (!state) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidRequest,
        "Received form elicitation without an active downstream tool call."
      );
    }
    if (state.elicitForm) {
      return state.elicitForm(params, signal);
    }
    if (state.pendingElicitation) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidRequest,
        "Received overlapping form elicitation requests for one downstream tool call."
      );
    }

    const response = createDeferred<ElicitResult>();
    const abort = () => response.reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    response.promise.finally(() => signal.removeEventListener("abort", abort)).catch(() => undefined);
    state.pendingElicitation = { params: normalizeFormParams(params), response };
    notifyStateChanged(state);
    return response.promise;
  }

  /**
   * Aborts any parked call before its downstream connection is replaced.
   */
  public reset(reason: Error): void {
    const state = this.activeCall;
    if (!state) {
      return;
    }
    state.outcome = { status: "rejected", error: reason };
    state.abortController.abort(reason);
    state.pendingElicitation?.response.reject(reason);
    notifyStateChanged(state);
    this.release(state);
  }

  /**
   * Resumes a parked call with the upstream client's form response.
   */
  private async resume(
    requestState: string,
    name: string,
    args: Record<string, unknown>,
    context: DownstreamCallContext
  ): Promise<DownstreamToolResult> {
    const state = this.activeCall;
    if (!state || state.requestState !== requestState) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        "Form elicitation state is invalid or has expired."
      );
    }
    if (state.name !== name || !isDeepStrictEqual(state.args, args)) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        "Form elicitation retry does not match the original downstream tool call."
      );
    }

    const pending = state.pendingElicitation;
    if (pending && Object.hasOwn(context.inputResponses ?? {}, INPUT_RESPONSE_KEY)) {
      state.pendingElicitation = null;
      pending.response.resolve(context.inputResponses?.[INPUT_RESPONSE_KEY] as ElicitResult);
      notifyStateChanged(state);
    }
    return this.waitForResult(state, context);
  }

  /**
   * Waits until the downstream call completes or asks the modern upstream for input.
   */
  private async waitForResult(
    state: ActiveCall,
    context: DownstreamCallContext
  ): Promise<DownstreamToolResult> {
    state.parked = false;
    const detachAbort = forwardAbort(context.signal, state.abortController);
    try {
      while (!state.outcome && !state.pendingElicitation) {
        const changed = state.changed.promise;
        if (!state.outcome && !state.pendingElicitation) {
          await changed;
        }
      }

      if (state.outcome) {
        const outcome = state.outcome;
        this.release(state);
        if (outcome.status === "rejected") {
          throw outcome.error;
        }
        return outcome.value;
      }

      state.parked = true;
      return buildInputRequiredResult(state);
    } finally {
      detachAbort();
    }
  }

  /**
   * Records the detached downstream call result and wakes any active waiter.
   */
  private settle(state: ActiveCall, outcome: CallOutcome): void {
    if (this.activeCall !== state) {
      return;
    }
    state.outcome = outcome;
    if (state.pendingElicitation) {
      const reason = outcome.status === "rejected"
        ? outcome.error
        : new Error("Downstream tool call completed before form elicitation was answered.");
      state.pendingElicitation.response.reject(reason);
      state.pendingElicitation = null;
    }
    notifyStateChanged(state);
    if (state.parked) {
      this.release(state);
    }
  }

  /**
   * Releases the per-client serialization lock exactly once.
   */
  private release(state: ActiveCall): void {
    if (state.released) {
      return;
    }
    state.released = true;
    state.pendingElicitation = null;
    if (this.activeCall === state) {
      this.activeCall = null;
    }
    state.release();
  }
}

interface ActiveCall {
  name: string;
  args: Record<string, unknown>;
  requestState: string;
  elicitForm?: DownstreamCallContext["elicitForm"];
  release: () => void;
  released: boolean;
  parked: boolean;
  abortController: AbortController;
  pendingElicitation: PendingElicitation | null;
  outcome: CallOutcome | null;
  changed: Deferred<void>;
}

interface PendingElicitation {
  params: ElicitRequestFormParams;
  response: Deferred<ElicitResult>;
}

type CallOutcome =
  | { status: "fulfilled"; value: DownstreamToolResult }
  | { status: "rejected"; error: Error };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/**
 * Provides a cancellation-aware FIFO mutex for 2025-era calls.
 */
class AsyncMutex {
  private locked = false;
  private readonly queue: MutexWaiter[] = [];

  /**
   * Acquires the lock and returns an idempotent release callback.
   */
  public async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw abortReason(signal);
    }
    if (!this.locked) {
      this.locked = true;
      return createRelease(() => this.releaseNext());
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: MutexWaiter = { resolve, reject, signal };
      if (signal) {
        waiter.abort = () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) {
            this.queue.splice(index, 1);
          }
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  /**
   * Hands the lock to the next live waiter or marks it available.
   */
  private releaseNext(): void {
    const waiter = this.queue.shift();
    if (!waiter) {
      this.locked = false;
      return;
    }
    if (waiter.abort && waiter.signal) {
      waiter.signal.removeEventListener("abort", waiter.abort);
    }
    waiter.resolve(createRelease(() => this.releaseNext()));
  }
}

interface MutexWaiter {
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

/**
 * Creates one active call state with an unguessable continuation token.
 */
function createActiveCall(
  name: string,
  args: Record<string, unknown>,
  elicitForm: DownstreamCallContext["elicitForm"],
  release: () => void
): ActiveCall {
  return {
    name,
    args: structuredClone(args),
    requestState: `${BRIDGE_STATE_PREFIX}${randomUUID()}`,
    ...(elicitForm ? { elicitForm } : {}),
    release,
    released: false,
    parked: false,
    abortController: new AbortController(),
    pendingElicitation: null,
    outcome: null,
    changed: createDeferred<void>()
  };
}

/**
 * Converts the pending 2025 form request into a 2026 input-required result.
 */
function buildInputRequiredResult(state: ActiveCall): InputRequiredResult {
  const pending = state.pendingElicitation;
  if (!pending) {
    throw new ProtocolError(ProtocolErrorCode.InternalError, "Missing pending form elicitation state.");
  }
  return {
    resultType: "input_required",
    inputRequests: {
      [INPUT_RESPONSE_KEY]: {
        method: "elicitation/create",
        params: pending.params
      }
    },
    requestState: state.requestState
  };
}

/**
 * Removes unsupported task metadata while preserving the form request.
 */
function normalizeFormParams(params: ElicitRequestFormParams): ElicitRequestFormParams {
  return {
    mode: "form",
    message: params.message,
    requestedSchema: structuredClone(params.requestedSchema),
    ...(params._meta ? { _meta: structuredClone(params._meta) } : {})
  };
}

/**
 * Resolves the current state-change waiter and installs the next one.
 */
function notifyStateChanged(state: ActiveCall): void {
  const changed = state.changed;
  state.changed = createDeferred<void>();
  changed.resolve();
}

/**
 * Creates a Promise with externally controlled completion.
 */
function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

/**
 * Forwards a caller abort only while that upstream round remains active.
 */
function forwardAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) {
    return () => undefined;
  }
  const abort = () => target.abort(abortReason(source));
  if (source.aborted) {
    abort();
    return () => undefined;
  }
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

/**
 * Converts an AbortSignal reason into an Error instance.
 */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Wraps one release function so repeated calls are harmless.
 */
function createRelease(release: () => void): () => void {
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    release();
  };
}

/**
 * Normalizes rejected values before they cross the bridge boundary.
 */
function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
