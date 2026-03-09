import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { GatewayConfig, ServiceConfig, StdioFraming, StdioTransportConfig } from "./types.ts";

/**
 * Provides config loading and validation for the gateway service pool definition.
 */
export class ConfigLoader {
  /**
   * Loads, parses, and validates the config file from disk.
   */
  public async load(configPath: string): Promise<GatewayConfig> {
    const absolutePath = resolve(configPath);
    const rawText = await readFile(absolutePath, "utf8");
    const parsed = JSON.parse(rawText) as unknown;
    return validateGatewayConfig(parsed);
  }
}

/**
 * Validates the top-level config object and normalizes optional fields.
 */
export function validateGatewayConfig(input: unknown): GatewayConfig {
  if (!isRecord(input)) {
    throw new Error("The gateway config must be a JSON object.");
  }

  if (!Array.isArray(input.services)) {
    throw new Error("The 'services' field must be an array.");
  }

  const services = input.services.map(validateServiceConfig);
  const seenServiceIds = new Set<string>();

  for (const service of services) {
    if (seenServiceIds.has(service.serviceId)) {
      throw new Error(`Duplicate serviceId '${service.serviceId}' was found in the config.`);
    }
    seenServiceIds.add(service.serviceId);
  }

  return {
    services: services.filter((service) => service.enable)
  };
}

/**
 * Validates one logical service definition.
 */
function validateServiceConfig(input: unknown): ServiceConfig {
  if (!isRecord(input)) {
    throw new Error("Each service must be a JSON object.");
  }

  const serviceId = requireNonEmptyString(input.serviceId, "service.serviceId");
  const enable = optionalBoolean(input.enable, `service '${serviceId}' enable`) ?? true;
  const name = requireNonEmptyString(input.name, `service '${serviceId}' name`);
  const description = optionalString(input.description, `service '${serviceId}' description`);

  return {
    serviceId,
    enable,
    name,
    description,
    transport: validateTransportConfig(serviceId, input.transport)
  };
}

/**
 * Validates the supported transport definition.
 */
function validateTransportConfig(serviceId: string, input: unknown): StdioTransportConfig {
  if (!isRecord(input)) {
    throw new Error(`Service '${serviceId}' transport must be a JSON object.`);
  }

  const type = requireNonEmptyString(input.type, `service '${serviceId}' transport.type`);
  if (type !== "stdio") {
    throw new Error(`Service '${serviceId}' uses unsupported transport type '${type}'.`);
  }

  const command = requireNonEmptyString(input.command, `service '${serviceId}' transport.command`);
  const args = optionalStringArray(input.args, `service '${serviceId}' transport.args`);
  const cwd = optionalString(input.cwd, `service '${serviceId}' transport.cwd`);
  const env = optionalStringRecord(input.env, `service '${serviceId}' transport.env`);
  const framing = optionalFraming(input.framing, `service '${serviceId}' transport.framing`);

  return {
    type: "stdio",
    command,
    args,
    cwd,
    env,
    framing
  };
}

/**
 * Checks whether a value is a record-like object.
 */
function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * Reads a required non-empty string field.
 */
function requireNonEmptyString(input: unknown, label: string): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error(`The '${label}' field must be a non-empty string.`);
  }
  return input;
}

/**
 * Reads an optional string field.
 */
function optionalString(input: unknown, label: string): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (typeof input !== "string") {
    throw new Error(`The '${label}' field must be a string when present.`);
  }
  return input;
}

/**
 * Reads an optional boolean field.
 */
function optionalBoolean(input: unknown, label: string): boolean | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (typeof input !== "boolean") {
    throw new Error(`The '${label}' field must be a boolean when present.`);
  }
  return input;
}

/**
 * Reads an optional string array field.
 */
function optionalStringArray(input: unknown, label: string): string[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!Array.isArray(input) || input.some((item) => typeof item !== "string")) {
    throw new Error(`The '${label}' field must be an array of strings when present.`);
  }
  return input;
}

/**
 * Reads an optional string-to-string object field.
 */
function optionalStringRecord(input: unknown, label: string): Record<string, string> | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!isRecord(input)) {
    throw new Error(`The '${label}' field must be an object when present.`);
  }

  const entries = Object.entries(input);
  for (const [key, value] of entries) {
    if (typeof value !== "string") {
      throw new Error(`The '${label}.${key}' field must be a string.`);
    }
  }

  return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * Reads an optional stdio framing field.
 */
function optionalFraming(input: unknown, label: string): StdioFraming | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (input !== "line" && input !== "content-length") {
    throw new Error(`The '${label}' field must be 'line' or 'content-length' when present.`);
  }
  return input;
}
