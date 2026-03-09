import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ConfigLoader } from "../src/config.ts";
import { Logger } from "../src/logger.ts";
import { ServiceRegistry } from "../src/service-registry.ts";

async function main(): Promise<void> {
  const [configPathArg, serviceId, toolNameArg] = process.argv.slice(2);
  if (!configPathArg || !serviceId) {
    throw new Error("Usage: node --experimental-strip-types examples/diagnose-service.ts <configPath> <serviceId> [toolName]");
  }

  const configPath = resolve(configPathArg);
  const configLoader = new ConfigLoader();
  const logger = new Logger();
  const config = await configLoader.load(configPath);
  const service = config.services.find((item) => item.serviceId === serviceId);
  if (!service) {
    throw new Error(`Unknown service '${serviceId}' in '${configPath}'.`);
  }

  const toolName = toolNameArg ?? defaultToolForService(serviceId);
  const tempDir = resolve(".tmp");
  const tempConfigPath = join(tempDir, `diagnose-${serviceId}-${randomUUID()}.json`);
  const logPath = join(tempDir, `diagnose-${serviceId}.log`);
  const registry = new ServiceRegistry(tempConfigPath, configLoader, logger);

  await mkdir(tempDir, { recursive: true });
  await writeFile(tempConfigPath, JSON.stringify({ services: [service] }, null, 2), "utf8");
  await writeFile(logPath, "", "utf8");

  const startedAt = Date.now();
  try {
    await logLine(logPath, `[diagnose] service=${serviceId} phase=initialize start`);
    await registry.initialize();
    await logLine(logPath, `[diagnose] service=${serviceId} phase=initialize done elapsedMs=${Date.now() - startedAt}`);

    const snapshot = registry.getService(serviceId);
    await logLine(logPath, `[diagnose] service=${serviceId} phase=metadata tools=${snapshot?.metadata.tools.length ?? -1} available=${snapshot?.runtime.available ?? false}`);

    if (toolName) {
      const callStartedAt = Date.now();
      const args = defaultArgsForService(serviceId, toolName);
      await logLine(logPath, `[diagnose] service=${serviceId} phase=call start tool=${toolName}`);
      const result = await registry.callTool(serviceId, toolName, args);
      await logLine(logPath, `[diagnose] service=${serviceId} phase=call done tool=${toolName} elapsedMs=${Date.now() - callStartedAt}`);
      console.log(JSON.stringify({
        serviceId,
        toolName,
        durationMs: result.durationMs,
        restartAttempts: result.restartAttempts,
        result: summarizeResult(result.result)
      }, null, 2));
    }
  } finally {
    const disposeStartedAt = Date.now();
    await logLine(logPath, `[diagnose] service=${serviceId} phase=dispose start`);
    await registry.dispose();
    await logLine(logPath, `[diagnose] service=${serviceId} phase=dispose done elapsedMs=${Date.now() - disposeStartedAt}`);
    await logLine(logPath, `[diagnose] service=${serviceId} phase=resources active=${JSON.stringify(process.getActiveResourcesInfo())}`);
    await rm(tempConfigPath, { force: true });
  }
}

function defaultToolForService(serviceId: string): string | null {
  switch (serviceId) {
    case "database":
      return "list_databases";
    case "ssh":
      return "list_servers";
    case "idea":
    case "webstorm":
      return "get_all_open_file_paths";
    case "playwright":
      return "browser_tabs";
    case "gitea":
      return "get_my_user_info";
    default:
      return null;
  }
}

function defaultArgsForService(serviceId: string, toolName: string): Record<string, unknown> {
  if (serviceId === "playwright" && toolName === "browser_tabs") {
    return { action: "list" };
  }
  return {};
}

function summarizeResult(result: unknown): unknown {
  if (!Array.isArray(result)) {
    return result;
  }

  return {
    kind: "array",
    length: result.length,
    preview: result.slice(0, 3)
  };
}

void main().catch((error) => {
  console.error(`[diagnose] failed ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});

async function logLine(logPath: string, message: string): Promise<void> {
  const line = `${new Date().toISOString()} ${message}\n`;
  await appendFile(logPath, line, "utf8");
  console.error(message);
}
