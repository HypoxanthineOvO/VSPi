import { decodeKittyPrintable, Key, type KeyId, matchesKey } from "@earendil-works/pi-tui";

export type InteractionSurface = "panel" | "composer" | "inspect";

export interface InteractionState {
  hasItems?: boolean;
  commandAvailable?: boolean;
  narrowModel?: boolean;
  busy?: boolean;
  hasMessages?: boolean;
  composerEmpty?: boolean;
  commandCompletable?: boolean;
  selectedAttachment?: boolean;
  cancellable?: boolean;
  retryable?: boolean;
  expandable?: boolean;
  providerEditing?: boolean;
  providerActionMenu?: boolean;
  providerField?: 0 | 1 | 2;
  providerTextPresent?: boolean;
  policyYolo?: boolean;
  questionMode?: "choice" | "ranking" | "freeText" | "review";
}

export interface InteractionDefinition {
  id: string;
  surface: InteractionSurface;
  context: string;
  keys: readonly string[];
  matches: (input: string, state?: unknown) => boolean;
  handler: string;
  hint: (state?: unknown) => string | undefined;
}

type StatePredicate = (state: InteractionState) => boolean;
type HintFactory = (state: InteractionState) => string | undefined;

function stateOf(state: unknown): InteractionState {
  return state && typeof state === "object" ? (state as InteractionState) : {};
}

function keyAction(input: {
  id: string;
  surface: InteractionSurface;
  context: string;
  keys: readonly string[];
  keyValues: readonly KeyId[];
  handler: string;
  enabled?: StatePredicate;
  hint?: string | HintFactory;
}): InteractionDefinition {
  const enabled = input.enabled ?? (() => true);
  return {
    id: input.id,
    surface: input.surface,
    context: input.context,
    keys: input.keys,
    matches: (value, state) => enabled(stateOf(state)) && input.keyValues.some((key) => matchesKey(value, key)),
    handler: input.handler,
    hint: (state) => {
      const current = stateOf(state);
      if (!enabled(current)) return undefined;
      return typeof input.hint === "function" ? input.hint(current) : input.hint;
    },
  };
}

function inputAction(input: {
  id: string;
  surface: InteractionSurface;
  context: string;
  keys: readonly string[];
  handler: string;
  matcher: (value: string) => boolean;
  enabled?: StatePredicate;
  hint?: string | HintFactory;
}): InteractionDefinition {
  const enabled = input.enabled ?? (() => true);
  return {
    id: input.id,
    surface: input.surface,
    context: input.context,
    keys: input.keys,
    matches: (value, state) => enabled(stateOf(state)) && input.matcher(value),
    handler: input.handler,
    hint: (state) => {
      const current = stateOf(state);
      if (!enabled(current)) return undefined;
      return typeof input.hint === "function" ? input.hint(current) : input.hint;
    },
  };
}

const hasItems: StatePredicate = (state) => state.hasItems === true;
const printable = (value: string): boolean => {
  if (value.length === 0) return false;
  if (decodeKittyPrintable(value)) return true;
  return !Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
};

const actions: InteractionDefinition[] = [
  keyAction({
    id: "panel.plan.move",
    surface: "panel",
    context: "plan",
    keys: ["Up", "Down"],
    keyValues: [Key.up, Key.down],
    handler: "moveSelection",
    enabled: hasItems,
    hint: "↑↓ 选择",
  }),
  keyAction({
    id: "panel.plan.fold",
    surface: "panel",
    context: "plan",
    keys: ["Left", "Right", "Enter"],
    keyValues: [Key.left, Key.right, Key.enter],
    handler: "togglePlanItem",
    enabled: hasItems,
    hint: "←→ 折叠/展开  Enter 操作",
  }),
  keyAction({
    id: "panel.plan.focus",
    surface: "panel",
    context: "plan",
    keys: ["Shift+Tab"],
    keyValues: [Key.shift("tab")],
    handler: "togglePlanFocus",
    hint: "Shift+Tab 切换焦点",
  }),
  keyAction({
    id: "panel.commands.move",
    surface: "panel",
    context: "commands",
    keys: ["Up", "Down"],
    keyValues: [Key.up, Key.down],
    handler: "moveSelection",
    enabled: hasItems,
    hint: "↑↓ 选择",
  }),
  keyAction({
    id: "panel.commands.complete",
    surface: "panel",
    context: "commands",
    keys: ["Tab"],
    keyValues: [Key.tab],
    handler: "completeCommand",
    hint: "Tab 补全",
  }),
  keyAction({
    id: "panel.commands.activate",
    surface: "panel",
    context: "commands",
    keys: ["Enter"],
    keyValues: [Key.enter],
    handler: "activateCommand",
    enabled: hasItems,
    hint: (state) => (state.commandAvailable === false ? "Enter 查看不可用原因" : "Enter 执行"),
  }),
  keyAction({
    id: "panel.commands.close",
    surface: "panel",
    context: "commands",
    keys: ["Escape"],
    keyValues: [Key.escape],
    handler: "closePanel",
    hint: "Esc 关闭",
  }),
  keyAction({
    id: "panel.sessions.move",
    surface: "panel",
    context: "sessions",
    keys: ["Up", "Down"],
    keyValues: [Key.up, Key.down],
    handler: "moveSelection",
    enabled: hasItems,
    hint: "↑↓ 选择",
  }),
  keyAction({
    id: "panel.sessions.open",
    surface: "panel",
    context: "sessions",
    keys: ["Enter"],
    keyValues: [Key.enter],
    handler: "openSession",
    enabled: hasItems,
    hint: "Enter 打开",
  }),
  keyAction({
    id: "panel.sessions.fork",
    surface: "panel",
    context: "sessions",
    keys: ["Shift+F"],
    keyValues: [Key.shift("f")],
    handler: "forkSession",
    enabled: hasItems,
    hint: "Shift+F 创建分支",
  }),
  keyAction({
    id: "panel.sessions.close",
    surface: "panel",
    context: "sessions",
    keys: ["Escape"],
    keyValues: [Key.escape],
    handler: "closePanel",
    hint: "Esc 关闭",
  }),
  ...(["models", "settings", "theme", "policy"] as const).map((context) =>
    keyAction({
      id: `panel.${context}.move`,
      surface: "panel",
      context,
      keys: ["Up", "Down"],
      keyValues: [Key.up, Key.down],
      handler: "moveSelection",
      hint: "↑↓ 选择",
    }),
  ),
  keyAction({
    id: "panel.models.switch",
    surface: "panel",
    context: "models",
    keys: ["Tab"],
    keyValues: [Key.tab],
    handler: "switchModelView",
    hint: "Tab 切换视图",
  }),
  keyAction({
    id: "panel.models.detail",
    surface: "panel",
    context: "models",
    keys: ["Left", "Right"],
    keyValues: [Key.left, Key.right],
    handler: "showModelDetail",
    enabled: (state) => state.narrowModel === true,
    hint: "←→ 详情",
  }),
  keyAction({
    id: "panel.models.select",
    surface: "panel",
    context: "models",
    keys: ["Enter"],
    keyValues: [Key.enter],
    handler: "selectModel",
    hint: "Enter 确认",
  }),
  keyAction({
    id: "panel.policy.select",
    surface: "panel",
    context: "policy",
    keys: ["Enter"],
    keyValues: [Key.enter],
    handler: "selectPolicy",
    hint: (state) => (stateOf(state).policyYolo === true ? "Enter 确认 YOLO" : "Enter 切换"),
  }),
  inputAction({
    id: "panel.models.search",
    surface: "panel",
    context: "models",
    keys: ["Text", "Backspace"],
    handler: "editModelSearch",
    matcher: (value) => printable(value) || matchesKey(value, Key.backspace),
  }),
  keyAction({
    id: "panel.providers.list-move",
    surface: "panel",
    context: "providers",
    keys: ["Up", "Down"],
    keyValues: [Key.up, Key.down],
    handler: "moveSelection",
    enabled: (state) => state.providerEditing !== true,
    hint: "↑↓ 选择",
  }),
  keyAction({
    id: "panel.providers.activate",
    surface: "panel",
    context: "providers",
    keys: ["Enter"],
    keyValues: [Key.enter],
    handler: "activateProvider",
    enabled: (state) => state.providerEditing !== true,
    hint: (state) => (state.providerActionMenu === true ? "Enter 选择操作" : "Enter 打开操作"),
  }),
  keyAction({
    id: "panel.providers.edit-up",
    surface: "panel",
    context: "providers",
    keys: ["Up"],
    keyValues: [Key.up],
    handler: "moveSelection",
    enabled: (state) => state.providerEditing === true && state.providerField !== 0,
    hint: "↑ 上一项",
  }),
  keyAction({
    id: "panel.providers.edit-down",
    surface: "panel",
    context: "providers",
    keys: ["Down"],
    keyValues: [Key.down],
    handler: "moveSelection",
    enabled: (state) => state.providerEditing === true && state.providerField !== 2,
    hint: "↓ 下一项",
  }),
  inputAction({
    id: "panel.providers.edit-text",
    surface: "panel",
    context: "providers",
    keys: ["Text"],
    handler: "editProvider",
    matcher: printable,
    enabled: (state) => state.providerEditing === true && state.providerField !== 2,
    hint: "输入文字",
  }),
  keyAction({
    id: "panel.providers.edit-backspace",
    surface: "panel",
    context: "providers",
    keys: ["Backspace"],
    keyValues: [Key.backspace],
    handler: "editProvider",
    enabled: (state) =>
      state.providerEditing === true && state.providerField !== 2 && state.providerTextPresent === true,
    hint: "Backspace 删除",
  }),
  keyAction({
    id: "panel.providers.edit-protocol",
    surface: "panel",
    context: "providers",
    keys: ["Left", "Right"],
    keyValues: [Key.left, Key.right],
    handler: "editProviderProtocol",
    enabled: (state) => state.providerEditing === true && state.providerField === 2,
    hint: "←→ 切换协议",
  }),
  keyAction({
    id: "panel.providers.save",
    surface: "panel",
    context: "providers",
    keys: ["Ctrl+S"],
    keyValues: [Key.ctrl("s")],
    handler: "saveProvider",
    enabled: (state) => state.providerEditing === true,
    hint: "Ctrl+S 保存",
  }),
  keyAction({
    id: "panel.providers.close",
    surface: "panel",
    context: "providers",
    keys: ["Escape"],
    keyValues: [Key.escape],
    handler: "closePanel",
    hint: (state) => (state.providerEditing === true ? "Esc 取消" : "Esc 关闭"),
  }),
  keyAction({
    id: "panel.settings.scope",
    surface: "panel",
    context: "settings",
    keys: ["Tab", "Left", "Right"],
    keyValues: [Key.tab, Key.left, Key.right],
    handler: "switchSettingsScope",
    hint: "Tab 切换范围",
  }),
  keyAction({
    id: "panel.settings.edit",
    surface: "panel",
    context: "settings",
    keys: ["Enter", "Space"],
    keyValues: [Key.enter, Key.space],
    handler: "editSetting",
    hint: "Enter 修改",
  }),
  keyAction({
    id: "panel.theme.select",
    surface: "panel",
    context: "theme",
    keys: ["Enter"],
    keyValues: [Key.enter],
    handler: "selectTheme",
    hint: "Enter 确认",
  }),
  inputAction({
    id: "panel.question.answer",
    surface: "panel",
    context: "question",
    keys: [
      "Tab",
      "Enter",
      "Shift+S",
      "Left",
      "Right",
      "Up",
      "Down",
      "Ctrl+Up",
      "Ctrl+Down",
      "Alt+Up",
      "Alt+Down",
      "Space",
      "Text",
    ],
    handler: "answerQuestion",
    matcher: () => true,
    hint: (state) => {
      if (state.questionMode === "review") return "Enter 提交  ← 返回";
      if (state.questionMode === "freeText") return "Enter 确认  ←→ 切题  Shift+S 跳过";
      if (state.questionMode === "ranking") return "↑↓ 选择  Ctrl/Alt+↑↓ 重排  Enter 确认  ←→ 切题  Shift+S 跳过";
      return "↑↓ 选择  Space 多选  Tab 直接回答  Enter 确认  ←→ 切题  Shift+S 跳过";
    },
  }),
  ...(["models", "settings", "usage", "theme", "question", "policy"] as const).map((context) =>
    keyAction({
      id: `panel.${context}.close`,
      surface: "panel",
      context,
      keys: ["Escape"],
      keyValues: [Key.escape],
      handler: "closePanel",
      hint: "Esc 关闭",
    }),
  ),
  keyAction({
    id: "composer.cancel",
    surface: "composer",
    context: "main",
    keys: ["Ctrl+C"],
    keyValues: [Key.ctrl("c")],
    handler: "cancelOrExit",
  }),
  keyAction({
    id: "composer.paste-image",
    surface: "composer",
    context: "main",
    keys: ["Ctrl+V", "Alt+V"],
    keyValues: [Key.ctrl("v"), Key.alt("v")],
    handler: "pasteAttachment",
  }),
  keyAction({
    id: "composer.follow-up",
    surface: "composer",
    context: "main",
    keys: ["Alt+Enter"],
    keyValues: [Key.alt("enter")],
    handler: "submitFollowUp",
  }),
  keyAction({
    id: "composer.inspect",
    surface: "composer",
    context: "main",
    keys: ["Tab"],
    keyValues: [Key.tab],
    handler: "enterInspect",
    enabled: (state) => state.composerEmpty === true && state.hasMessages === true,
  }),
  keyAction({
    id: "composer.command-complete",
    surface: "composer",
    context: "main",
    keys: ["Tab"],
    keyValues: [Key.tab],
    handler: "completeCommand",
    enabled: (state) => state.commandCompletable === true,
  }),
  keyAction({
    id: "composer.plan-focus",
    surface: "composer",
    context: "main",
    keys: ["Shift+Tab"],
    keyValues: [Key.shift("tab")],
    handler: "togglePlanFocus",
  }),
  inputAction({
    id: "composer.edit",
    surface: "composer",
    context: "main",
    keys: ["Text", "Editing keys"],
    handler: "editComposer",
    matcher: () => true,
  }),
  keyAction({
    id: "composer.attachment-left",
    surface: "composer",
    context: "attachment",
    keys: ["Left"],
    keyValues: [Key.left],
    handler: "moveAttachmentLeft",
  }),
  keyAction({
    id: "composer.attachment-right",
    surface: "composer",
    context: "attachment",
    keys: ["Right"],
    keyValues: [Key.right],
    handler: "moveAttachmentRight",
  }),
  keyAction({
    id: "composer.attachment-remove",
    surface: "composer",
    context: "attachment",
    keys: ["Backspace", "Delete"],
    keyValues: [Key.backspace, Key.delete],
    handler: "removeAttachment",
  }),
  keyAction({
    id: "composer.attachment-rename",
    surface: "composer",
    context: "attachment",
    keys: ["F2"],
    keyValues: [Key.f2],
    handler: "renameAttachment",
  }),
  keyAction({
    id: "composer.attachment-preview",
    surface: "composer",
    context: "attachment",
    keys: ["F3"],
    keyValues: [Key.f3],
    handler: "previewAttachment",
  }),
  keyAction({
    id: "composer.attachment-save",
    surface: "composer",
    context: "attachment",
    keys: ["F4"],
    keyValues: [Key.f4],
    handler: "saveAttachment",
  }),
  keyAction({
    id: "composer.preview-close",
    surface: "composer",
    context: "preview",
    keys: ["Escape"],
    keyValues: [Key.escape],
    handler: "closePreview",
  }),
  keyAction({
    id: "composer.rename-cancel",
    surface: "composer",
    context: "rename",
    keys: ["Escape"],
    keyValues: [Key.escape],
    handler: "cancelRename",
  }),
  keyAction({
    id: "composer.rename-delete",
    surface: "composer",
    context: "rename",
    keys: ["Backspace"],
    keyValues: [Key.backspace],
    handler: "deleteRenameCharacter",
  }),
  keyAction({
    id: "composer.rename-commit",
    surface: "composer",
    context: "rename",
    keys: ["Enter"],
    keyValues: [Key.enter],
    handler: "commitRename",
  }),
  inputAction({
    id: "composer.rename-edit",
    surface: "composer",
    context: "rename",
    keys: ["Text"],
    handler: "editRename",
    matcher: printable,
  }),
  keyAction({
    id: "inspect.close",
    surface: "inspect",
    context: "transcript",
    keys: ["Escape", "Tab"],
    keyValues: [Key.escape, Key.tab],
    handler: "closeInspect",
    hint: "Esc 关闭",
  }),
  keyAction({
    id: "inspect.move",
    surface: "inspect",
    context: "transcript",
    keys: ["Up", "Down"],
    keyValues: [Key.up, Key.down],
    handler: "moveInspect",
    enabled: hasItems,
    hint: "↑↓ 选择",
  }),
  keyAction({
    id: "inspect.toggle",
    surface: "inspect",
    context: "transcript",
    keys: ["Left", "Right", "Enter"],
    keyValues: [Key.left, Key.right, Key.enter],
    handler: "toggleInspectItem",
    enabled: (state) => state.hasItems === true && state.expandable !== false,
    hint: "←→ 折叠/展开",
  }),
];

export const INTERACTION_REGISTRY = {
  schemaVersion: "1" as const,
  actions,
};

export function matchingInteraction(
  surface: InteractionSurface,
  context: string,
  input: string,
  state: InteractionState = {},
): InteractionDefinition | undefined {
  return INTERACTION_REGISTRY.actions.find(
    (action) => action.surface === surface && action.context === context && action.matches(input, state),
  );
}

export function matchesInteraction(
  surface: InteractionSurface,
  context: string,
  handler: string,
  input: string,
  state: InteractionState = {},
): boolean {
  return INTERACTION_REGISTRY.actions.some(
    (action) =>
      action.surface === surface &&
      action.context === context &&
      action.handler === handler &&
      action.matches(input, state),
  );
}

export function renderInteractionHint(
  surface: InteractionSurface,
  context: string,
  state: InteractionState = {},
): string {
  const fragments = INTERACTION_REGISTRY.actions
    .filter((action) => action.surface === surface && action.context === context)
    .map((action) => action.hint(state))
    .filter((hint): hint is string => Boolean(hint));
  return [...new Set(fragments)].join("  ");
}
