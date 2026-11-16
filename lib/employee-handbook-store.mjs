import {parseHandbook} from './employee-handbook.mjs';
import {assertWritable,atomicBatch,guardStatement,ConflictError} from './atomic.mjs';

const cache=new WeakMap();
const latest='SELECT version,revision FROM employee_handbooks ORDER BY version DESC LIMIT 1';
export async function currentHandbook(db) {
  const last=await db.prepare(latest).first();
  if(!last) return null;
  const stored=cache.get(db);
  if(stored?.revision===last.revision) return stored;
  const row=await db.prepare('SELECT payload FROM employee_handbooks WHERE version=?').bind(last.version).first();
  if(!row) throw Error('Handbook version unavailable');
  const result={...parseHandbook(JSON.parse(row.payload)),revision:last.revision};
  cache.set(db,result);
  return result;
}

export async function importHandbook(db,actor,input,expected) {
  if(actor.role!=='管理员') throw Object.assign(Error('仅管理员可导入员工手册'),{status:403});
  let pack;
  try {pack=parseHandbook(input);} catch {throw Object.assign(Error('手册格式、岗位、入口或条目无效'),{status:400});}
  const payload=JSON.stringify(pack);
  const bytes=new TextEncoder().encode(payload);
  if(bytes.length>256000) throw Object.assign(Error('手册文件过大'),{status:413});
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  const revision=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
  const last=await db.prepare(latest).first();
  if(last?.revision!==revision){
    if((last?.revision||'')!==expected) throw new ConflictError('手册已有新版本，请重新打开助手再核对');
    await assertWritable(db);
    const guard="COALESCE((SELECT MAX(version) FROM employee_handbooks),0)=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND role='管理员' AND active=1) AND NOT EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
    const version=Number(last?.version||0);
    await atomicBatch(db,[guardStatement(db,actor,'employee.handbook.import',guard,[version,actor.id]),
      db.prepare('INSERT INTO employee_handbooks(version,revision,payload,actor_id,created_at) VALUES(?,?,?,?,?)')
        .bind(version+1,revision,payload,actor.id,new Date().toISOString())]);
  }
  return {edition:pack.edition,revision,count:pack.guides.length};
}
