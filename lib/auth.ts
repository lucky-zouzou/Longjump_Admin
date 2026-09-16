import { getChatGPTUser } from "../app/chatgpt-auth";
import { database, ensureSchema, nowIso } from "./database";

export const ROLES = ["管理员", "销售", "运营", "运营主管", "新品开发", "财务", "供应链", "工厂", "海运"] as const;
export type Role = (typeof ROLES)[number];
export type Actor = { id:string; email:string; name:string; role:Role; site:string|null; channel:string|null; active:boolean };

export async function requireActor(request: Request): Promise<Actor> {
  await ensureSchema();
  const url = new URL(request.url);
  const local = process.env.NODE_ENV === "development" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  const signedIn = await getChatGPTUser();
  if (!signedIn && !local) throw new HttpError(401, "请先登录 ChatGPT");
  const localTestUser=local?String(request.headers.get("x-local-test-user")??"").trim().slice(0,80):"";
  const identity = signedIn ?? (localTestUser
    ? { userId:localTestUser, email:`${localTestUser}@loongjump.local`, displayName:`本地测试 ${localTestUser}` }
    : { userId:"local-admin", email:"admin@loongjump.local", displayName:"本地管理员" });
  const db = database();
  let row = await db.prepare("SELECT * FROM users WHERE id = ?").bind(identity.userId).first<Record<string, unknown>>();
  if (!row) {
    const timestamp = nowIso();
    await db.prepare(`INSERT INTO users (id,email,name,role,site,channel,active,created_at,updated_at)
      VALUES (?,?,?,CASE WHEN (SELECT COUNT(*) FROM users)=0 THEN '管理员' ELSE '运营' END,?,?,1,?,?)`)
      .bind(identity.userId, identity.email, identity.displayName, null, null, timestamp, timestamp).run();
    row = await db.prepare("SELECT * FROM users WHERE id = ?").bind(identity.userId).first<Record<string, unknown>>();
  } else if (row.email !== identity.email || row.name !== identity.displayName) {
    await db.prepare("UPDATE users SET email=?, name=?, updated_at=? WHERE id=?")
      .bind(identity.email, identity.displayName, nowIso(), identity.userId).run();
    row = { ...row, email:identity.email, name:identity.displayName };
  }
  if (!row || Number(row.active) !== 1) throw new HttpError(403, "账号已停用，请联系管理员");
  return { id:String(row.id), email:String(row.email), name:String(row.name), role:row.role as Role, site:row.site ? String(row.site) : null, channel:row.channel ? String(row.channel) : null, active:true };
}

export function requireRole(actor: Actor, roles: Role[]) {
  if (!roles.includes(actor.role)) throw new HttpError(403, "当前账号没有执行此操作的权限");
}
export function requireScope(actor: Actor, site: string, channel: string) {
  if (actor.role === "运营" && (actor.site !== site || actor.channel !== channel)) {
    throw new HttpError(403, "运营账号只能操作本人负责的站点和渠道");
  }
}
export class HttpError extends Error {
  constructor(public status:number, message:string) { super(message); }
}
