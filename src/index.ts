#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigLoader } from "./config.ts";
import { ConfigFileWatcher } from "./file-watcher.ts";
import { GatewayServer } from "./gateway-server.ts";
import { Logger } from "./logger.ts";
import { ServiceRegistry } from "./service-registry.ts";
import { VERSION } from "./version.ts";

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
  private readonly configPath = resolve(getConfigPath());

  /**
   * Stores the runtime service registry.
   */
  private readonly registry = new ServiceRegistry(this.configPath, new ConfigLoader(), this.logger);

  /**
   * Stores the gateway server bound to stdin/stdout.
   */
  private readonly server = new GatewayServer(this.registry, this.logger);

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
    this.server.setStartupBarrier(startup);
    this.server.start();
    this.registerSignals();
    await startup;
    this.watcher.start();

    this.logger.info("gateway.started", {
      configPath: this.configPath
    });
  }

  /**
   * Registers signal handlers for graceful shutdown.
   */
  private registerSignals(): void {
    const shutdown = async (signal: NodeJS.Signals | "stdin-end" | "stdin-close"): Promise<void> => {
      if (this.shuttingDown) {
        return;
      }
      this.shuttingDown = true;

      this.logger.info("gateway.stopping", { signal });
      this.watcher.stop();
      await this.registry.dispose();
      process.exit(0);
    };

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.stdin.on("end", () => void shutdown("stdin-end"));
    process.stdin.on("close", () => void shutdown("stdin-close"));
  }
}

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

function getConfigPath(): string {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf("--config");
  if (configIndex !== -1 && args[configIndex + 1]) {
    return args[configIndex + 1]!;
  }

  return process.env.MCP_GATEWAY_CONFIG ?? "config.json";
}
