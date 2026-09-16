import {createHash} from 'node:crypto';
import {ConflictError} from './atomic.mjs';
const enc=new TextEncoder(),quote=s=>'"'+s.replaceAll('"','""')+'"';
function header(path,size){const b=new Uint8Array(512);const set=(offset,length,text)=>b.set(enc.encode(text).slice(0,length),offset);set(0,100,path);set(100,8,'0000600\0');set(108,8,'0000000\0');set(116,8,'0000000\0');set(124,12,size.toString(8).padStart(11,'0')+'\0');set(136,12,Math.floor(Date.now()/1000).toString(8).padStart(11,'0')+'\0');set(148,8,'        ');set(156,1,'0');set(257,6,'ustar\0');set(263,2,'00');set(148,8,b.reduce((s,n)=>s+n,0).toString(8).padStart(6,'0')+'\0 ');return b;}
const sha=b=>createHash('sha256').update(b).digest('hex');
export async function acquireBackup(db,actor){
 const token=crypto.randomUUID(),hash=sha(token),now=new Date().toISOString(),until=new Date(Date.now()+180000).toISOString();
 const results=await db.batch([db.prepare("INSERT INTO system_maintenance (id,mode,token_hash,actor_id,expires_at,updated_at) VALUES ('global','backup',?,?,?,?) ON CONFLICT(id) DO UPDATE SET mode='backup',token_hash=excluded.token_hash,actor_id=excluded.actor_id,expires_at=excluded.expires_at,updated_at=excluded.updated_at WHERE system_maintenance.mode='normal' OR system_maintenance.expires_at<=?").bind(hash,actor.id,until,now,now)]);
 if(results[0].meta.changes!==1)throw new ConflictError('已有备份或迁移正在进行');return hash;
}
export async function backupStream(db,bucket,actor,releaseMigrations=[]){
 const token=await acquireBackup(db,actor),manifest={format:'loongjump-backup-v1',createdAt:new Date().toISOString(),releaseMigrations,tables:[],files:[],entries:[]};let finished=false,lastRenew=0;
 const unlock=async()=>{if(finished)return;finished=true;await db.prepare("UPDATE system_maintenance SET mode='normal',token_hash='',expires_at='',updated_at=? WHERE id='global' AND token_hash=?").bind(new Date().toISOString(),token).run();};
 const renew=async()=>{if(Date.now()-lastRenew<30000)return;const now=new Date().toISOString();const r=await db.prepare("UPDATE system_maintenance SET expires_at=?,updated_at=? WHERE id='global' AND token_hash=? AND expires_at>?").bind(new Date(Date.now()+180000).toISOString(),now,token,now).run();if(r.meta.changes!==1)throw Error('备份锁已失效，请重新导出');lastRenew=Date.now();};
 async function* entry(path,size,chunks){yield header(path,size);const h=createHash('sha256');let actual=0;for await(const chunk of chunks){await renew();actual+=chunk.length;h.update(chunk);yield chunk;}if(actual!==size)throw Error('备份文件长度不一致');const padding=(512-size%512)%512;if(padding)yield new Uint8Array(padding);manifest.entries.push({path,size,sha256:h.digest('hex')});}
 async function* content(){try{
  await renew();const schema=(await db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT IN ('d1_migrations','__drizzle_migrations','local_migrations','local_sessions','local_login_attempts') ORDER BY name").all()).results;
  const meta=enc.encode(JSON.stringify({schema}));yield*entry('schema.json',meta.length,[meta]);
  for(const table of schema){const columns=(await db.prepare(`PRAGMA table_info(${quote(table.name)})`).all()).results.map(c=>c.name);let offset=0,page=0,count=0;const paths=[];
   for(;;){await renew();const rows=(await db.prepare(`SELECT * FROM ${quote(table.name)} ORDER BY rowid LIMIT 250 OFFSET ?`).bind(offset).all()).results;if(!rows.length)break;
    if(table.name==='system_maintenance')for(const r of rows){r.mode='normal';r.token_hash='';r.expires_at='';}
    const path=`tables/${table.name}/${String(page++).padStart(8,'0')}.json`,bytes=enc.encode(JSON.stringify(rows));yield*entry(path,bytes.length,[bytes]);paths.push(path);count+=rows.length;offset+=rows.length;
   }manifest.tables.push({name:table.name,columns,count,pages:paths});
  }
  const files=(await db.prepare('SELECT id,object_key,size,content_type FROM wholesale_files ORDER BY id').all()).results;
  for(let i=0;i<files.length;i++){const f=files[i],object=await bucket.get(f.object_key);if(!object)throw Error(`备份缺少凭证原文件：${f.id}`);const path=`files/${String(i).padStart(8,'0')}.bin`;manifest.files.push({...f,path});yield*entry(path,Number(f.size),object.body);}
  await renew();const bytes=enc.encode(JSON.stringify(manifest));yield header('manifest.json',bytes.length);yield bytes;if(bytes.length%512)yield new Uint8Array(512-bytes.length%512);yield new Uint8Array(1024);
 }finally{await unlock();}}
 const iterator=content();return new ReadableStream({async pull(c){try{const r=await iterator.next();if(r.done)c.close();else c.enqueue(r.value);}catch(e){c.error(e);await unlock();}},async cancel(){await iterator.return();await unlock();}});
}
