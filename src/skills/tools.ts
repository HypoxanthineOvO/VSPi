import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { Question } from "../domain/types.js";
import { normalizeSkillInstallSource } from "./service.js";
import type { SkillCatalogItem, SkillManager, SkillScope } from "./types.js";

const ListParameters = Type.Object({}, { additionalProperties: false });
const ManageParameters = Type.Object(
  {
    action: Type.Union([
      Type.Literal("install"),
      Type.Literal("enable"),
      Type.Literal("disable"),
      Type.Literal("update"),
      Type.Literal("remove"),
    ]),
    source: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
    skill_id: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    scope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("project")])),
  },
  { additionalProperties: false },
);

type ManageValue = Static<typeof ManageParameters>;

export interface SkillToolOptions {
  manager(): SkillManager;
  request(questions: Question[], signal?: AbortSignal): Promise<Question[]>;
  afterMutation?(): void | Promise<void>;
}

export function createSkillToolDefinitions(options: SkillToolOptions): ToolDefinition[] {
  const list: ToolDefinition<typeof ListParameters, unknown> = {
    name: "skill_list",
    label: "Skill List",
    description: "List VSPi Skills, including active Pi Skills, importable Codex/Claude Skills, and diagnostics.",
    promptSnippet: "Inspect the Skill catalog before proposing Skill changes.",
    parameters: ListParameters,
    executionMode: "parallel",
    async execute() {
      const snapshot = await options.manager().list();
      const details = {
        skills: snapshot.items.map((item) => ({
          id: item.id,
          name: item.name,
          description: item.description,
          source: item.sourceLabel,
          scope: item.scope,
          enabled: item.enabled,
          installed: item.installed,
          actions: item.actions,
        })),
        issues: snapshot.issues,
        project_trusted: snapshot.projectTrusted,
      };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  };

  const manage: ToolDefinition<typeof ManageParameters, unknown> = {
    name: "skill_manage",
    label: "Skill Manage",
    description:
      "Propose installing, enabling, disabling, updating, or removing a Skill. Every mutation waits for explicit user confirmation.",
    promptSnippet:
      "Use only after identifying a concrete Skill source or catalog item; the user must confirm every change.",
    parameters: ManageParameters,
    executionMode: "sequential",
    async execute(_toolCallId, raw, signal) {
      const manager = options.manager();
      if (raw.action === "install") {
        const source = normalizeSkillInstallSource(required(raw.source, "install requires source"));
        const scope: SkillScope = raw.scope ?? "user";
        const answer = await ask(
          options,
          {
            id: "skill-install",
            title: "安装 Skill",
            prompt: `${displaySource(source)}\nScope ${scope === "project" ? "Project" : "Global"}。安装包只加载 Skill，其他扩展资源保持禁用。`,
            kind: "singleChoice",
            options: [
              { id: "install-enable", label: "安装并启用", description: "保存 Pi 原生包记录并加载发现的 Skill" },
              { id: "install-only", label: "仅安装", description: "保存包记录，但暂不加载任何 Skill" },
              { id: "cancel", label: "取消", description: "不安装、不修改设置" },
            ],
          },
          signal,
        );
        if (answer === "cancel" || answer === undefined) return cancelled();
        const result = await manager.install(source, scope, answer === "install-enable");
        await options.afterMutation?.();
        return succeeded({ action: raw.action, ...result });
      }

      const skill = await findSkill(manager, required(raw.skill_id, `${raw.action} requires skill_id`));
      const accepted = await ask(options, mutationQuestion(raw.action, skill), signal);
      if (accepted !== "confirm") return cancelled();
      if (raw.action === "enable") await manager.setEnabled(skill.id, true, raw.scope ?? "user");
      else if (raw.action === "disable") await manager.setEnabled(skill.id, false);
      else if (raw.action === "update") await manager.update(skill.id);
      else await manager.remove(skill.id);
      await options.afterMutation?.();
      return succeeded({ action: raw.action, skill: skill.name, id: skill.id });
    },
  };

  return [list, manage];
}

function mutationQuestion(action: Exclude<ManageValue["action"], "install">, skill: SkillCatalogItem): Question {
  const labels = {
    enable: ["启用 Skill", "启用", "加入当前 VSPi Skill 目录"],
    disable: ["停用 Skill", "停用", "保留源文件或安装包，仅停止加载"],
    update: ["更新 Skill", "更新", "从已记录的包来源获取更新"],
    remove: ["移除 Skill", "移除", "删除受管包或解除外部路径登记"],
  } as const;
  const [title, label, description] = labels[action];
  const packageRemoval = action === "remove" && skill.packageSource ? "\n将移除该包提供的全部 Skill。" : "";
  return {
    id: `skill-${action}`,
    title,
    prompt: `${skill.name}\n${skill.sourceLabel} · ${skill.scope}${packageRemoval}`,
    kind: "singleChoice",
    options: [
      { id: "confirm", label, description },
      { id: "cancel", label: "取消", description: "不修改 Skill 配置" },
    ],
  };
}

async function findSkill(manager: SkillManager, id: string): Promise<SkillCatalogItem> {
  const skill = (await manager.list()).items.find((item) => item.id === id);
  if (!skill) throw new Error("Skill 不存在或目录已经变化");
  return skill;
}

async function ask(options: SkillToolOptions, question: Question, signal?: AbortSignal): Promise<string | undefined> {
  if (signal?.aborted) throw abortError();
  const pending = options.request([question], signal);
  const answered = signal
    ? await new Promise<Question[]>((resolve, reject) => {
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
      })
    : await pending;
  const answer = answered[0]?.answer;
  return typeof answer === "string" ? answer : undefined;
}

function required(value: string | undefined, message: string): string {
  if (!value?.trim()) throw new Error(message);
  return value.trim();
}

function displaySource(source: string): string {
  if (source.length <= 180) return source;
  return `${source.slice(0, 88)}…${source.slice(-88)}`;
}

function succeeded(details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ status: "success", ...details }) }], details };
}

function cancelled() {
  const details = { status: "cancelled" };
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

function abortError(): Error {
  const error = new Error("Skill operation cancelled");
  error.name = "AbortError";
  return error;
}
