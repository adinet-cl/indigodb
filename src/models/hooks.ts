/**
 * Lifecycle hooks. "before" hooks may return a partial payload to merge into
 * the pending data (or return nothing to leave it unchanged); "after" hooks
 * are for side effects and cannot alter the already-persisted record.
 *
 * Hooks only run for single-row operations (create/update/delete). Bulk
 * operations (createMany/updateMany/deleteMany) skip them by default — same
 * convention as Sequelize — to avoid silently re-fetching every affected row.
 */
export type BeforeCreateHook<T> = (
  data: Partial<T>
) => Partial<T> | void | Promise<Partial<T> | void>;
export type AfterCreateHook<T> = (record: T) => void | Promise<void>;
export type BeforeUpdateHook<T> = (
  id: unknown,
  data: Partial<T>
) => Partial<T> | void | Promise<Partial<T> | void>;
export type AfterUpdateHook<T> = (record: T) => void | Promise<void>;
export type BeforeDeleteHook<T> = (id: unknown) => void | Promise<void>;
export type AfterDeleteHook<T> = (record: T) => void | Promise<void>;

export class HookRegistry<T> {
  private readonly beforeCreateHooks: BeforeCreateHook<T>[] = [];
  private readonly afterCreateHooks: AfterCreateHook<T>[] = [];
  private readonly beforeUpdateHooks: BeforeUpdateHook<T>[] = [];
  private readonly afterUpdateHooks: AfterUpdateHook<T>[] = [];
  private readonly beforeDeleteHooks: BeforeDeleteHook<T>[] = [];
  private readonly afterDeleteHooks: AfterDeleteHook<T>[] = [];

  public beforeCreate(hook: BeforeCreateHook<T>): void {
    this.beforeCreateHooks.push(hook);
  }
  public afterCreate(hook: AfterCreateHook<T>): void {
    this.afterCreateHooks.push(hook);
  }
  public beforeUpdate(hook: BeforeUpdateHook<T>): void {
    this.beforeUpdateHooks.push(hook);
  }
  public afterUpdate(hook: AfterUpdateHook<T>): void {
    this.afterUpdateHooks.push(hook);
  }
  public beforeDelete(hook: BeforeDeleteHook<T>): void {
    this.beforeDeleteHooks.push(hook);
  }
  public afterDelete(hook: AfterDeleteHook<T>): void {
    this.afterDeleteHooks.push(hook);
  }

  public async runBeforeCreate(data: Partial<T>): Promise<Partial<T>> {
    let current = data;
    for (const hook of this.beforeCreateHooks) {
      const result = await hook(current);
      if (result) current = { ...current, ...result };
    }
    return current;
  }

  public async runAfterCreate(record: T): Promise<void> {
    for (const hook of this.afterCreateHooks) await hook(record);
  }

  public async runBeforeUpdate(
    id: unknown,
    data: Partial<T>
  ): Promise<Partial<T>> {
    let current = data;
    for (const hook of this.beforeUpdateHooks) {
      const result = await hook(id, current);
      if (result) current = { ...current, ...result };
    }
    return current;
  }

  public async runAfterUpdate(record: T): Promise<void> {
    for (const hook of this.afterUpdateHooks) await hook(record);
  }

  public async runBeforeDelete(id: unknown): Promise<void> {
    for (const hook of this.beforeDeleteHooks) await hook(id);
  }

  public async runAfterDelete(record: T): Promise<void> {
    for (const hook of this.afterDeleteHooks) await hook(record);
  }
}
