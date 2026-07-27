import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { Question, QuestionOption } from "../domain/types.js";

export interface QuestionToolOptions {
  request(questions: Question[], signal?: AbortSignal): Promise<Question[]>;
}

const QuestionOptionSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9._-]+$" }),
    label: Type.String({ minLength: 1, maxLength: 160 }),
    description: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);

const QuestionSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9._-]+$" }),
    title: Type.String({ minLength: 1, maxLength: 80 }),
    prompt: Type.String({ minLength: 1, maxLength: 2_000 }),
    kind: Type.Union([
      Type.Literal("singleChoice"),
      Type.Literal("multiChoice"),
      Type.Literal("ranking"),
      Type.Literal("freeText"),
    ]),
    options: Type.Optional(Type.Array(QuestionOptionSchema, { minItems: 1, maxItems: 20 })),
  },
  { additionalProperties: false },
);

const QuestionParameters = Type.Object(
  { questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 16 }) },
  { additionalProperties: false },
);

type QuestionParametersValue = Static<typeof QuestionParameters>;
interface QuestionToolDetails {
  answers: Array<{ id: string; answer?: string | string[]; skipped?: true }>;
}

export function createQuestionToolDefinition(
  options: QuestionToolOptions,
): ToolDefinition<typeof QuestionParameters, QuestionToolDetails> {
  return {
    name: "question",
    label: "Question",
    description:
      "Ask one or more structured questions and wait for reviewed answers. Use this tool whenever progress requires a user answer, including free-text clarification; do not stop after asking that question only in normal assistant text.",
    promptSnippet:
      "When further work depends on a user answer, explain the decision context briefly, then call question. Batch related questions. Do not replace approvals with question, ask when a safe assumption is available, or call it after the user authorized autonomous judgment.",
    parameters: QuestionParameters,
    executionMode: "sequential",
    async execute(_toolCallId, raw, signal) {
      const questions = normalizeQuestions(raw);
      const completed = await abortableRequest(options.request, questions, signal);
      const details: QuestionToolDetails = { answers: normalizeAnswers(questions, completed) };
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      };
    },
  };
}

function normalizeQuestions(raw: QuestionParametersValue): Question[] {
  if (!Array.isArray(raw.questions) || raw.questions.length < 1 || raw.questions.length > 16) {
    throw new Error("Question requires between 1 and 16 questions");
  }
  const ids = new Set<string>();
  return raw.questions.map((question) => {
    const id = safeIdentifier(question.id, "question");
    if (ids.has(id)) throw new Error("Question IDs must be unique");
    ids.add(id);
    const questionOptions = question.options?.map(normalizeOption);
    if (questionOptions && new Set(questionOptions.map((option) => option.id)).size !== questionOptions.length) {
      throw new Error("Option IDs must be unique within a question");
    }
    if (question.kind !== "freeText" && (!questionOptions || questionOptions.length === 0)) {
      throw new Error("Choice and ranking questions require options");
    }
    return {
      id,
      title: safeDisplayText(question.title, 80, "question title"),
      prompt: safeDisplayText(question.prompt, 2_000, "question prompt"),
      kind: question.kind,
      ...(questionOptions ? { options: questionOptions } : {}),
    };
  });
}

function normalizeOption(option: Static<typeof QuestionOptionSchema>): QuestionOption {
  return {
    id: safeIdentifier(option.id, "option"),
    label: safeDisplayText(option.label, 160, "option label"),
    ...(option.description === undefined
      ? {}
      : { description: safeDisplayText(option.description, 500, "option description") }),
  };
}

function normalizeAnswers(requested: Question[], completed: Question[]): QuestionToolDetails["answers"] {
  const byId = new Map(completed.map((question) => [question.id, question]));
  return requested.map((question) => {
    const result = byId.get(question.id);
    if (!result || result.skipped || result.answer === undefined) return { id: question.id, skipped: true };
    if (Array.isArray(result.answer)) {
      return { id: question.id, answer: result.answer.slice(0, 20).map((answer) => safeAnswer(answer)) };
    }
    return { id: question.id, answer: safeAnswer(result.answer) };
  });
}

function safeIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) throw new Error(`${label} ID is invalid`);
  return value;
}

function safeDisplayText(value: string, maxLength: number, label: string): string {
  const normalized = value.normalize("NFC");
  if (!normalized || Array.from(normalized).length > maxLength || /[\p{Cc}\p{Cf}]/u.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function safeAnswer(value: string): string {
  return Array.from(value.normalize("NFC").replace(/[\p{Cc}\p{Cf}]/gu, ""))
    .slice(0, 2_000)
    .join("");
}

async function abortableRequest(
  request: QuestionToolOptions["request"],
  questions: Question[],
  signal?: AbortSignal,
): Promise<Question[]> {
  if (signal?.aborted) throw abortError();
  const pending = request(structuredClone(questions), signal);
  if (!signal) return pending;
  return new Promise<Question[]>((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function abortError(): Error {
  const error = new Error("Question cancelled");
  error.name = "AbortError";
  return error;
}
