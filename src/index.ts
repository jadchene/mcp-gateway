#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigLoader } from "./config.ts";
import { ConfigFileWatcher } from "./file-watcher.ts";
import { McpGatewayEngine } from "./gateway-engine.ts";
import { GatewayServer } from "./gateway-server.ts";
import { StreamableHttpGatewayServer } from "./http-server.ts";
import { Logger } from "./logger.ts";
import { ServiceRegistry } from "./service-registry.ts";
import type { GatewayServerConfig } from "./types.ts";
import { VERSION } from "./version.ts";

/**
 * Lists OS signals that should trigger a graceful gateway shutdown.
 */
export const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Boots the MCP gateway process and wires config reload handling.
 */
class Application {
  /**
   * Stores a shared logger instance.
   */
  private readonly logger = new Logger();

  /**
   * Stores the config file path in use for the current process.
   */
  private readonly cliOptions = parseCliArgs(process.argv.slice(2));

  /**
   * Stores the config file path in use for the current process.
   */
  private readonly configPath = resolve(this.cliOptions.configPath);

  /**
   * Stores the runtime service registry.
   */
  private readonly registry = new ServiceRegistry(this.configPath, new ConfigLoader(), this.logger);

  /**
   * Stores the transport-neutral request engine shared by all inbound transports.
   */
  private readonly engine = new McpGatewayEngine(this.registry, this.logger);

  /**
   * Stores the gateway server bound to stdin/stdout.
   */
  private readonly server = new GatewayServer(
    this.registry,
    this.logger,
    this.engine
  );

  /**
   * Stores the optional Streamable HTTP gateway server.
   */
  private httpServer: StreamableHttpGatewayServer | null = null;

  /**
   * Stores the file watcher used for config hot reload.
   */
  private readonly watcher = new ConfigFileWatcher(this.configPath, this.logger, async () => {
    await this.registry.reload();
  });

  /**
   * Prevents duplicate shutdown execution when multiple exit signals arrive.
   */
  private shuttingDown = false;

  /**
   * Starts the application and registers shutdown hooks.
   */
  public async start(): Promise<void> {
    if (!existsSync(this.configPath)) {
      throw new Error(`Config file was not found: ${this.configPath}`);
    }

    const startup = this.registry.initialize();
    this.engine.setStartupBarrier(startup);
    this.server.start();
    await startup;

    const serverConfig = this.cliOptions.server;
    this.registerSignals(Boolean(serverConfig));

    if (serverConfig) {
      this.httpServer = new StreamableHttpGatewayServer(serverConfig, this.engine, this.logger);
      await this.httpServer.start();
    }

    this.watcher.start();

    this.logger.info("gateway.started", {
      configPath: this.configPath
    });
  }

  /**
   * Registers signal handlers for graceful shutdown.
   */
  private registerSignals(httpEnabled: boolean): void {
    const shutdown = async (signal: NodeJS.Signals | "stdin-end" | "stdin-close"): Promise<void> => {
      if (this.shuttingDown) {
        return;
      }
      this.shuttingDown = true;

      this.logger.info("gateway.stopping", { signal });
      this.watcher.stop();
      await this.httpServer?.stop();
      await this.server.stop();
      await this.registry.dispose();
      process.exit(0);
    };

    for (const signal of SHUTDOWN_SIGNALS) {
      process.on(signal, () => void shutdown(signal));
    }
    if (!httpEnabled) {
      process.stdin.on("end", () => void shutdown("stdin-end"));
      process.stdin.on("close", () => void shutdown("stdin-close"));
    }
  }
}

if (import.meta.main) {
  const application = new Application();

  if (process.argv.includes("-v") || process.argv.includes("--version")) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }

  void application.start().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}

export function parseCliArgs(args: string[]): CliOptions {
  if (args.includes("--protocol-mode")) {
    throw new Error("--protocol-mode is no longer supported; protocol negotiation is automatic.");
  }
  const configPath = readOption(args, "--config") ?? process.env.MCP_GATEWAY_CONFIG ?? "config.json";
  const port = readIntegerOption(args, "--port");
  const host = readOption(args, "--host");
  const path = readHttpPathOption(args);
  const enableHttp = args.includes("--http");
  const enableJsonResponse = args.includes("--json-response");
  return {
    configPath,
    server: enableHttp
      ? {
          enable: true,
          host: host ?? "127.0.0.1",
          port: port ?? 3000,
          path: path ?? "/mcp",
          enableJsonResponse
        }
      : undefined
  };
}

/**
 * Reads a string option from argv.
 */
function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index !== -1 && args[index + 1]) {
    return args[index + 1];
  }
  return undefined;
}

/**
 * Reads an integer option from argv.
 */
function readIntegerOption(args: string[], name: string): number | undefined {
  const value = readOption(args, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535.`);
  }
  return parsed;
}

/**
 * Reads and validates the inbound HTTP endpoint path option.
 */
function readHttpPathOption(args: string[]): string | undefined {
  const path = readOption(args, "--path");
  if (path === undefined) {
    return undefined;
  }
  if (!path.startsWith("/")) {
    throw new Error("--path must start with '/'.");
  }
  return path;
}

interface CliOptions {
  /**
   * Provides the gateway config file path.
   */
  configPath: string;
  /**
   * Provides optional CLI HTTP server overrides.
   */
  server?: GatewayServerConfig;
}
