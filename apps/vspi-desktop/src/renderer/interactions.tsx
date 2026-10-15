import { ShieldAlertIcon } from "lucide-react";
import type { SessionView } from "../shared.js";
import { Button } from "./ui";

type Approval = SessionView["approvals"][number];
type Question = SessionView["questions"][number];

export function ApprovalCard({
  approval,
  onDecide,
}: {
  approval: Approval;
  onDecide: (id: string, decision: "approved" | "rejected") => void;
}) {
  return (
    <div className="rounded-xl border border-warning/50 bg-card p-3 shadow-sm">
      <div className="flex items-center gap-1.5 text-ui-base font-medium text-foreground">
        <ShieldAlertIcon className="size-4 text-warning" />
        需要批准 · {approval.toolName}
      </div>
      <p className="mt-1 text-ui-base text-foreground">{approval.action}</p>
      {approval.display !== undefined && (
        <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-border bg-terminal-bg p-2 font-mono text-ui-caption text-terminal-fg">
          {typeof approval.display === "string"
            ? approval.display
            : JSON.stringify(approval.display, null, 2)}
        </pre>
      )}
      <div className="mt-2 flex gap-1.5">
        <Button
          size="sm"
          onClick={() => approval.id && onDecide(approval.id, "approved")}
        >
          允许
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => approval.id && onDecide(approval.id, "rejected")}
        >
          拒绝
        </Button>
      </div>
    </div>
  );
}

export function QuestionCard({
  question,
  onAnswer,
}: {
  question: Question;
  onAnswer: (id: string, answers: Record<string, string>) => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-3 shadow-sm">
      <div className="text-ui-base font-medium text-foreground">
        需要你的回答
      </div>
      <form
        className="mt-2 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const values = Object.fromEntries(
            new FormData(event.currentTarget).entries(),
          ) as Record<string, string>;
          if (question.id) onAnswer(question.id, values);
        }}
      >
        {question.questions.map((item) => (
          <fieldset key={item.question} className="min-w-0">
            <legend className="mb-1 text-ui-base text-foreground">
              {item.question}
            </legend>
            {item.options.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1">
                {item.options.map((option) => (
                  <Button
                    key={option.label}
                    type="button"
                    variant="outline"
                    size="xs"
                    title={option.description}
                    onClick={(event) => {
                      const input =
                        event.currentTarget.closest("fieldset")?.querySelector<HTMLInputElement>(
                          "input[data-question]",
                        );
                      if (input) input.value = option.label;
                    }}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            )}
            <input
              data-question
              name={item.question}
              required={item.options.length === 0}
              placeholder={
                item.options.length > 0 ? "或输入其他回答…" : "输入回答…"
              }
              className="h-7 w-full rounded-md border border-input-border bg-input px-2 text-ui-base text-foreground outline-none placeholder:text-foreground-subtlest focus:border-input-border-focused"
            />
          </fieldset>
        ))}
        <div>
          <Button size="sm" type="submit">
            提交回答
          </Button>
        </div>
      </form>
    </div>
  );
}
