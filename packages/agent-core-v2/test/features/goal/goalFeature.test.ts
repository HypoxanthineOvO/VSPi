import { beforeEach, describe, expect, it } from 'vitest';

import { ScopeActivation } from '#/_base/di/instantiation';
import {
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
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
import { IAgentGoalViewService } from '#/features/goal/goalView';
import type { GoalToolResult } from '#/features/goal/types';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

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
    const host = createScopedTestHost();
    const agentScope = makeAgentScopeContext({ agentId: 'main', agentScope: 'agents/main' });
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
    const session = host.child(LifecycleScope.Session, 'session-1', [
      stubPair(IAgentLifecycleService, {
        resolve: () => ({ getGoal: () => result }),
      } as unknown as IAgentLifecycleService),
    ]);
    const agent = host.childOf(session, LifecycleScope.Agent, 'main', [
      stubPair(IAgentScopeContext, agentScope),
    ]);

    expect(agent.accessor.get(IAgentGoalViewService).getGoal()).toEqual(result);
    host.dispose();
  });
});
