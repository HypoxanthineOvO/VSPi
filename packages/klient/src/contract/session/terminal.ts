import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

const terminalIdSchema = z.string().min(1);
const terminalDimensionSchema = z.number().int().min(1).max(1000);

const relativeCwdSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith('/') && !value.startsWith('\\') && !/^[A-Za-z]:[\\/]/.test(value),
  );

export const openTerminalRequestSchema = z
  .object({
    runtime_id: z.string().min(1).max(128),
    cwd: relativeCwdSchema.optional(),
    cols: terminalDimensionSchema.optional(),
    rows: terminalDimensionSchema.optional(),
  })
  .strict();

export const streamedTerminalSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  cwd: z.string().min(1),
  shell: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  status: z.enum(['running', 'exited']),
  created_at: z.string(),
  exited_at: z.string().optional(),
  exit_code: z.number().int().nullable().optional(),
});

export const terminalOutputFrameSchema = z.object({
  type: z.literal('terminal_output'),
  seq: z.number().int(),
  session_id: z.string(),
  terminal_id: z.string(),
  timestamp: z.string(),
  payload: z.object({ data: z.string() }),
});

export const terminalExitFrameSchema = z.object({
  type: z.literal('terminal_exit'),
  session_id: z.string(),
  terminal_id: z.string(),
  timestamp: z.string(),
  payload: z.object({ exit_code: z.number().int().nullable().optional() }),
});

export const terminalStreamFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('terminal_ready'), terminal: streamedTerminalSchema }),
  terminalOutputFrameSchema,
  terminalExitFrameSchema,
]);

export const sessionTerminalContract = {
  open: {
    streaming: true,
    input: z.tuple([openTerminalRequestSchema]),
    chunk: terminalStreamFrameSchema,
  },
  write: {
    input: z.tuple([terminalIdSchema, z.string().max(64 * 1024)]),
    output: noResult,
  },
  resize: {
    input: z.tuple([terminalIdSchema, terminalDimensionSchema, terminalDimensionSchema]),
    output: noResult,
  },
  close: {
    input: z.tuple([terminalIdSchema]),
    output: z.object({ closed: z.literal(true) }),
  },
} satisfies ServiceContract;
