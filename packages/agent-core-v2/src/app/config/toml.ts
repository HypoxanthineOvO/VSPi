import { TomlError } from 'smol-toml';
import { z } from 'zod';

import type { IConfigRegistry } from './config';
import { describeUnknownError, isPlainObject } from './configPure';

export { TomlError };
export { isPlainObject } from './configPure';

export function snakeToCamel(str: string): string {
  return str.replaceAll(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

export function camelToSnake(str: string): string {
  return str.replaceAll(/[A-Z]/g, (ch: string) => `_${ch.toLowerCase()}`);
}

export function transformPlainObject(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[snakeToCamel(key)] = value;
  }
  return out;
}

export function plainObjectToToml(value: Record<string, unknown>, raw: unknown): Record<string, unknown> {
  const out = cloneRecord(raw);
  for (const [key, entry] of Object.entries(value)) {
    setDefined(out, camelToSnake(key), entry);
  }
  return out;
}

function defaultFromToml(value: unknown): unknown {
  return isPlainObject(value) ? transformPlainObject(value) : value;
}

export function transformTomlData(
  data: Record<string, unknown>,
  registry: IConfigRegistry,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const domain = snakeToCamel(key);
    const fromToml = registry.getSection(domain)?.fromToml;
    result[domain] = fromToml === undefined ? defaultFromToml(value) : fromToml(value);
  }
  return result;
}

export function applySectionToToml(
  rawSnake: Record<string, unknown>,
  domain: string,
  value: unknown,
  registry: IConfigRegistry,
): void {
  const snakeKey = camelToSnake(domain);
  const section = registry.getSection(domain);
  const toToml = section?.toToml;

  if (value === undefined) {
    delete rawSnake[snakeKey];
    return;
  }

  if (toToml !== undefined) {
    const rawSub = pruneKnownTomlKeys(section?.schema, value, rawSnake[snakeKey]);
    const converted = toToml(value, rawSub);
    if (converted === undefined || converted === null) {
      delete rawSnake[snakeKey];
    } else if (isPlainObject(converted) && Object.keys(converted).length === 0) {
      delete rawSnake[snakeKey];
    } else {
      rawSnake[snakeKey] = converted;
    }
    return;
  }

  if (!isPlainObject(value)) {
    setDefined(rawSnake, snakeKey, value);
    return;
  }
  const rawSub = pruneKnownTomlKeys(section?.schema, value, rawSnake[snakeKey]);
  const converted = plainObjectToToml(value, rawSub);
  if (Object.keys(converted).length > 0) {
    rawSnake[snakeKey] = converted;
  } else {
    delete rawSnake[snakeKey];
  }
}

function pruneKnownTomlKeys(schema: unknown, value: unknown, raw: unknown): Record<string, unknown> {
  const out = cloneRecord(raw);
  if (!isPlainObject(value)) return out;
  while (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault || schema instanceof z.ZodNullable) schema = schema.unwrap() as z.ZodType;
  if (schema instanceof z.ZodObject) {
    for (const [key, child] of Object.entries(schema.shape)) {
      const snakeKey = camelToSnake(key);
      if (!Object.hasOwn(value, key)) delete out[snakeKey];
      else if (isPlainObject(value[key]) && isPlainObject(out[snakeKey])) out[snakeKey] = pruneKnownTomlKeys(child as z.ZodType, value[key], out[snakeKey]);
    }
  } else if (schema instanceof z.ZodRecord) {
    for (const key of Object.keys(out)) {
      if (!Object.hasOwn(value, key)) delete out[key];
      else if (isPlainObject(value[key]) && isPlainObject(out[key])) out[key] = pruneKnownTomlKeys(schema.valueType as z.ZodType, value[key], out[key]);
    }
  }
  return out;
}

export function describeTomlSyntaxError(error: unknown): string {
  const firstLine = describeUnknownError(error).split('\n', 1)[0] ?? '';
  if (error instanceof TomlError) {
    return `${firstLine} (line ${error.line}, column ${error.column})`;
  }
  return firstLine;
}

export function cloneRecord(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return {};
  return cloneUnknown(value);
}

function cloneUnknown<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function setDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  } else {
    delete target[key];
  }
}
