import type { ThinkingCapabilityInput } from '#/kosong/contract/capability';
import { EFFORT_PROFILE_REVISION, type ModelEffortProfile } from '#/kosong/provider/effortProfiles';
import type { ModelRecord } from './model';

export function applyModelEffortProfile(record: ModelRecord, profile: ModelEffortProfile): ModelRecord {
  const thinking: ThinkingCapabilityInput = {
    availability: profile.canDisable ? 'dynamic' : 'always',
    canDisable: profile.canDisable,
    controls: profile.mode === 'toggle' ? ['toggle'] : profile.canDisable ? ['toggle', 'effort'] : ['effort'],
    efforts: profile.mode === 'effort' ? [...profile.efforts] : undefined,
    defaultEffort: profile.mode === 'effort' ? profile.defaultEffort : undefined,
  };
  return {
    ...record,
    thinking,
    supportEfforts: thinking.efforts,
    defaultEffort: thinking.defaultEffort,
    offEffort: undefined,
    effortMapping: Object.fromEntries(profile.efforts.map((level) => [level, level])),
    effortProfileRevision: EFFORT_PROFILE_REVISION,
  };
}
