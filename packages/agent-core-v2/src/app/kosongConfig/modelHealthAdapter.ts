import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'pathe';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IModelHealth, ModelHealthStore, modelHealthSchema } from '#/llm-adapter/model/health';

export class ModelHealthAdapter extends ModelHealthStore {
  private readonly path: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing = false;
  private dirty = false;

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
      this.didPersist([...this.records]);
    } catch {}
  }

  protected override save(): void {
    this.dirty = true;
    if (this.timer !== undefined || this.writing) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.persist();
    }, 100);
    this.timer.unref();
  }

  private async persist(): Promise<void> {
    this.dirty = false;
    if (!this.needsPersistence()) return;
    this.writing = true;
    const entries = [...this.records];
    try {
      await mkdir(this.bootstrap.cacheDir, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(entries), { mode: 0o600 });
      await rename(temporary, this.path);
      this.didPersist(entries);
    } catch {} finally {
      this.writing = false;
      if (this.dirty && this.needsPersistence()) this.save();
    }
  }
}

registerScopedService(LifecycleScope.App, IModelHealth, ModelHealthAdapter, ScopeActivation.OnDemand, 'kosongConfig');
