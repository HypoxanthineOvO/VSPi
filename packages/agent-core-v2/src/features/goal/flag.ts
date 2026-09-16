import { registerFlagDefinition } from '#/app/flag/flagRegistry';

export const GOAL_RESTART_RECOVERY_FLAG = 'goal_restart_recovery';

registerFlagDefinition({
  id: GOAL_RESTART_RECOVERY_FLAG,
  title: 'Resume active goals after runtime restart',
  description: 'Preserve active goal intent across runtime shutdown and recover it after the host restores the session.',
  env: 'KIMI_CODE_EXPERIMENTAL_GOAL_RESTART_RECOVERY',
  default: false,
  surface: 'core',
});
