import { createDecorator } from "#/_base/di/instantiation";
import type { Event } from '#/_base/event';
import type { PermissionMode } from '#/agent/permissionPolicy/types';

export interface PermissionModeChangedContext {
  readonly mode: PermissionMode;
  readonly previousMode: PermissionMode;
}

export interface IAgentPermissionModeService {
  readonly _serviceBrand: undefined;

  readonly mode: PermissionMode;
  getMode(): PermissionMode;
  setMode(mode: PermissionMode): void;
  setModeAndBroadcast(mode: PermissionMode): void;
  runWithMode<T>(mode: PermissionMode | undefined, run: () => Promise<T>): Promise<T>;

  readonly onDidChangeMode: Event<PermissionModeChangedContext>;
}

export const IAgentPermissionModeService =
  createDecorator<IAgentPermissionModeService>('agentPermissionModeService');

export function permissionModeForChild(parent: Pick<IAgentPermissionModeService, 'mode' | 'getMode'>): PermissionMode {
  const stored = parent.getMode();
  const effective = parent.mode;
  if (stored === 'auto' && effective === 'auto') return 'auto';
  if (['auto', 'yolo'].includes(stored) && ['auto', 'yolo'].includes(effective)) return 'yolo';
  return 'manual';
}
