import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createBackup,verifyArchive} from './backup.mjs';

const SITES={'越南仓库':'越南','印尼仓库':'印尼','菲律宾仓库':'菲律宾','马来仓库':'马来西亚','泰国仓库':'泰国'};
const SALES_TABLES=['sales_demand_corrections','sales_records','sales_imports','sales_ad_spend',
 'wholesale_return_resolutions','wholesale_returns','wholesale_finance_entries','wholesale_shipment_items','wholesale_shipments',
 'wholesale_allocations','wholesale_order_items','wholesale_files','wholesale_operations','wholesale_orders',
 'wholesale_bank_events','wholesale_bank_receipts','wholesale_finance_periods'];
const SNAPSHOT_TABLES=[...SALES_TABLES,'inventory_balances','sku_settings','inventory_count_requests','wholesale_finance_clock'];
const q=s=>'"'+s.replaceAll('"','""')+'"';
const fail=(message,status=409)=>{throw Object.assign(Error(message),{status});};
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const rows=(db,t)=>db.prepare(`SELECT * FROM ${q(t)} ORDER BY rowid`).all();
export function businessFingerprint(db){
 const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'local_%' AND name<>'system_maintenance' ORDER BY name").all();
 const h=createHash('sha256');for(const {name} of names){h.update(name);h.update(JSON.stringify(rows(db,name)));}return h.digest('hex');
}
export function validateBaseline(input){
 if(!input||input.asOf!=='2026-09-30'||!/^([a-f0-9]{64})$/.test(input.sha256)||!Array.isArray(input.rows)||!input.rows.length||input.rows.length>10000)fail('仅接受已核对的2026-09-30五站库存文件',400);
 const groups=new Map(),sourceKeys=new Set(),names=new Map();
 for(const r of input.rows){
  const site=SITES[r.sheet],sku=String(r.sku||'').trim().toUpperCase(),name=String(r.name||'').trim(),warehouse=String(r.warehouse||'').trim();
  if(!site||!sku||sku.length>160||!name||name.length>500||!warehouse||!Number.isSafeInteger(r.available)||r.available<0||!Number.isSafeInteger(r.returnInTransit)||r.returnInTransit<0||!Number.isSafeInteger(r.row)||r.row<3)fail('库存文件存在无效行',400);
  const sourceKey=[r.sheet,r.row].join('|');if(sourceKeys.has(sourceKey))fail('重复的源表行',400);sourceKeys.add(sourceKey);
  const key=site+'|'+sku,old=groups.get(key)||{site,sku,name,qty:0,returns:0};old.qty+=r.available;old.returns+=r.returnInTransit;
  if(!Number.isSafeInteger(old.qty)||old.qty>100000000)fail('库存数量超出范围',400);groups.set(key,old);
  if(!names.has(sku))names.set(sku,name);
 }
 const balances=[],summary=[];let oddTurn=0;
 for(const site of Object.values(SITES)){
  const list=[...groups.values()].filter(r=>r.site===site).sort((a,b)=>a.sku.localeCompare(b.sku,'en'));
  if(!list.length)fail('五个站点必须全部提供',400);
  let tk=0,shopee=0;
  for(const r of list){let a=Math.floor(r.qty/2),b=a;if(r.qty%2){if(oddTurn++%2===0)a++;else b++;}tk+=a;shopee+=b;
   balances.push({site,channel:'TikTok',sku:r.sku,name:r.name,qty:a},{site,channel:'Shopee',sku:r.sku,name:r.name,qty:b});}
  summary.push({site,skus:list.length,total:tk+shopee,TikTok:tk,Shopee:shopee,returnInTransit:list.reduce((s,r)=>s+r.returns,0)});
 }
 return {asOf:input.asOf,startDate:'2026-10-01',source:String(input.source||'库存文件'),sourceSha256:input.sha256,payloadHash:hash(input),balances,summary,skus:[...names].map(([sku,name])=>({sku,name})),total:summary.reduce((s,r)=>s+r.total,0)};
}
function blockers(db){
 const unknown=db.prepare("SELECT 1 FROM inventory_balances WHERE site NOT IN ('越南','印尼','菲律宾','马来西亚','泰国') OR channel NOT IN ('TikTok','Shopee','线下分销') LIMIT 1").get();
 if(unknown)fail('存在五站之外的库存，已暂停，避免超范围清理');
 const holds=db.prepare('SELECT COALESCE(SUM(pending_shelf_qty+quarantine_qty),0) n FROM transport_leg_items').get().n;
 if(holds)fail('存在运输待上架或隔离库存，需先核对来源，未修改任何数据');
 const future=[...SALES_TABLES.filter(t=>db.prepare(`PRAGMA table_info(${q(t)})`).all().some(c=>c.name==='business_date'))].filter(t=>db.prepare(`SELECT 1 FROM ${q(t)} WHERE business_date>='2026-10-01' LIMIT 1`).get());
 if(future.length)fail('已存在10月1日或之后的销售/收款记录，请先核对新期间数据，未修改任何数据');
}
export function previewBaseline(db,input){
 const data=validateBaseline(input);blockers(db);
 const last=db.prepare("SELECT action FROM audit_logs WHERE action IN ('inventoryBaselineApply','inventoryBaselineUndo') ORDER BY rowid DESC LIMIT 1").get();
 if(last?.action==='inventoryBaselineApply')fail('本次期初库存已导入，不可重复执行');
 const counts=Object.fromEntries(SALES_TABLES.map(t=>[t,db.prepare(`SELECT COUNT(*) n FROM ${q(t)}`).get().n]));
 return {...data,balances:undefined,skus:undefined,fingerprint:businessFingerprint(db),clearCounts:counts,oldInventoryRows:db.prepare('SELECT COUNT(*) n FROM inventory_balances').get().n,pendingCounts:db.prepare("SELECT COUNT(*) n FROM inventory_count_requests WHERE status='pending'").get().n};
}
const archiveDir=()=>resolve(process.env.LOONGJUMP_BACKUP_DIR||'backups','inventory-baselines');
const now=()=>new Date().toISOString();
function requireAdmin(actor){if(actor?.role!=='管理员')fail('仅管理员可执行期初切换',403);}
function audit(db,actor,action,id,detail){db.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),action,'inventory-baseline',id,JSON.stringify(detail),actor.id,actor.name,now());}
export function transaction(db,fn){
 db.exec('BEGIN IMMEDIATE');try{const result=fn();if(db.prepare('PRAGMA foreign_key_check').all().length)fail('外键核验失败，操作已回滚');if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')fail('数据库完整性检查失败');db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}
}
// Only delete guards for the explicitly archived sales tables are suspended inside
// the transaction. Concurrent connections see neither intermediate data nor guards.
function withDeleteGuards(db,fn){
 const triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'immutable_%_delete'").all().filter(t=>SALES_TABLES.some(n=>t.name==='immutable_'+n+'_delete'));
 for(const t of triggers)db.exec(`DROP TRIGGER ${q(t.name)}`);const result=fn();for(const t of triggers)db.exec(t.sql);return result;
}
export async function applyBaseline(env,actor,input,expected){
 requireAdmin(actor);const db=env.DB.sqlite,preview=previewBaseline(db,input),data=validateBaseline(input);
 if(preview.fingerprint!==expected?.fingerprint||preview.payloadHash!==expected?.payloadHash)fail('数据或文件已变化，请重新预览');
 const id=randomUUID(),dir=archiveDir();mkdirSync(dir,{recursive:true,mode:0o700});
 const backup=join(dir,id+'.tar');await createBackup(env,backup);await verifyArchive(backup);
 // No await between this fresh check and COMMIT; the complete replacement is atomic.
 const result=transaction(db,()=>{
  if(businessFingerprint(db)!==preview.fingerprint)fail('备份期间数据变化，请重新预览');blockers(db);
  const lock=db.prepare("SELECT mode,expires_at FROM system_maintenance WHERE id='global'").get();if(lock?.mode!=='normal'&&lock?.expires_at>now())fail('系统正在维护');
  const original=Object.fromEntries(SNAPSHOT_TABLES.map(t=>[t,rows(db,t)]));
  writeFileSync(join(dir,id+'.json'),JSON.stringify({id,backup,input,original,actorId:actor.id,createdAt:now()}),{mode:0o600,flag:'wx'});
  withDeleteGuards(db,()=>{for(const t of SALES_TABLES)db.exec(`DELETE FROM ${q(t)}`);});
  db.exec('DELETE FROM inventory_balances');
  const stock=db.prepare('INSERT INTO inventory_balances(site,channel,sku,name,qty,updated_at) VALUES(?,?,?,?,?,?)');
  const sku=db.prepare('INSERT INTO sku_settings(sku,name,updated_at) VALUES(?,?,?) ON CONFLICT(sku) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at');
  for(const r of data.skus)sku.run(r.sku,r.name,now());for(const r of data.balances)stock.run(r.site,r.channel,r.sku,r.name,r.qty,now());
  const oldMap=new Map(original.inventory_balances.map(r=>[[r.site,r.channel,r.sku].join('|'),r]));
  const newMap=new Map(data.balances.map(r=>[[r.site,r.channel,r.sku].join('|'),r]));
  const move=db.prepare("INSERT INTO inventory_movements(id,site,channel,sku,name,movement_type,qty_delta,balance_after,reference_type,reference_id,note,actor_id,created_at) VALUES(?,?,?,?,?,'期初库存切换',?,?,'inventory-baseline',?,?,?,?)");
  for(const key of new Set([...oldMap.keys(),...newMap.keys()])){const r=newMap.get(key)||oldMap.get(key),qty=newMap.get(key)?.qty||0;move.run(randomUUID(),r.site,r.channel,r.sku,r.name,qty-(oldMap.get(key)?.qty||0),qty,id,'2026-09-30可用库存；退货在途不计可售；旧数据已备份',actor.id,now());}
  db.prepare("UPDATE inventory_count_requests SET status='rejected',decision_comment=?,decided_by=?,updated_at=? WHERE status='pending'").run('期初库存切换：旧盘点不再覆盖2026-09-30新库存',actor.id,now());
  db.prepare("INSERT INTO wholesale_finance_clock(id,version) VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1").run();
  const total=db.prepare('SELECT SUM(qty) n FROM inventory_balances').get().n;if(total!==data.total)fail('库存总量不一致，操作已回滚');
  for(const t of SALES_TABLES)if(db.prepare(`SELECT COUNT(*) n FROM ${q(t)}`).get().n)fail('销售清零核验失败');
  audit(db,actor,'inventoryBaselineApply',id,{...preview,fingerprint:undefined,backup,startDate:data.startDate,cleared:preview.clearCounts});
  const result={id,summary:data.summary,total,backupVerified:true,startDate:data.startDate};
  writeFileSync(join(dir,id+'.result.json'),JSON.stringify({...result,fingerprint:businessFingerprint(db)}),{mode:0o600,flag:'wx'});
  return result;
 });
 return result;
}
export function undoBaseline(env,actor,id){
 requireAdmin(actor);if(!/^[a-f0-9-]{36}$/.test(id))fail('无效的切换编号',400);const db=env.DB.sqlite,dir=archiveDir();
 if(!existsSync(join(dir,id+'.result.json')))fail('恢复记录不存在');
 const result=JSON.parse(readFileSync(join(dir,id+'.result.json'),'utf8')),snapshot=JSON.parse(readFileSync(join(dir,id+'.json'),'utf8'));
 return transaction(db,()=>{
  if(businessFingerprint(db)!==result.fingerprint)fail('切换后已有业务变化，不能直接撤销。请使用完整备份核对恢复，避免覆盖新业务');
  const triggers=db.prepare("SELECT name,sql,tbl_name FROM sqlite_master WHERE type='trigger'").all().filter(t=>SNAPSHOT_TABLES.includes(t.tbl_name));
  for(const t of triggers)db.exec(`DROP TRIGGER ${q(t.name)}`);
  for(const t of SNAPSHOT_TABLES)db.exec(`DELETE FROM ${q(t)}`);
  // FK insertion order is reversed for sales children; independent tables follow.
  for(const t of [...SNAPSHOT_TABLES].reverse())for(const r of snapshot.original[t]){const cols=Object.keys(r);db.prepare(`INSERT INTO ${q(t)}(${cols.map(q).join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).run(...cols.map(c=>r[c]));}
  for(const t of triggers)db.exec(t.sql);
  // Movements and audit are immutable history: append compensating movements.
  const old=new Map(snapshot.original.inventory_balances.map(r=>[[r.site,r.channel,r.sku].join('|'),r]));
  const baseline=validateBaseline(snapshot.input),current=new Map(baseline.balances.map(r=>[[r.site,r.channel,r.sku].join('|'),r]));
  for(const key of new Set([...old.keys(),...current.keys()])){const r=old.get(key)||current.get(key),qty=old.get(key)?.qty||0;db.prepare("INSERT INTO inventory_movements(id,site,channel,sku,name,movement_type,qty_delta,balance_after,reference_type,reference_id,note,actor_id,created_at) VALUES(?,?,?,?,?,'撤销期初切换',?,?,'inventory-baseline',?,'恢复切换前备份',?,?)").run(randomUUID(),r.site,r.channel,r.sku,r.name,qty-(current.get(key)?.qty||0),qty,id,actor.id,now());}
  audit(db,actor,'inventoryBaselineUndo',id,{restored:true});return {ok:true,restored:true};
 });
}

export function baselineStatus(db){
 const last=db.prepare("SELECT action,entity_id FROM audit_logs WHERE action IN ('inventoryBaselineApply','inventoryBaselineUndo') ORDER BY rowid DESC LIMIT 1").get();
 if(last?.action!=='inventoryBaselineApply')return {active:false};
 return {active:true,id:last.entity_id,summary:db.prepare('SELECT site,channel,COUNT(*) skus,SUM(qty) qty,SUM(reserved_qty) reserved FROM inventory_balances GROUP BY site,channel ORDER BY site,channel').all(),total:db.prepare('SELECT SUM(qty) n FROM inventory_balances').get().n,clearCounts:Object.fromEntries(SALES_TABLES.map(t=>[t,db.prepare(`SELECT COUNT(*) n FROM ${q(t)}`).get().n]))};
}

export const baselinePage=`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>库存期初切换</title><style>body{font:16px system-ui;color:#18324b;background:#f3f6fa;margin:0;padding:24px}main{max-width:980px;margin:auto;background:white;border-radius:16px;padding:28px}h1{font-size:25px}p{line-height:1.8}button,input{font:inherit;padding:12px;margin:8px 8px 8px 0}button{border:0;border-radius:8px;background:#215fe5;color:white;cursor:pointer}button:disabled{opacity:.45}table{border-collapse:collapse;width:100%;margin:20px 0}td,th{text-align:left;border-bottom:1px solid #ddd;padding:10px}#message{white-space:pre-wrap;line-height:1.7}label{display:block;margin:16px 0}.danger{color:#aa2334}.muted{color:#52647a}</style><main><a href="/">返回后台</a><h1>2026年9月30日期初库存切换</h1><p>以五站各子表的可用量建立期初库存。同站点各仓合并，TK与Shopee各50%，奇数余件交替分配。退货在途不计可售。</p><p class="danger">清理线上销售、广告费用、日报状态，以及印尼线下订单、出库、退货、回款和结算记录。新库存替换旧库存，旧待复核盘点作废。保留账号、客户、拜访、合同、售后、采购生产及审计历史。</p><p class="muted">系统先生成并校验完整备份，再一次性切换；失败会回滚。切换后尚无其他业务变化时，可在本页直接撤销。正式销售从2026-10-01开始。</p><label>选择已校验的库存数据文件<input type="file" id="file" accept=".json"></label><button id="preview">核对导入数据</button><section id="report"></section><label><input type="checkbox" id="agree">已核对五站库存和清理范围，执行正式系统切换</label><button id="apply" disabled>备份、清零并导入</button><button id="undo" hidden>撤销本次切换</button><p id="message" role="status"></p></main><script>
let input,expected,result;const el=id=>document.getElementById(id),message=s=>el('message').textContent=s;
async function call(action,extra={}){const r=await fetch('/api/inventory-baseline',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...extra})});const v=await r.json();if(!r.ok)throw Error(v.error||'操作失败');return v;}
function ready(){el('apply').disabled=!expected||!el('agree').checked;}el('agree').onchange=ready;el('file').onchange=()=>{expected=null;ready();el('report').textContent='';};
el('preview').onclick=async()=>{expected=null;ready();try{const f=el('file').files[0];if(!f)throw Error('请选择文件');input=JSON.parse(await f.text());expected=await call('preview',{input});const table=document.createElement('table');for(const cells of [['站点','SKU数','总库存','TikTok','Shopee','退货在途'],...expected.summary.map(r=>[r.site,r.skus,r.total,r.TikTok,r.Shopee,r.returnInTransit])]){const tr=document.createElement('tr');for(const value of cells){const td=document.createElement('td');td.textContent=String(value);tr.append(td);}table.append(tr);}el('report').replaceChildren(table);const p=document.createElement('p');p.textContent='可用库存总计 '+expected.total+' 件。旧库存行 '+expected.oldInventoryRows+'；旧线上销售行 '+expected.clearCounts.sales_records+'；线下订单 '+expected.clearCounts.wholesale_orders+'；待复核盘点 '+expected.pendingCounts+'。';el('report').append(p);message('核对完成，尚未修改系统。');ready();}catch(e){message(e.message);}};
el('apply').onclick=async()=>{el('apply').disabled=true;el('preview').disabled=true;message('正在备份并校验，再执行原子切换，请勿关闭页面…');try{result=await call('apply',{input,expected});expected=null;el('undo').hidden=false;message('已完成：五站可用库存 '+result.total+' 件，旧销售已清零。完整备份已校验。销售从 '+result.startDate+' 开始。切换编号：'+result.id);}catch(e){message(e.message);}finally{el('preview').disabled=false;ready();}};
el('undo').onclick=async()=>{el('undo').disabled=true;try{await call('undo',{id:result.id});message('已恢复切换前的数据；保留本次切换和撤销的审计记录。');el('undo').hidden=true;}catch(e){message(e.message);}finally{el('undo').disabled=false;}};
call('status').then(v=>{if(v.active){result=v;el('undo').hidden=false;message('已启用期初库存，当前可用库存合计 '+v.total+' 件。切换编号：'+v.id);}}).catch(e=>message(e.message));
</script></html>`;

export async function handleBaseline(req,res,env,actor){
 try{requireAdmin(actor);if(req.method==='GET'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(baselinePage);return;}
  let size=0,chunks=[];for await(const b of req){size+=b.length;if(size>3*1024*1024)fail('文件过大',413);chunks.push(b);}let p;try{p=JSON.parse(Buffer.concat(chunks));}catch{fail('请求格式错误',400);}
  if(!p||typeof p!=='object'||Array.isArray(p))fail('请求格式错误',400);
  let value;if(p.action==='status')value=baselineStatus(env.DB.sqlite);else if(p.action==='preview')value=previewBaseline(env.DB.sqlite,p.input);else if(p.action==='apply')value=await applyBaseline(env,actor,p.input,p.expected);else if(p.action==='undo')value=undoBaseline(env,actor,p.id);else fail('无效操作',400);
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));
 }catch(e){console.error('Inventory baseline:',e.message);res.writeHead(e.status||500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.status?e.message:'库存切换未完成，请保留文件并查看服务器日志'}));}
}
