import { normalizeAgentProfile, type AgentProfile } from '@moonshot-ai/agent-core-v2/app/agentProfileCatalog/agentProfileCatalog';
import type { IBuiltinAgentProfileLoader } from '@moonshot-ai/agent-core-v2/app/agentProfileCatalog/builtinAgentProfileLoader';
import { renderSystemPromptResult, TASK_AGENT_ROLE_PREFIX } from '@moonshot-ai/agent-core-v2/app/agentProfileCatalog/profile-shared';
import type { IConfigService } from '@moonshot-ai/agent-core-v2/app/config/config';
import { ROLE_NAMES, routingInstructions, type RoleRouting } from './config.js';

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'ReadMediaFile', 'WebSearch', 'FetchURL', 'NotifyUser'];
const WRITE_TOOLS = [...READ_TOOLS, 'Write', 'Edit', 'Bash', 'TaskList', 'TaskOutput', 'TaskStop', 'WaitFor', 'TodoList', 'Skill', 'EnterPlanMode', 'ExitPlanMode'];
const HANDOFF = `${TASK_AGENT_ROLE_PREFIX}\nAll roles are leaves: never delegate to another agent. Your final message is the entire handoff to the parent: conclusion, files and line references, evidence or verification commands and results, and anything incomplete. Use natural language, not JSON or a result schema.`;
const READ_GIT = 'You are read-only. Bash is available only for read-only git log, blame, show, diff and status. Never write files, change git state, run builds/tests, execute scripts, use network commands, or invoke external diff/textconv helpers; use --no-ext-diff --no-textconv for diff/show. Use Read/Grep/Glob for all file inspection. This is a prompt constraint, not a shell sandbox.';
const POLICY = 'Choose and launch the matching subagent automatically without asking the user to assign roles or models. Delegate code investigation, evidence gathering and call-chain tracing to explore, backend/packaging/general implementation and mechanical edits to coder, frontend/visual/video implementation to frontend, and requested change review to reviewer. This includes small mechanical edits and short call chains: do not perform the delegated task yourself instead. The main agent coordinates, supplies boundaries and verifies results. Use plan as the default technical planning and architecture role. Use consultant ONLY for disagreement about user intent or product requirements, material trade-offs between alternatives, or an explicit user request. Do not routinely call both plan and consultant. Give each task its scope, completion criteria and boundaries; verify the final natural-language handoff. Do not automatically launch a reviewer after implementation.';

export function createRoleProfiles(builtin: IBuiltinAgentProfileLoader, config: IConfigService): AgentProfile[] {
  const main = builtin.getDefault();
  const profile = (name: string, description: string, whenToUse: string, tools: readonly string[], role: string) => normalizeAgentProfile({
    name, description, whenToUse, tools, override: true, subagents: [],
    renderSystemPrompt: context => renderSystemPromptResult(`${HANDOFF}\n\n${role}`, context, { skillActive: tools.includes('Skill') }),
  });
  const plan = builtin.get('plan')!;
  return [
    normalizeAgentProfile({
      ...main, override: true, subagents: ROLE_NAMES,
      renderSystemPrompt: context => {
        const result = main.renderSystemPrompt(context);
        return { ...result, text: `${result.text}\n\n${POLICY}\n\n${routingInstructions(config.get<RoleRouting>('roleRouting'), config.get<{ force?: boolean }>('secondaryModel')?.force === true)}` };
      },
    }),
    profile('explore', 'Read-only code investigation and call-chain tracing.', 'Use for finding code, collecting evidence and tracing calls, especially unknown paths or more than three searches. Specify quick, medium or thorough scope.', [...READ_TOOLS, 'Bash'], `${READ_GIT}\nTrace concrete callers and consumers. Bound the search to the task; after empty searches change naming or location strategy. Distinguish confirmed evidence from hypotheses and return a concise map with file:line references and remaining gaps.`),
    profile('coder', 'Backend, packaging, general implementation and bulk edits.', 'Use after requirements are confirmed for backend, packaging, general software implementation or mechanical/bulk modifications. Frontend and visual work belongs to frontend.', WRITE_TOOLS, 'Implement the assigned scope completely using the surrounding conventions. Run the relevant existing checks and exercise the actual entry point. Do not claim unverified work is done. Avoid unrelated changes.'),
    profile('frontend', 'Frontend, visual and video implementation.', 'Use for frontend pages, interaction, visual refinement and video implementation. Select the configured tier by difficulty and visual demands.', WRITE_TOOLS, 'Implement the confirmed UI or media task using the existing stack and available skills/tools. Preserve unrelated behavior and verify the real rendered or media result; do not assume a model alias grants media tools or capabilities.'),
    normalizeAgentProfile({ ...plan, override: true, subagents: [] }),
    profile('reviewer', 'Read-only review of changed behavior and concrete defects.', 'Use when asked to review a diff or code change. Examine behavior changes and actionable defects; no automatic review relay.', [...READ_TOOLS, 'Bash'], `${READ_GIT}\nInventory changed behavior, removed branches/defaults and affected consumers. Report only concrete, actionable defects introduced by the change, with severity, file:line, triggering input and evidence. Trace across boundaries before claiming a failure. Distinguish intentional changes from defects, prioritize actual impact, avoid speculative defensive requirements and style-only findings. Security review must trace attacker-controlled input to a missing check or dangerous sink without executing payloads. State checks not run and report explicitly when no defects are found.`),
    profile('consultant', 'Read-only user-intent and product trade-off consultation.', 'Use ONLY when user intent or requirements are disputed, alternatives require material product trade-offs, or the user explicitly asks for consultation. Not routine technical planning: use plan by default, and do not call consultant after every plan.', READ_TOOLS, 'Clarify the actual user goal, assumptions and competing product choices. Challenge the proposed approach with relevant counterexamples and recommend a proportionate choice. Do not write code or replace technical planning/code review. Return advice and trade-offs to the parent, not direct questions to the user.'),
  ];
}
