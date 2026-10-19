import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'pathe';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IModelHealth, ModelHealthStore, modelHealthSchema } from '#/llm-adapter/model/health';

export class ModelHealthAdapter extends ModelHealthStore {
  private readonly path: string;

  constructor(@IBootstrapService private readonly bootstrap: IBootstrapService) {
    super();
    this.path = join(bootstrap.cacheDir, 'model-health.json');
    try {
      const entries: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (Array.isArray(entries)) {
        for (const entry of entries.slice(-2000)) {
          if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
          const health = modelHealthSchema.safeParse(entry[1]);
          if (health.success) this.records.set(entry[0], health.data);
        }
      }
    } catch {}
  }

  protected override save(): void {
    try {
      mkdirSync(this.bootstrap.cacheDir, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify([...this.records]), { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch {}
  }
}

registerScopedService(LifecycleScope.App, IModelHealth, ModelHealthAdapter, ScopeActivation.OnDemand, 'kosongConfig');
