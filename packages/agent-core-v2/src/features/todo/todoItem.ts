export const TODO_LIST_TOOL_NAME = 'TodoList' as const;

export type TodoStatus = 'pending' | 'in_progress' | 'done';

export interface TodoItem {
  readonly title: string;
  readonly status: TodoStatus;
  readonly depth?: 0 | 1;
  readonly group?: boolean;
}

export function readTodoItems(raw: unknown): readonly TodoItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isTodoItem).map((todo) => ({
    title: todo.title,
    status: todo.status,
    ...(todo.depth === 0 || todo.depth === 1 ? { depth: todo.depth } : {}),
    ...(typeof todo.group === 'boolean' ? { group: todo.group } : {}),
  }));
}

export function isTodoItem(value: unknown): value is TodoItem {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['title'] === 'string' && isTodoStatus(record['status']);
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === 'pending' || value === 'in_progress' || value === 'done';
}

export function renderTodoList(todos: readonly TodoItem[], title = 'Current todo list:'): string {
  if (todos.length === 0) {
    return 'Todo list is empty.';
  }
  const lines = todos.map((t) => {
    const marker = statusMarker(t.status);
    const indent = t.depth === 1 ? '    ' : '  ';
    return `${indent}${marker} ${t.title}`;
  });
  return [title, ...lines].join('\n');
}

function statusMarker(status: TodoStatus): string {
  switch (status) {
    case 'pending':
      return '[pending]';
    case 'in_progress':
      return '[in_progress]';
    case 'done':
      return '[done]';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
