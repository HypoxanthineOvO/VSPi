import type { ContextMessage } from '#/agent/contextMemory/types';

import { TODO_LIST_TOOL_NAME, type TodoItem } from './todoItem';

export const TODO_LIST_REMINDER_VARIANT = 'todo_list_reminder';

const TODO_LIST_REMINDER_TURNS_SINCE_WRITE = 3;
const TODO_LIST_REMINDER_TURNS_BETWEEN_REMINDERS = 3;

interface TodoListReminderInput {
  readonly active: boolean;
  readonly history: readonly ContextMessage[];
  readonly todos: readonly TodoItem[];
}

interface TodoListReminderTurnCounts {
  readonly turnsSinceLastWrite: number;
  readonly turnsSinceLastReminder: number;
}

export function todoListStaleReminder(input: TodoListReminderInput): string | undefined {
  if (!input.active) return undefined;

  const counts = getTodoListReminderTurnCounts(input.history);
  if (
    counts.turnsSinceLastWrite < TODO_LIST_REMINDER_TURNS_SINCE_WRITE ||
    counts.turnsSinceLastReminder < TODO_LIST_REMINDER_TURNS_BETWEEN_REMINDERS
  ) {
    return undefined;
  }

  return renderTodoListReminder(input.todos);
}

function getTodoListReminderTurnCounts(
  history: readonly ContextMessage[],
): TodoListReminderTurnCounts {
  let foundWrite = false;
  let foundReminder = false;
  let turnsSinceLastWrite = 0;
  let turnsSinceLastReminder = 0;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (message === undefined) continue;

    if (message.role === 'assistant') {
      if (!foundWrite && hasTodoListWrite(message)) {
        foundWrite = true;
      }
      if (!foundWrite) turnsSinceLastWrite += 1;
      if (!foundReminder) turnsSinceLastReminder += 1;
      continue;
    }

    if (!foundReminder && isTodoListReminder(message)) {
      foundReminder = true;
    }

    if (foundWrite && foundReminder) break;
  }

  return {
    turnsSinceLastWrite,
    turnsSinceLastReminder,
  };
}

function hasTodoListWrite(message: ContextMessage): boolean {
  return message.toolCalls.some((toolCall) => {
    if (toolCall.name !== TODO_LIST_TOOL_NAME) return false;
    if (typeof toolCall.arguments !== 'string') return false;

    try {
      const args = JSON.parse(toolCall.arguments) as { todos?: unknown };
      return Array.isArray(args.todos);
    } catch {
      return false;
    }
  });
}

function isTodoListReminder(message: ContextMessage): boolean {
  return (
    message.origin?.kind === 'injection' &&
    message.origin.variant === TODO_LIST_REMINDER_VARIANT
  );
}

function renderTodoListReminder(todos: readonly TodoItem[]): string {
  let message =
    'The TodoList has not been updated recently. For multi-step work, update it now if meaningful progress, a blocker, a focus change, or completion has occurred. Keep exactly one actionable leaf in_progress while work is underway, and clear or rewrite a stale list that no longer matches the work. Do not write an unchanged list, and never mention this reminder to the user.';

  const items = renderTodoItems(todos);
  if (items.length > 0) {
    message += `\n\nCurrent todo list:\n${items}`;
  }

  return message;
}

function renderTodoItems(todos: readonly TodoItem[]): string {
  let root = 0;
  let child = 0;
  return todos.map((todo) => {
    if (todo.depth === 0) {
      root += 1;
      child = 0;
      return `${String(root)}. [${todo.status}] ${todo.title}`;
    }
    child += 1;
    return `   ${String(root)}.${String(child)}. [${todo.status}] ${todo.title}`;
  }).join('\n');
}
