import { createDecorator } from "#/_base/di/instantiation";

export const TOWER_TOOL_NAMES = [
  'TowerPlan',
  'TowerSpawn',
  'TowerMerge',
  'TowerTeardown',
  'TowerSend',
  'TowerInbox',
  'TowerFinding',
  'TowerReview',
  'TowerMission',
  'TowerStatus',
] as const;

export const TOWER_WORKER_PROFILE = 'tower-worker';

export const TOWER_FLAG_ID = 'tower';

export interface TowerMissionProjection {
  readonly id: string;
  readonly title: string;
  readonly kind: 'build' | 'survey';
  readonly status: 'planned' | 'active' | 'completed' | 'blocked' | 'paused' | 'merged' | 'abandoned';
  readonly scope: readonly string[];
  readonly deps: readonly string[];
  readonly owner?: string;
  readonly tasks: readonly { readonly text: string; readonly done: boolean }[];
  readonly blockers: readonly string[];
  readonly workers: readonly { readonly name: string; readonly agentId: string; readonly kind: 'worker' | 'reviewer' }[];
}

export interface IAgentTowerService {
  readonly _serviceBrand: undefined;

  readonly isActive: boolean;
  enter(): Promise<void>;
  exit(): void;
  queryMissions(): Promise<readonly TowerMissionProjection[]>;
  queryActive(): boolean;
}

export const IAgentTowerService = createDecorator<IAgentTowerService>('agentTowerService');
