export class ConflictError extends Error{constructor(message='记录已被更新，请刷新后重试'){super(message);this.status=409;}}
export function guardStatement(db,actor,action,guard,args=[],operationId=crypto.randomUUID(),request={}){
  return db.prepare(`INSERT INTO system_operations (id,actor_id,action,request_json,guard,created_at) VALUES (?,?,?,?,CASE WHEN (${guard}) THEN 1 ELSE 0 END,?)`).bind(operationId,actor.id,action,JSON.stringify(request),...args,new Date().toISOString());
}
export async function atomicBatch(db,statements){
  try{return await db.batch(statements);}catch(error){if(/system_atomic_guard|CHECK constraint|guard_|exceeds|closed finance|finance period|immutable/i.test(String(error)))throw new ConflictError('记录、库存或结算月份已变化，本次操作未生效，请刷新核对');throw error;}
}
export async function assertWritable(db){
  const lock=await db.prepare("SELECT mode,expires_at FROM system_maintenance WHERE id='global'").first();
  if(lock&&lock.mode!=='normal'&&lock.expires_at>new Date().toISOString())throw new ConflictError('系统正在备份或迁移，暂时停止写入，请稍后重试');
}
