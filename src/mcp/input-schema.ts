import { fromJsonSchema, type JsonSchemaType, type JsonSchemaValidator } from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import type { JsonObject } from "../types.ts";

const providers = new WeakMap<JsonSchemaType, AjvJsonSchemaValidator>();

/** 在契约自己的命名空间编译，保留 SDK 在调用前检查输出契约的行为。 */
export const downstreamValidator = {
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    let provider = providers.get(schema);
    if (!provider) {
      provider = new AjvJsonSchemaValidator();
      providers.set(schema, provider);
    }
    return provider.getValidator<T>(schema);
  }
};

/** 列目录时返回原始契约，实际收发数据时才编译，并复用同一快照的校验器。 */
export function downstreamSchema(schema: JsonObject) {
  let validator: ReturnType<typeof fromJsonSchema> | undefined;
  return { "~standard": {
    version: 1 as const,
    vendor: "mcp-gateway",
    jsonSchema: { input: () => schema, output: () => schema },
    validate: (value: unknown) => {
      validator ??= fromJsonSchema(schema as JsonSchemaType, downstreamValidator);
      return validator["~standard"].validate(value);
    }
  } };
}

/**
 * 保留 SDK 的完整校验和 schema 导出，仅整理输入失败时的提示。
 */
export function createInputSchema(schema: JsonObject) {
  const base = fromJsonSchema<JsonObject>(schema as JsonSchemaType);
  const properties = schema.properties as Record<string, JsonObject>;
  const required = new Set(schema.required as string[]);
  const validators = Object.fromEntries(Object.entries(properties).map(([name, field]) => [
    name, fromJsonSchema(field as JsonSchemaType)
  ]));

  return {
    "~standard": {
      ...base["~standard"],
      validate: async (input: unknown) => {
        const result = await base["~standard"].validate(input);
        if (!result.issues) {
          return result;
        }
        if (!isObject(input)) {
          return { issues: [{ message: "Arguments must be an object." }] };
        }
        const messages: string[] = [];
        for (const name of Object.keys(input)) {
          if (!Object.hasOwn(properties, name)) {
            messages.push(`Unsupported parameter ${JSON.stringify(name)}. Allowed parameters: ${Object.keys(properties).join(", ")}.`);
          }
        }
        for (const [name, field] of Object.entries(properties)) {
          if (input[name] === undefined) {
            if (required.has(name)) {
              messages.push(`Missing required parameter ${JSON.stringify(name)}.`);
            }
            continue;
          }
          const checked = await validators[name]["~standard"].validate(input[name]);
          if (checked.issues) {
            messages.push(`${name}: ${describeInvalid(input[name], field)}`);
          }
        }
        return messages.length ? { issues: messages.map(message => ({ message })) } : result;
      }
    }
  };
}

/**
 * 展开网关参数的联合类型，避免把每个分支的错误逐条返回。
 */
function alternatives(schema: JsonObject): JsonObject[] {
  return Array.isArray(schema.anyOf)
    ? (schema.anyOf as JsonObject[]).flatMap(alternatives)
    : [schema];
}

/**
 * 按参数 schema 生成可纠正的提示，不回显参数值。
 */
function describeInvalid(value: unknown, schema: JsonObject): string {
  const choices = alternatives(schema);
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const branch = choices.find(choice => choice.type === type);
  const expected = choices.map(choice => {
    if (Array.isArray(choice.enum)) {
      return choice.enum.map(item => JSON.stringify(item)).join(" | ");
    }
    if (choice.type === "string" && choice.pattern === "\\S") {
      return "non-blank string";
    }
    if (choice.type === "array") {
      return `${choice.minItems ? "non-empty " : ""}${choice.uniqueItems ? "unique " : ""}string array`;
    }
    return String(choice.type);
  }).join(" or ");
  let reason = "";
  if (branch && Array.isArray(value)) {
    if (typeof branch.minItems === "number" && value.length < branch.minItems) {
      reason = "Array must not be empty. ";
    } else if (branch.uniqueItems && new Set(value).size !== value.length) {
      reason = "Array items must be unique. ";
    } else if (isObject(branch.items) && branch.items.type === "string") {
      const index = value.findIndex(item => typeof item !== "string" || !item.trim());
      if (index >= 0) {
        reason = `Item at index ${index} must be a non-blank string. `;
      }
    }
  }
  return `${reason}Expected ${expected}.`;
}

/**
 * 识别参数对象，排除 null 和数组。
 */
function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
