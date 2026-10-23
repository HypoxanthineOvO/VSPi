import { registerConfigSection } from '@moonshot-ai/agent-core-v2/app/config/configSectionContributions';

export const ROLE_NAMES = ['explore', 'coder', 'frontend', 'plan', 'reviewer', 'consultant'] as const;
export type RoleName = typeof ROLE_NAMES[number];
export type RoleRouting = Partial<Record<RoleName, { default: string; fast?: string; hard?: string; mid?: string; high?: string }>>;

export const roleRoutingSchema = {
  parse(value: unknown): RoleRouting {
    if (value === undefined) return {};
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('roleRouting must be a role-to-model table');
    const result: RoleRouting = {};
    for (const [role, raw] of Object.entries(value)) {
      if (!ROLE_NAMES.includes(role as RoleName)) throw new Error(`Unknown roleRouting role: ${role}`);
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`roleRouting.${role} must be a tier table`);
      const tiers = raw as Record<string, unknown>;
      const allowed = role === 'frontend' ? ['default', 'fast', 'hard', 'mid', 'high'] : role === 'coder' ? ['default', 'fast', 'hard'] : ['default'];
      for (const [tier, alias] of Object.entries(tiers)) {
        if (!allowed.includes(tier) || typeof alias !== 'string' || alias.trim() === '' || alias === 'primary') throw new Error(`Invalid roleRouting.${role}.${tier}: expected a secondary model pool alias`);
      }
      if (typeof tiers['default'] !== 'string') throw new Error(`roleRouting.${role}.default is required`);
      result[role as RoleName] = { ...tiers } as RoleRouting[RoleName];
    }
    return result;
  },
};

registerConfigSection('roleRouting', roleRoutingSchema, { defaultValue: {} });

export function routingInstructions(routing: RoleRouting, forced: boolean): string {
  const lines = ['Role model routing (new non-fork tasks only):'];
  if (forced) return `${lines[0]} secondary_model.force overrides role routing; omit model.`;
  for (const role of ROLE_NAMES) {
    for (const [tier, alias] of Object.entries(routing[role] ?? {})) lines.push(`- ${role}/${tier} → ${alias}`);
  }
  lines.push('Omit model to use the role default. For coder/frontend mechanical or bulk edits choose fast; routine implementation uses default; difficult features use hard. For frontend visual refinement use mid, demanding visual/video work uses high. Pass the configured alias via the existing model parameter for a non-default tier; never pass a tier name as model. If a tier is not configured use the role default, do not invent an alias. Model capability and installed tools must actually support the requested media work. Fork and resume preserve their existing binding.');
  return lines.join('\n');
}
