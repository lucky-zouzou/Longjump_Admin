import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';
import {canReadActions,actionScope} from './business-action-model.mjs';
import {completeSalesDates} from './sales-completeness.mjs';
import {zeroSalesSites,localDay,shiftDay} from './promotion-model.mjs';
import {SITE_CURRENCIES} from './sales-data.mjs';
const rows=async(db,sql,args=[])=>(await db.prepare(sql).bind(...args).all()).results||[];
const fail=(m,status=400)=>{throw Object.assign(new Error(m),{status});};
const key=(...v)=>JSON.stringify(v),scope=r=>key(r.site,r.channel);
const hash=async v=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(v)))),b=>b.toString(16).padStart(2,'0')).join('');
async function access(db,a){if(!canReadActions(a))fail('当前岗位无证据核对权限',403);const u=await db.prepare('SELECT * FROM users WHERE id=? AND active=1').bind(a.id).first();if(!u||u.role!==a.role||a.role==='运营'&&(u.site!==a.site||u.channel!==a.channel))fail('账号权限已变化',403);}
const clock=async db=>(await db.prepare("SELECT version FROM business_action_source_clock WHERE id='global'").first())?.version||0;

// One task per source defect, not per affected SKU and not per refresh date.
export async function readEvidenceWorkbench(db,a,now=new Date()){
 await access(db,a);const sourceVersion=await clock(db);let first=shiftDay(localDay(now,'印尼'),-28);
 const historical=await rows(db,"SELECT snapshot_json FROM evidence_tasks WHERE status<>'resolved'"+(a.role==='运营'?' AND site=? AND channel=?':''),a.role==='运营'?[a.site,a.channel]:[]);for(const h of historical){const d=JSON.parse(h.snapshot_json).date;if(d&&d<first)first=d;}
 const filter=a.role==='运营'?' AND site=? AND channel=?':'',args=a.role==='运营'?[a.site,a.channel]:[];
 const [stocks,sales,imports,ads,availability,saved,users]=await Promise.all([
 rows(db,'SELECT * FROM inventory_balances WHERE 1=1'+filter,args),
 rows(db,'SELECT id,import_id,site,channel,sku,business_date,qty,currency,reported_amount,ad_cost FROM sales_records WHERE reversed_at IS NULL AND business_date>=?'+filter,[first,...args]),
 rows(db,'SELECT id,site,channel,business_date,report_kind FROM sales_imports WHERE reversed_at IS NULL AND business_date>=?'+filter,[first,...args]),
 rows(db,'SELECT * FROM sales_ad_spend WHERE deleted_at IS NULL AND business_date>=?'+filter,[first,...args]),
 rows(db,'SELECT * FROM promotion_availability WHERE 1=1'+filter,args),
 rows(db,'SELECT * FROM evidence_tasks WHERE 1=1'+filter,args),
 rows(db,"SELECT id,name,role,site,channel FROM users WHERE active=1 AND role IN ('管理员','财务','供应链','运营','运营主管')")]);
 const defects=[];
 const add=(kind,site,channel,date,sku,title,role,items,detail,href)=>defects.push({key:key(kind,site,channel,date,sku),kind,site,channel,date,sku,title,role,skus:[...new Set(items.map(s=>s.sku))],sources:detail,href});
 const scopes=a.role==='运营'?[{site:a.site,channel:a.channel}]:zeroSalesSites.flatMap(site=>['TikTok','Shopee'].map(channel=>({site,channel})));
 for(const s of scopes){
  const same=r=>scope(r)===scope(s),ss=sales.filter(same),ii=imports.filter(same),stock=stocks.filter(same),cutoff=shiftDay(localDay(now,s.site),-1);
  const items=[...stock,...ss],complete=new Set(completeSalesDates(ii,ss));
  if(!items.length&&!ii.length)continue;
  for(let date=first;date<=cutoff;date=shiftDay(date,1)){
   const day=ss.filter(r=>r.business_date===date),batches=ii.filter(r=>r.business_date===date),pool=ads.filter(r=>same(r)&&r.business_date===date);
   const sources={batches:batches.map(r=>({id:r.id,kind:r.report_kind})),salesIds:day.map(r=>r.id),currency:SITE_CURRENCIES[s.site]};
   if(!complete.has(date))add('report',s.site,s.channel,date,'','补齐完整日报','运营',items,{...sources,reason:batches.length?'仅部分日报或存在重叠记录':'未提交日报'},'/?page=sales&history=imports');
   const native=day.filter(r=>r.currency===SITE_CURRENCIES[s.site]);
   const adKnown=pool.some(r=>r.currency===SITE_CURRENCIES[s.site])||native.length>0&&native.every(r=>r.ad_cost!=null);
   if(!adKnown)add('ads',s.site,s.channel,date,'','核对店铺当天广告费','运营',items,{...sources,reason:'缺店铺总费用或完整SKU费用；无投放需明确确认0'},'/?page=sales&history=imports');
   const bad=day.filter(r=>r.currency!==SITE_CURRENCIES[s.site]||r.reported_amount==null);
   if(bad.length)add('money',s.site,s.channel,date,'','核对原币及销售金额','财务',bad,{...sources,reason:'金额缺失或币种不符合站点',rows:bad},'/?page=sales&history=imports');
   const repeated=new Map();for(const r of day.filter(r=>r.ad_cost>0)){const k=key(r.currency,r.ad_cost);repeated.set(k,[...(repeated.get(k)||[]),r]);}
   for(const rs of repeated.values())if(new Set(rs.map(r=>r.sku)).size>=3&&!pool.some(p=>p.currency===rs[0].currency))add('ad_repeat',s.site,s.channel,date,String(rs[0].ad_cost),'排查重复填写的店铺广告总额','财务',rs,{...sources,reason:'多SKU同额仅为疑点，须核对平台账单，不自动删除',rows:rs},'/?page=sales&history=imports');
  }
  const unverified=stock.filter(r=>!availability.some(v=>same(v)&&v.sku===r.sku&&v.listed_since&&v.verified_through>=cutoff));
  if(unverified.length)add('availability',s.site,s.channel,'','','批量核验上架及连续有货证据','运营',unverified,{reason:'历史首销只作候选，不证明连续有货'},'/?page=business-actions');
 }
 for(const r of stocks.filter(r=>r.qty<0||r.qty-r.reserved_qty<0||r.reserved_qty<0))add('inventory',r.site,r.channel,'',r.sku,'核对库存与预留冲突','供应链',[r],{book:r.qty,reserved:r.reserved_qty,available:r.qty-r.reserved_qty,updatedAt:r.updated_at,reason:'按期初、入库、销售、调拨及预留逐笔核对；不得直接补零'},'/?page=inventory');
 const missingStocks=sales.filter(r=>!stocks.some(s=>scope(s)===scope(r)&&s.sku===r.sku));
 for(const r of [...new Map(missingStocks.map(r=>[key(r.site,r.channel,r.sku),r])).values()])add('inventory',r.site,r.channel,'',r.sku,'核对缺失库存记录','供应链',[r],{reason:'销售存在但库存记录缺失',saleId:r.id,batch:r.import_id},'/?page=inventory');
 for(const d of defects.filter(t=>t.kind==='inventory')){
  const trail=await rows(db,'SELECT id,movement_type,qty_delta,balance_after,reference_type,reference_id,note,created_at FROM inventory_movements WHERE site=? AND channel=? AND sku=? ORDER BY created_at DESC,rowid DESC LIMIT 61',[d.site,d.channel,d.sku]);
  d.sources.trail=trail.slice(0,60);d.sources.moreMovements=trail.length>60;
  d.sources.reservations=d.site==='印尼'?await rows(db,"SELECT o.id orderId,o.order_no,o.status,a.qty-a.shipped_qty-a.released_qty remaining FROM wholesale_allocations a JOIN wholesale_order_items i ON i.id=a.order_item_id JOIN wholesale_orders o ON o.id=i.order_id WHERE o.site=? AND a.channel=? AND i.sku=? AND a.qty-a.shipped_qty-a.released_qty>0",[d.site,d.channel,d.sku]):[];
 }
 // Finance dates are grouped across SKU and across the three action types.
 const actions=await rows(db,"SELECT id,site,channel,sku,snapshot_json FROM business_actions WHERE status<>'resolved'"+filter,args),finance=new Map();
 for(const r of actions){const snap=JSON.parse(r.snapshot_json);for(const d of snap.financeDays||[]){if(d.status==='confirmed')continue;const k=key(r.site,r.channel,d.date),v=finance.get(k)||{...r,date:d.date,items:[],actionIds:[]};v.items.push(r);v.actionIds.push(r.id);finance.set(k,v);}}
 for(const g of finance.values())add('cost',g.site,g.channel,g.date,'','核对当日成本及凭据','财务',g.items,{reason:'先补共同来源，再核对真实成本归属；滚动复用已核实日期',actionIds:[...new Set(g.actionIds)]},'/?page=cost-profit');
 const tasks=await Promise.all(defects.map(async d=>{const old=saved.find(r=>r.task_key===d.key);return {...d,basisHash:await hash(d),version:old?.version||0,ownerId:old?.owner_id||'',dueAt:old?.due_at||'',status:old?.status==='resolved'?'reopened':old?.status||'open'};}));
 for(const old of saved)if(!tasks.some(t=>t.key===old.task_key))tasks.push({...JSON.parse(old.snapshot_json),key:old.task_key,version:old.version,ownerId:old.owner_id,dueAt:old.due_at,status:old.status==='resolved'?'resolved':'review_ready',basisHash:'cleared'});
 if(await clock(db)!==sourceVersion)fail('证据已更新，请刷新',409);
 const visibleTasks=a.role==='供应链'?tasks.filter(t=>!['money','ad_repeat'].includes(t.kind)):tasks;
 const taskKeys=new Set(visibleTasks.map(t=>t.key)),events=(await rows(db,'SELECT e.*,u.name actorName FROM evidence_task_events e JOIN users u ON u.id=e.actor_id ORDER BY e.created_at DESC')).filter(e=>taskKeys.has(e.task_key)).map(e=>({...e,detail:JSON.parse(e.detail_json),detail_json:undefined}));
 return {tasks:visibleTasks,events,users:users.filter(u=>a.role!=='运营'||u.role!=='运营'||u.site===a.site&&u.channel===a.channel),sourceVersion,actor:{id:a.id,role:a.role},generatedAt:now.toISOString()};
}
export async function mutateEvidenceTask(db,a,p,now=new Date()){
 await access(db,a);await assertWritable(db);const data=await readEvidenceWorkbench(db,a,now),t=data.tasks.find(t=>t.key===p.key);
 if(!t||t.version!==p.version||t.basisHash!==p.basisHash)fail('任务或来源已变化，请刷新核对',409);
 const note=String(p.note||'').trim();if(note.length<4||note.length>2000)fail('请填写核对依据或处理说明');
 let ownerId=t.ownerId,dueAt=t.dueAt,status=t.status;
 if(p.action==='evidenceAssign'){
  if(a.role!=='管理员')fail('仅管理员确认唯一核对人',403);const u=data.users.find(u=>u.id===p.ownerId&&u.role===t.role&&actionScope(u,t));if(!u)fail('请选择对应岗位及站点渠道的有效人员');
  const due=Date.parse(p.dueAt);if(!Number.isFinite(due)||due<+now||due>+now+90*86400000)fail('截止时间须为未来90天内');ownerId=u.id;dueAt=new Date(due).toISOString();status='open';
 }else if(p.action==='evidenceStart'){
  if(a.id!==ownerId)fail('请由已指定核对人处理',403);status='in_progress';
 }else if(p.action==='evidenceReview'){
  if(a.id!==ownerId&&a.role!=='管理员')fail('由核对人或管理员复查',403);if(t.basisHash!=='cleared')fail('原始证据缺口仍存在，请先在原单据修正；不能仅凭已执行结案');status='resolved';
 }else fail('不支持的证据任务动作');
 await atomicBatch(db,[guardStatement(db,a,p.action,"COALESCE((SELECT version FROM evidence_tasks WHERE task_key=?),0)=? AND COALESCE((SELECT version FROM business_action_source_clock WHERE id='global'),0)=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role=?)",[t.key,t.version,data.sourceVersion,a.id,a.role]),...(ownerId?[guardStatement(db,a,'evidence.owner',"EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role=? AND (?<>'运营' OR (site=? AND channel=?)))",[ownerId,t.role,t.role,t.site,t.channel])]:[]),db.prepare('INSERT INTO evidence_tasks VALUES(?,?,?,?,?,?,1,?,?) ON CONFLICT(task_key) DO UPDATE SET owner_id=excluded.owner_id,due_at=excluded.due_at,status=excluded.status,version=evidence_tasks.version+1,updated_at=excluded.updated_at,snapshot_json=excluded.snapshot_json').bind(t.key,t.site,t.channel,ownerId||null,dueAt||null,status,now.toISOString(),JSON.stringify(t)),db.prepare('INSERT INTO evidence_task_events VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),t.key,p.action,JSON.stringify({note,before:t.status,status,ownerId,dueAt,basisHash:t.basisHash}),a.id,now.toISOString())]);
 return {ok:true};
}
