import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ScopeActivation } from '#/_base/di/instantiation';
import {
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, TestInstantiationService } from '#/_base/di/test';
import { IFeatureManager } from '#/app/feature/featureManager';
import { FeatureManagerService } from '#/app/feature/featureManagerService';
import { LifecycleScope } from '#/app/scopes';
import { IFeatureAssemblyService } from '#/features/featureAssembly';
import { FeatureAssemblyService } from '#/features/featureAssemblyService';
import {
  _clearFeatureRecipesForTests,
  registerFeature,
} from '#/features/featureRegistry';
import { GoalFeature } from '#/features/goal/goalFeature';
import { IAgentGoalService } from '#/features/goal/goalService';
import { AgentGoalViewService } from '#/features/goal/goalViewService';
import type { GoalSnapshot, GoalToolResult } from '#/features/goal/types';

describe('GoalFeature', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    _clearFeatureRecipesForTests();
    registerScopedService(
      LifecycleScope.App,
      IFeatureManager,
      FeatureManagerService,
      ScopeActivation.OnScopeCreated,
      'feature',
    );
    registerScopedService(
      LifecycleScope.App,
      IFeatureAssemblyService,
      FeatureAssemblyService,
      ScopeActivation.OnScopeCreated,
      'features',
    );
    registerFeature(GoalFeature);
  });

  it('assembles a named, introspectable goal unit', () => {
    const host = createScopedTestHost();
    const manager = host.app.accessor.get(IFeatureManager);
    expect(manager.units().map((unit) => unit.name)).toContain('goal');
    host.dispose();
  });

  it('retracts the goal runtime contribution with the Feature', async () => {
    const host = createScopedTestHost();
    const manager = host.app.accessor.get(IFeatureManager);

    await manager.unprovideUnit('goal');
    await host.app.instantiation.cascade.whenIdle();
    expect(manager.units().map((unit) => unit.name)).not.toContain('goal');

    manager.provideUnit(GoalFeature);
    await host.app.instantiation.cascade.whenIdle();
    expect(manager.units().map((unit) => unit.name)).toContain('goal');

    host.dispose();
  });

  it('returns the current Goal snapshot through the Agent goal view', () => {
    const host = new TestInstantiationService();
    const result: GoalToolResult = {
      goal: {
        goalId: 'goal-1',
        objective: 'Ship the feature',
        status: 'paused',
        turnsUsed: 2,
        tokensUsed: 300,
        wallClockMs: 4_000,
        budget: {
          tokenBudget: null,
          turnBudget: null,
          wallClockBudgetMs: null,
          remainingTokens: null,
          remainingTurns: null,
          remainingWallClockMs: null,
          tokenBudgetReached: false,
          turnBudgetReached: false,
          wallClockBudgetReached: false,
          overBudget: false,
        },
      },
    };
    host.stub(IAgentGoalService, { getGoal: () => result } as IAgentGoalService);
    expect(host.createInstance(AgentGoalViewService).getGoal()).toEqual(result);
    host.dispose();
  });

  it('drives pause, resume, and cancel through the Agent goal view as the user actor', async () => {
    const host = new TestInstantiationService();
    const snapshot = { goalId: 'goal-1' } as unknown as GoalSnapshot;
    const pauseGoal = vi.fn().mockResolvedValue(snapshot);
    const resumeGoal = vi.fn().mockResolvedValue(snapshot);
    const cancelGoal = vi.fn().mockResolvedValue(snapshot);
    host.stub(IAgentGoalService, { pauseGoal, resumeGoal, cancelGoal } as unknown as IAgentGoalService);
    const view = host.createInstance(AgentGoalViewService);

    await expect(view.pauseGoal({ reason: 'hold' })).resolves.toBe(snapshot);
    await expect(view.resumeGoal()).resolves.toBe(snapshot);
    await expect(view.cancelGoal()).resolves.toBe(snapshot);

    expect(pauseGoal).toHaveBeenCalledWith({ reason: 'hold' }, 'user');
    expect(resumeGoal).toHaveBeenCalledWith({}, 'user');
    expect(cancelGoal).toHaveBeenCalledWith({}, 'user');
    host.dispose();
  });
});
