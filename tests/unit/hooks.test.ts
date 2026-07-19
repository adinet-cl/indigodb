import { HookRegistry } from "../../src/models/hooks";

interface User {
  id: number;
  name: string;
  email: string;
}

describe("HookRegistry", () => {
  test("runBeforeCreate merges partial return values in registration order", async () => {
    const hooks = new HookRegistry<User>();
    hooks.beforeCreate((data) => ({ name: `${data.name}!` }));
    hooks.beforeCreate((data) => ({ email: `${data.name}@x.com` }));

    const result = await hooks.runBeforeCreate({ name: "Ada" });
    expect(result).toEqual({ name: "Ada!", email: "Ada!@x.com" });
  });

  test("runBeforeCreate leaves data unchanged when a hook returns nothing", async () => {
    const hooks = new HookRegistry<User>();
    const seen: Partial<User>[] = [];
    hooks.beforeCreate((data) => {
      seen.push(data);
    });

    const result = await hooks.runBeforeCreate({ name: "Ada" });
    expect(result).toEqual({ name: "Ada" });
    expect(seen).toEqual([{ name: "Ada" }]);
  });

  test("runAfterCreate invokes every hook with the persisted record", async () => {
    const hooks = new HookRegistry<User>();
    const calls: User[] = [];
    hooks.afterCreate((record) => {
      calls.push(record);
    });
    hooks.afterCreate(async (record) => {
      calls.push(record);
    });

    const record = { id: 1, name: "Ada", email: "a@x.com" };
    await hooks.runAfterCreate(record);
    expect(calls).toEqual([record, record]);
  });

  test("runBeforeUpdate passes the id through to every hook", async () => {
    const hooks = new HookRegistry<User>();
    const seenIds: unknown[] = [];
    hooks.beforeUpdate((id, data) => {
      seenIds.push(id);
      return { name: `${data.name}-updated` };
    });

    const result = await hooks.runBeforeUpdate(7, { name: "Ada" });
    expect(seenIds).toEqual([7]);
    expect(result).toEqual({ name: "Ada-updated" });
  });

  test("runBeforeDelete and runAfterDelete run registered hooks", async () => {
    const hooks = new HookRegistry<User>();
    const events: string[] = [];
    hooks.beforeDelete((id) => {
      events.push(`before:${id}`);
    });
    hooks.afterDelete((record) => {
      events.push(`after:${record.id}`);
    });

    await hooks.runBeforeDelete(3);
    await hooks.runAfterDelete({ id: 3, name: "Ada", email: "a@x.com" });
    expect(events).toEqual(["before:3", "after:3"]);
  });

  test("hooks with no registrations are no-ops", async () => {
    const hooks = new HookRegistry<User>();
    await expect(hooks.runBeforeCreate({ name: "Ada" })).resolves.toEqual({
      name: "Ada",
    });
    await expect(hooks.runAfterCreate({} as User)).resolves.toBeUndefined();
  });
});
