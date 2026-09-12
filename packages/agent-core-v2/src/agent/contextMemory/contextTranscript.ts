import { type ContentPart, type ToolCall } from '#/kosong/contract/message';
import type { WireRecord } from '#/wire/record';

import {
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  collectCompactableUserMessages,
  selectRecentUserMessages,
} from './compactionHandoff';
import { isPromptOwnedInjection, isUndoAnchor } from './conversationTime';
import { createLoopEventFold, type LoopRecordedEvent } from './loopEventFold';
import type { ContextMessage } from './types';

export interface ContextTranscript {
  readonly entries: readonly ContextMessage[];
  readonly times: readonly (number | undefined)[];
  readonly foldedLength: number;
}

export interface ContextTranscriptReducer {
  add(record: WireRecord): void;
  result(): ContextTranscript;
  positions(): readonly number[];
}

interface MutableMessage {
  id?: string;
  role: ContextMessage['role'];
  content: ContentPart[];
  toolCalls: ToolCall[];
  toolCallId?: string;
  isError?: boolean;
  note?: string;
  origin?: ContextMessage['origin'];
}

interface MutableEntry {
  message: MutableMessage;
  time?: number;
  omitContent?: boolean;
  ordinal?: number;
}

export function reduceContextTranscript(records: Iterable<WireRecord>): ContextTranscript {
  const reducer = createContextTranscriptReducer();
  for (const record of records) reducer.add(record);
  return reducer.result();
}

export function createContextTranscriptReducer(options: { maxContentChars?: number; contentOrdinals?: ReadonlySet<number> } = {}): ContextTranscriptReducer {
  const transcript: MutableEntry[] = [];
  let foldedLength = 0;
  let clearFloor = 0;
  let openEntry: MutableEntry | undefined;
  let nextOrdinal = 0;

  const project = (part: ContentPart, limit = options.maxContentChars): ContentPart => {
    if (options.maxContentChars === undefined) return part;
    if (part.type === 'text') return { type: 'text', text: part.text.length > (limit ?? 0) ? `${part.text.slice(0, limit)}[display truncated]` : part.text };
    if (part.type === 'think') return { type: 'think', think: part.think.slice(0, limit) };
    return { type: 'text', text: `[${part.type}]` };
  };
  const omit = (entry: MutableEntry) => { entry.omitContent = true; entry.message.content = []; entry.message.toolCalls = []; };
  const push = (...entries: MutableEntry[]): void => {
    for (const entry of entries) {
      entry.ordinal = nextOrdinal++;
      if (options.contentOrdinals !== undefined && !options.contentOrdinals.has(entry.ordinal)) { omit(entry); continue; }
      if (options.maxContentChars === undefined) continue;
      let remaining = options.maxContentChars;
      entry.message.content = entry.message.content.slice(0, 64).map(part => {
        const result = project(part, Math.max(0, remaining));
        remaining -= result.type === 'text' ? result.text.length : result.type === 'think' ? result.think.length : 0;
        return result;
      });
      entry.message.toolCalls = entry.message.toolCalls.slice(0, 64).map(call => ({ ...call, arguments: call.arguments?.slice(0, 1024) ?? null }));
    }
    transcript.push(...entries);
    foldedLength += entries.length;
  };

  const fold = createLoopEventFold({
    openAssistant: (time) => {
      openEntry = { message: { role: 'assistant', content: [], toolCalls: [] }, time };
      push(openEntry);
    },
    appendOpenContent: (part) => {
      if (openEntry?.omitContent) return;
      if (options.maxContentChars === undefined) { openEntry?.message.content.push(part); return; }
      const used = openEntry?.message.content.reduce((sum, item) => sum + (item.type === 'text' ? item.text.length : item.type === 'think' ? item.think.length : 0), 0) ?? 0;
      if (options.maxContentChars === undefined || (openEntry?.message.content.length ?? 0) < 64) openEntry?.message.content.push(project(part, options.maxContentChars === undefined ? undefined : Math.max(0, options.maxContentChars - used)));
    },
    appendOpenToolCall: (call) => {
      if (openEntry?.omitContent) return;
      if (options.maxContentChars === undefined || (openEntry?.message.toolCalls.length ?? 0) < 64) openEntry?.message.toolCalls.push(options.maxContentChars === undefined ? call : { ...call, arguments: call.arguments?.slice(0, 1024) ?? null });
    },
    dropOpenAssistant: () => {
      if (openEntry === undefined) return;
      const index = transcript.indexOf(openEntry);
      openEntry = undefined;
      if (index === -1) return;
      transcript.splice(index, 1);
      foldedLength = Math.max(0, foldedLength - 1);
    },
    sealOpenAssistant: () => {
      openEntry = undefined;
    },
    pushToolMessage: (message, time) => {
      push({ message: message as MutableMessage, time });
    },
    pushMessage: (message, time) => {
      push(toMutableEntry(message, time));
    },
  });

  const resetOpenState = (): void => {
    fold.reset();
    openEntry = undefined;
  };

  const applyUndo = (count: number): void => {
    if (count <= 0) return;
    let removedUserCount = 0;
    for (let i = transcript.length - 1; i >= clearFloor; i--) {
      const message = transcript[i]!.message;
      if (message.origin?.kind === 'injection') continue;
      if (message.origin?.kind === 'compaction_summary') break;
      transcript.splice(i, 1);
      foldedLength = Math.max(0, foldedLength - 1);
      if (isUndoAnchor(message)) {
        removedUserCount++;
        while (
          i > clearFloor &&
          isPromptOwnedInjection(transcript[i - 1]!.message, message)
        ) {
          transcript.splice(i - 1, 1);
          i--;
          foldedLength = Math.max(0, foldedLength - 1);
        }
        if (removedUserCount >= count) break;
      }
    }
    resetOpenState();
  };

  const add = (record: WireRecord): void => {
    switch (record.type) {
      case 'context.append_message': {
        fold.appendMessage(record['message'] as ContextMessage, record.time);
        break;
      }
      case 'context.append_loop_event': {
        fold.loopEvent(record['event'] as LoopRecordedEvent, record.time);
        break;
      }
      case 'context.apply_compaction': {
        if (readNumber(record, 'keptUserMessageCount') !== undefined) {
          fold.settle(record.time);
        } else {
          resetOpenState();
        }
        const previousLength = foldedLength;
        push({
          message: {
            role: 'user',
            content: [{ type: 'text', text: readCompactionSummaryText(record) }],
            toolCalls: [],
            origin: { kind: 'compaction_summary' },
          },
          time: record.time,
        });
        foldedLength = recoverFoldedLength(record, transcript, clearFloor, previousLength);
        break;
      }
      case 'context.undo':
        applyUndo(record['count'] as number);
        break;
      case 'context.clear':
        clearFloor = transcript.length;
        foldedLength = 0;
        resetOpenState();
        break;
      default:
        break;
    }
  };

  return {
    add,
    positions: () => transcript.map(entry => entry.ordinal!),
    result: () => ({
      entries: transcript.map((e) => e.message),
      times: transcript.map((e) => e.time),
      foldedLength,
    }),
  };
}

function toMutableEntry(message: ContextMessage, time: number | undefined): MutableEntry {
  return {
    message: {
      ...(message.id !== undefined ? { id: message.id } : {}),
      role: message.role,
      content: [...message.content],
      toolCalls: [...message.toolCalls],
      ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
      ...(message.isError !== undefined ? { isError: message.isError } : {}),
      ...(message.origin !== undefined ? { origin: message.origin } : {}),
    },
    time,
  };
}

function recoverFoldedLength(
  record: WireRecord,
  transcript: readonly MutableEntry[],
  clearFloor: number,
  foldedLength: number,
): number {
  const keptUserMessageCount = readNumber(record, 'keptUserMessageCount');
  const keptHeadUserMessageCount = readNumber(record, 'keptHeadUserMessageCount');
  const compactedCount = readNumber(record, 'compactedCount');
  if (keptUserMessageCount !== undefined) {
    return keptUserMessageCount + (keptHeadUserMessageCount === undefined ? 1 : 2);
  }
  if (compactedCount !== undefined && compactedCount < foldedLength) {
    return 1 + (foldedLength - compactedCount);
  }
  const keptUserMessages = selectRecentUserMessages(
    collectCompactableUserMessages(transcript.slice(clearFloor).map((e) => e.message)),
    COMPACT_USER_MESSAGE_MAX_TOKENS,
  );
  return keptUserMessages.length + 1;
}

function readCompactionSummaryText(record: WireRecord): string {
  const summary = record['summary'];
  if (typeof summary === 'string') return summary;
  const contextSummary = record['contextSummary'];
  if (typeof contextSummary === 'string') return contextSummary;
  if (isContextMessageLike(summary)) return textOfParts(summary.content);
  return '';
}

function isContextMessageLike(value: unknown): value is ContextMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as { role?: unknown; content?: unknown };
  return typeof message.role === 'string' && Array.isArray(message.content);
}

function textOfParts(content: readonly ContentPart[]): string {
  let text = '';
  for (const part of content) {
    if (part.type === 'text') text += part.text;
  }
  return text;
}

function readNumber(record: WireRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}
