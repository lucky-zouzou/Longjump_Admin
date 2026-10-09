import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {businessFingerprint,transaction} from './inventory-baseline.mjs';
import {createBackup,verifyArchive} from './backup.mjs';
const filters={new_product_stage_records:"project_id IN (SELECT id FROM new_product_projects WHERE cycle_month<'2026-10')",new_product_projects:"cycle_month<'2026-10'",plan_changes:"month<'2026-10'",forecast_snapshots:"month<'2026-10'",monthly_submissions:"month<'2026-10'",approval_requests:"type='monthly_plan' AND month<'2026-10'"};
const septemberFilters={new_product_stage_records:"project_id IN (SELECT id FROM new_product_projects WHERE cycle_month='2026-09')",new_product_projects:"cycle_month='2026-09'"};
const scopes={prelaunch_all:filters,september_products:septemberFilters};
const fail=(m,s=409)=>{throw Object.assign(Error(m),{status:s});},dir=()=>resolve(process.env.LOONGJUMP_BACKUP_DIR||'backups','test-cleanup');
const digest=value=>createHash('sha256').update(value).digest('hex');
function scopeKey(value='prelaunch_all'){if(typeof value!=='string'||!Object.hasOwn(scopes,value))fail('清理范围无效',400);return value;}
function admin(a){if(a?.role!=='管理员')fail('仅管理员可执行',403);}
function snapshot(db,scope){return Object.fromEntries(Object.entries(scopes[scope]).map(([t,w])=>[t,db.prepare(`SELECT * FROM ${t} WHERE ${w} ORDER BY rowid`).all()]));}
function audit(db,a,action,id,detail){db.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),action,'test-cleanup',id,JSON.stringify(detail),a.id,a.name,new Date().toISOString());}
export function previewCleanup(db,selection='prelaunch_all'){
 const scope=scopeKey(selection),s=snapshot(db,scope),ids=new Set((s.approval_requests||[]).map(r=>r.id)),projectIds=new Set(s.new_product_projects.map(r=>r.id));
 const purchases=db.prepare('SELECT month,approval_id FROM series_purchase_orders').all();
 if(s.new_product_projects.some(r=>r.production_batch_id)||purchases.some(r=>projectIds.has(r.approval_id)))fail('所选新品已关联采购生产记录，需先核对，尚未清理');
 if(scope==='prelaunch_all'){
  if(s.approval_requests.some(r=>r.status==='approved')||purchases.some(r=>r.month<'2026-10'||ids.has(r.approval_id))||db.prepare('SELECT month FROM series_production_orders UNION ALL SELECT month FROM production_batches').all().some(r=>r.month<'2026-10'))fail('测试数据已关联批准或采购生产记录，需先核对，尚未清理');
  if(db.prepare('SELECT month,approval_id FROM plan_changes UNION ALL SELECT month,approval_id FROM forecast_snapshots').all().some(r=>r.month>='2026-10'&&ids.has(r.approval_id)))fail('测试审批关联正式月份，尚未清理');
 }
 const lock=db.prepare("SELECT mode,expires_at FROM system_maintenance WHERE id='global'").get();if(lock?.mode!=='normal'&&lock?.expires_at>new Date().toISOString())fail('系统正在维护');
 return {scope,counts:Object.fromEntries(Object.entries(s).map(([t,r])=>[t,r.length])),projects:s.new_product_projects.map(({id,cycle_month,sku,name})=>({id,month:cycle_month,sku,name})),fingerprint:businessFingerprint(db),inventory:db.prepare('SELECT COALESCE(SUM(qty),0) n FROM inventory_balances').get().n};
}
export async function applyCleanup(env,a,expected,selection=expected?.scope||'prelaunch_all'){
 admin(a);const scope=scopeKey(selection);if(scope!==(expected?.scope||'prelaunch_all'))fail('清理范围已变化，请重新核对');
 const db=env.DB.sqlite,p=previewCleanup(db,scope);if(p.fingerprint!==expected?.fingerprint)fail('数据已变化，请重新核对');if(!Object.values(p.counts).some(Boolean))fail('没有待清理的测试数据');
 const id=randomUUID();mkdirSync(dir(),{recursive:true,mode:0o700});const backup=join(dir(),id+'.tar');await createBackup(env,backup);await verifyArchive(backup);
 return transaction(db,()=>{
  if(previewCleanup(db,scope).fingerprint!==p.fingerprint)fail('备份期间数据变化，请重新核对');
  const saved=JSON.stringify(snapshot(db,scope));writeFileSync(join(dir(),id+'.json'),saved,{mode:0o600,flag:'wx'});
  for(const [t,w] of Object.entries(scopes[scope]))db.exec(`DELETE FROM ${t} WHERE ${w}`);
  audit(db,a,'testCleanupApply',id,{scope,cutoff:'2026-10-01',month:scope==='september_products'?'2026-09':null,counts:p.counts,backup});
  const result={id,scope,counts:p.counts,inventory:p.inventory};writeFileSync(join(dir(),id+'.result.json'),JSON.stringify({...result,snapshotHash:digest(saved),fingerprint:businessFingerprint(db)}),{mode:0o600,flag:'wx'});return result;
 });
}
export function undoCleanup(env,a,id){
 admin(a);if(!/^[a-f0-9-]{36}$/.test(id))fail('编号无效',400);
 const result=JSON.parse(readFileSync(join(dir(),id+'.result.json'),'utf8')),source=readFileSync(join(dir(),id+'.json'),'utf8'),saved=JSON.parse(source),db=env.DB.sqlite,scope=scopeKey(result.scope);
 if(result.snapshotHash&&digest(source)!==result.snapshotHash)fail('恢复文件校验失败，未恢复');
 return transaction(db,()=>{
  if(scope==='september_products'){
   // Restore only the archived September rows, even if unrelated October business has continued.
   if(!result.snapshotHash||Object.keys(saved).sort().join()!==Object.keys(septemberFilters).sort().join()||saved.new_product_projects.some(r=>r.cycle_month!=='2026-09'))fail('恢复范围校验失败，未恢复');
   const ids=new Set(saved.new_product_projects.map(r=>r.id));if(saved.new_product_stage_records.some(r=>!ids.has(r.project_id)))fail('恢复范围校验失败，未恢复');
   for(const r of saved.new_product_projects)if(db.prepare('SELECT 1 FROM new_product_projects WHERE id=? OR (cycle_month=? AND sku=?)').get(r.id,r.cycle_month,r.sku))fail('同月SKU或项目编号已存在，未恢复；请先核对冲突记录');
   for(const r of saved.new_product_stage_records)if(db.prepare('SELECT 1 FROM new_product_stage_records WHERE id=? OR (project_id=? AND stage_key=? AND scope_key=?)').get(r.id,r.project_id,r.stage_key,r.scope_key))fail('新品阶段记录已存在，未恢复；请先核对冲突记录');
  }else if(businessFingerprint(db)!==result.fingerprint)fail('清理后已有业务变化，不能直接撤销，请核对备份恢复');
  for(const [t,rs] of Object.entries(saved).reverse())for(const r of rs){const cols=Object.keys(r);db.prepare(`INSERT INTO ${t}(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).run(...cols.map(c=>r[c]));}
  audit(db,a,'testCleanupUndo',id,{scope,restored:true});return {restored:true};
 });
}
export const cleanupPage=`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>清理上线前测试数据</title><style>body{font:16px system-ui;background:#f3f6fa;color:#18324b;padding:24px}main{max-width:850px;margin:auto;background:white;padding:28px;border-radius:16px}p{line-height:1.8;white-space:pre-wrap}button,select{padding:12px 18px;margin:8px 0;border:1px solid #cad5e2;border-radius:8px;font:inherit}button{background:#215fe5;color:white;margin-right:8px}select{display:block;max-width:100%;background:white}button:disabled{opacity:.4}#summary{padding:16px;background:#f1f6fc;border-radius:8px}#result{font-weight:600}</style><main><a href="/">返回后台</a><h1>清理上线前测试数据</h1><label for="scope">清理范围</label><select id="scope"><option value="september_products">仅2026年9月新品孵化</option><option value="prelaunch_all">10月前全部测试备货和新品（扩大范围）</option></select><p id="description"></p><p>执行前完整备份并校验，全程留痕。9月新品可单独恢复；若同月SKU已重新发起，请先处理冲突。全部测试数据清理仅在没有后续业务变化时可直接撤销。</p><button id="preview">核对所选数据</button><p id="summary"></p><button id="apply" disabled>备份并清理所选记录</button><button id="undo" hidden>撤销本次清理</button><p id="result" role="status"></p></main><script>
let expected,id;const el=x=>document.getElementById(x),msg=x=>el('result').textContent=x,selection=()=>el('scope').value;async function call(action,extra={}){const r=await fetch('/api/test-cleanup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,scope:selection(),...extra})}),v=await r.json();if(!r.ok)throw Error(v.error);return v;}
function busy(value){for(const key of ['scope','preview','undo'])el(key).disabled=value;el('apply').disabled=value||!expected||!Object.values(expected.counts).some(Boolean);}
async function changeScope(){expected=null;id=null;el('apply').disabled=true;el('undo').hidden=true;el('summary').textContent='';msg('');const scope=selection();el('description').textContent=scope==='september_products'?'仅清理2026年9月的新品项目及其阶段记录。保留备货计划、审批、库存、销售、SKU资料、审计记录和其他月份新品。所选项目有关联采购生产时停止。':'清理2026年10月之前的备货提交、预测快照、月度审批及变更，以及新品孵化项目和阶段记录。库存、销售、客户和10月起正式记录保留。有采购生产关联时停止。';try{const v=await call('status');if(scope===selection()&&v.id){id=v.id;el('undo').hidden=false;msg('所选范围最近一次清理编号：'+id);}}catch(e){if(scope===selection())msg(e.message);}}
el('scope').onchange=changeScope;
el('preview').onclick=async()=>{expected=null;busy(true);try{expected=await call('preview');const c=expected.counts;el('summary').textContent='新品项目 '+c.new_product_projects+'；新品阶段记录 '+c.new_product_stage_records+'。'+(expected.scope==='prelaunch_all'?'备货提交 '+c.monthly_submissions+'；审批 '+c.approval_requests+'；预测快照 '+c.forecast_snapshots+'；变更 '+c.plan_changes+'。':'')+'当前库存 '+expected.inventory+' 件。'+(expected.projects.length?'\\n'+expected.projects.map(r=>r.month+' · '+r.sku+' · '+r.name).join('\\n'):'');msg(Object.values(c).some(Boolean)?'核对完成，尚未清理。':'所选范围已无待清理记录。');}catch(e){msg(e.message);}finally{busy(false);}};
el('apply').onclick=async()=>{busy(true);msg('正在备份、校验并清理…');try{const v=await call('apply',{expected:{scope:expected.scope,fingerprint:expected.fingerprint}});id=v.id;expected=null;el('undo').hidden=false;msg((v.scope==='september_products'?'2026年9月新品孵化已清理：'+v.counts.new_product_projects+'个项目、'+v.counts.new_product_stage_records+'条阶段记录。':'测试备货计划和新品孵化已清理。')+'完整备份已校验。库存保持 '+v.inventory+' 件。编号：'+id);}catch(e){msg(e.message);}finally{busy(false);}};
el('undo').onclick=async()=>{busy(true);try{await call('undo',{id});expected=null;el('undo').hidden=true;msg('所选记录已恢复，操作记录保留。');}catch(e){msg(e.message);}finally{busy(false);}};
changeScope();</script></html>`;
export async function handleCleanup(req,res,env,a){try{
 admin(a);if(req.method==='GET'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(cleanupPage);return;}
 let size=0,bs=[];for await(const b of req){size+=b.length;if(size>4096)fail('请求过大',413);bs.push(b);}let p;try{p=JSON.parse(Buffer.concat(bs));}catch{fail('格式错误',400);}if(!p||typeof p!=='object')fail('格式错误',400);
 const scope=scopeKey(p.scope);let v;
 if(p.action==='preview')v=previewCleanup(env.DB.sqlite,scope);
 else if(p.action==='apply')v=await applyCleanup(env,a,p.expected,scope);
 else if(p.action==='undo')v=undoCleanup(env,a,p.id);
 else if(p.action==='status'){const last=env.DB.sqlite.prepare("SELECT action,entity_id FROM audit_logs WHERE action IN ('testCleanupApply','testCleanupUndo') AND COALESCE(json_extract(detail_json,'$.scope'),'prelaunch_all')=? ORDER BY rowid DESC LIMIT 1").get(scope);v={id:last?.action==='testCleanupApply'?last.entity_id:null};}
 else fail('无效操作',400);
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(v));
}catch(e){console.error('Test cleanup:',e.message);res.writeHead(e.status||500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.status?e.message:'清理未完成，请查看服务器日志'}));}}
