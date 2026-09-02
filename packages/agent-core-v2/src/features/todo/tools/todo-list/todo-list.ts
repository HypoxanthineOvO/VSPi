import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';
import { type TodoItem, type TodoStatus } from '#/features/todo/todoItem';

const TodoLeafSchema = z.strictObject({
  title: z.string().min(1).describe('Short, actionable title for the todo.'),
  status: z.enum(['pending', 'in_progress', 'done']).describe('Current status of the todo.'),
});

const TodoGroupSchema = z.strictObject({
  title: z.string().min(1).describe('Short title for a group of related todos.'),
  children: z
    .array(TodoLeafSchema)
    .min(1)
    .describe('Actionable child todos. TodoList supports exactly these two levels.'),
});

export interface TodoLeafInput {
  readonly title: string;
  readonly status: TodoStatus;
}

export interface TodoGroupInput {
  readonly title: string;
  readonly children: TodoLeafInput[];
}

export interface TodoListInput {
  todos?: Array<TodoLeafInput | TodoGroupInput>;
}

export const TodoListInputSchema: z.ZodType<TodoListInput> = z
  .object({
    todos: z
      .array(z.union([TodoLeafSchema, TodoGroupSchema]))
      .optional()
      .describe(
        'The updated one- or two-level todo list. Omit to read without changing it. Pass an empty array to clear it.',
      ),
  })
  .superRefine((input, context) => {
    const activeLeaves = (input.todos ?? []).flatMap((todo) =>
      'children' in todo ? todo.children : [todo],
    ).filter((todo) => todo.status === 'in_progress');
    if (activeLeaves.length <= 1) return;
    context.addIssue({
      code: 'custom',
      path: ['todos'],
      message: 'TodoList allows at most one actionable leaf task in_progress.',
    });
  });

export function flattenTodoListInput(todos: readonly (TodoLeafInput | TodoGroupInput)[]): readonly TodoItem[] {
  return todos.flatMap((todo): TodoItem[] => {
    if (!('children' in todo)) {
      return [{ title: todo.title, status: todo.status, depth: 0, group: false }];
    }
    const children = todo.children.map((child): TodoItem => ({
      title: child.title,
      status: child.status,
      depth: 1,
      group: false,
    }));
    return [
      { title: todo.title, status: derivedGroupStatus(children), depth: 0, group: true },
      ...children,
    ];
  });
}

function derivedGroupStatus(children: readonly TodoItem[]): TodoStatus {
  if (children.every((child) => child.status === 'done')) return 'done';
  if (children.every((child) => child.status === 'pending')) return 'pending';
  return 'in_progress';
}

export interface ITodoListTool extends AgentTool<TodoListInput> {
  readonly _serviceBrand: undefined;
}
export const ITodoListTool = createDecorator<ITodoListTool>('todoListTool');
