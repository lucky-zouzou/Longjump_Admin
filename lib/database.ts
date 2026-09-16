import { env } from "cloudflare:workers";

let ready = false;

export function database(): D1Database {
  if (!env.DB) throw new Error("数据库尚未绑定，请确认部署配置中已启用 DB");
  return env.DB;
}

// Drizzle migrations are applied before a deployed Site version becomes active.
// Runtime code refreshes query-planner statistics and never mutates the schema.
export async function ensureSchema() {
  if (ready) return;
  await database().prepare("PRAGMA optimize").run();
  ready = true;
}

export const nowIso = () => new Date().toISOString();
export const makeId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
