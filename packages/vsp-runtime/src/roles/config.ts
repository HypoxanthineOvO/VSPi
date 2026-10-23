import { registerConfigSection } from '@moonshot-ai/agent-core-v2/app/config/configSectionContributions';

export const ROLE_NAMES = ['explore', 'coder', 'frontend', 'plan', 'reviewer', 'consultant'] as const;
export type RoleName = typeof ROLE_NAMES[number];
export type RoleRouting = Partial<Record<RoleName, { default: string; fast?: string; hard?: string; mid?: string; high?: string }>> & { fallback?: Record<string, string[]> };

export const roleRoutingSchema = {
  parse(value: unknown): RoleRouting {
    if (value === undefined) return {};
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('roleRouting must be a role-to-model table');
    const result: RoleRouting = {};
    for (const [role, raw] of Object.entries(value)) {
      if (role === 'fallback') {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('roleRouting.fallback must be an alias-to-list table');
        const fallback: Record<string, string[]> = {};
        for (const [alias, candidates] of Object.entries(raw)) {
          if (!alias.trim() || alias === 'primary' || !Array.isArray(candidates) || candidates.some(candidate => typeof candidate !== 'string' || !candidate.trim() || candidate === 'primary')) throw new Error(`Invalid roleRouting.fallback.${alias}`);
          fallback[alias] = [...new Set(candidates as string[])];
        }
        result.fallback = fallback;
        continue;
      }
      if (!ROLE_NAMES.includes(role as RoleName)) throw new Error(`Unknown roleRouting role: ${role}`);
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`roleRouting.${role} must be a tier table`);
      const tiers = raw as Record<string, unknown>;
      const allowed = role === 'frontend' ? ['default', 'mid', 'high'] : role === 'coder' || role === 'explore' ? ['default', 'fast', 'hard'] : ['default'];
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
  for (const [alias, candidates] of Object.entries(routing.fallback ?? {})) lines.push(`- fallback ${alias} → ${candidates.join(' → ') || '(none)'}`);
  lines.push('Use RoleRouting to read the latest table before choosing a tier or changing routing. Its latest output supersedes this startup snapshot. Omit model to use the role default. For explore/coder use fast for simple or bulk work, default for routine work, hard for difficult work. Frontend uses default for routine work, mid for visual refinement, high for demanding visual/video work. Pass the configured alias via model for a non-default tier; never pass a tier name or invent an alias. If a tier is absent use the role default. Only configured in-pool fallbacks may be selected before spawn; failures during a task never switch models. Report binding notices to the user. Model capability and installed tools must support the requested media work. Fork and resume preserve their existing binding.');
  return lines.join('\n');
}
