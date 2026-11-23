import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';
import {canReadActions,actionScope} from './business-action-model.mjs';
import {completeSalesDates} from './sales-completeness.mjs';
import {zeroSalesSites,localDay,shiftDay} from './promotion-model.mjs';
import {SITE_CURRENCIES} from './sales-data.mjs';
const rows=async(db,sql,args=[])=>(await db.prepare(sql).bind(...args).all()).results||[];
const fail=(m,status=400)=>{throw Object.assign(new Error(m),{status});};
const key=(...v)=>JSON.stringify(v),scope=r=>key(r.site,r.channel);
function groupBy(items,identify){const groups=new Map();for(const item of items){const id=identify(item);let group=groups.get(id);if(!group)groups.set(id,group=[]);group.push(item);}return groups;}
const hash=async v=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(v)))),b=>b.toString(16).padStart(2,'0')).join('');
async function access(db,a){if(!canReadActions(a))fail('当前岗位无证据核对权限',403);const u=await db.prepare('SELECT * FROM users WHERE id=? AND active=1').bind(a.id).first();if(!u||u.role!==a.role||a.role==='运营'&&(u.site!==a.site||u.channel!==a.channel))fail('账号权限已变化',403);}
const clock=async db=>(await db.prepare("SELECT version FROM business_action_source_clock WHERE id='global'").first())?.version||0;

// One task per source defect, not per affected SKU and not per refresh date.
export async function readEvidenceWorkbench(db,a,now=new Date(),{summary=false}={}){
 await access(db,a);const sourceVersion=await clock(db);let first=shiftDay(localDay(now,'印尼'),-28);
 const historical=await rows(db,"SELECT snapshot_json FROM evidence_tasks WHERE status<>'resolved'"+(a.role==='运营'?' AND site=? AND channel=?':''),a.role==='运营'?[a.site,a.channel]:[]);for(const h of historical){const d=JSON.parse(h.snapshot_json).date;if(d&&d<first)first=d;}
 const filter=a.role==='运营'?' AND site=? AND channel=?':'',args=a.role==='运营'?[a.site,a.channel]:[];
 const [stocks,sales,imports,ads,availability,saved,users]=await Promise.all([
 rows(db,'SELECT * FROM inventory_balances WHERE 1=1'+filter,args),
 rows(db,'SELECT id,import_id,actor_id,site,channel,sku,business_date,qty,currency,reported_amount,ad_cost FROM sales_records WHERE reversed_at IS NULL AND business_date>=?'+filter,[first,...args]),
 rows(db,'SELECT id,site,channel,business_date,report_kind FROM sales_imports WHERE reversed_at IS NULL AND business_date>=?'+filter,[first,...args]),
 rows(db,'SELECT * FROM sales_ad_spend WHERE deleted_at IS NULL AND business_date>=?'+filter,[first,...args]),
 rows(db,'SELECT * FROM promotion_availability WHERE 1=1'+filter,args),
 rows(db,'SELECT * FROM evidence_tasks WHERE 1=1'+filter,args),
 rows(db,"SELECT id,name,role,site,channel FROM users WHERE active=1 AND role IN ('管理员','财务','供应链','运营','运营主管')")]);
 const defects=[];
 const salesByScope=groupBy(sales,scope),importsByScope=groupBy(imports,scope),stocksByScope=groupBy(stocks,scope),adsByDay=groupBy(ads,r=>key(r.site,r.channel,r.business_date));
 const availabilityBySku=groupBy(availability,r=>key(r.site,r.channel,r.sku));
 const add=(kind,site,channel,date,sku,title,role,items,detail,href)=>defects.push({key:key(kind,site,channel,date,sku),kind,site,channel,date,sku,title,role,skus:[...new Set(items.map(s=>s.sku))],sources:detail,href});
 const scopes=a.role==='运营'?[{site:a.site,channel:a.channel}]:zeroSalesSites.flatMap(site=>['TikTok','Shopee'].map(channel=>({site,channel})));
 for(const s of scopes){
  const id=scope(s),ss=salesByScope.get(id)||[],ii=importsByScope.get(id)||[],stock=stocksByScope.get(id)||[],cutoff=shiftDay(localDay(now,s.site),-1);
  const salesByDay=groupBy(ss,r=>r.business_date),importsByDay=groupBy(ii,r=>r.business_date);
  const items=[...stock,...ss],complete=new Set(completeSalesDates(ii,ss));
  if(!items.length&&!ii.length)continue;
  for(let date=first;date<=cutoff;date=shiftDay(date,1)){
   const day=salesByDay.get(date)||[],batches=importsByDay.get(date)||[],pool=adsByDay.get(key(s.site,s.channel,date))||[];
   const sources={batches:batches.map(r=>({id:r.id,kind:r.report_kind})),salesIds:day.map(r=>r.id),currency:SITE_CURRENCIES[s.site]};
   if(!complete.has(date))add('report',s.site,s.channel,date,'','补齐完整日报','运营',items,{...sources,reason:batches.length?'仅部分日报或存在重叠记录':'未提交日报'},'/?page=sales&history=imports');
   const native=day.filter(r=>r.currency===SITE_CURRENCIES[s.site]);
   const adKnown=pool.some(r=>r.currency===SITE_CURRENCIES[s.site])||native.length>0&&native.every(r=>r.ad_cost!=null);
   if(!adKnown)add('ads',s.site,s.channel,date,'','核对店铺当天广告费','运营',items,{...sources,reason:'缺店铺总费用或完整SKU费用；无投放需明确确认0'},'/?page=sales&history=imports');
   const bad=day.filter(r=>r.currency!==SITE_CURRENCIES[s.site]||r.reported_amount==null);
   if(bad.length)add('money',s.site,s.channel,date,'','核对原币及销售金额','财务',bad,{...sources,reason:'金额缺失或币种不符合站点',rows:bad},'/?page=sales&history=imports');
   const repeated=groupBy(day.filter(r=>r.ad_cost>0),r=>key(r.currency,r.ad_cost));
   for(const rs of repeated.values())if(new Set(rs.map(r=>r.sku)).size>=3&&!pool.some(p=>p.currency===rs[0].currency))add('ad_repeat',s.site,s.channel,date,String(rs[0].ad_cost),'排查重复填写的店铺广告总额','财务',rs,{...sources,reason:'多SKU同额仅为疑点，须核对平台账单，不自动删除',rows:rs},'/?page=sales&history=imports');
  }
  const unverified=stock.filter(r=>!(availabilityBySku.get(key(r.site,r.channel,r.sku))||[]).some(v=>v.listed_since&&v.verified_through>=cutoff));
  if(unverified.length)add('availability',s.site,s.channel,'','','批量核验上架及连续有货证据','运营',unverified,{reason:'历史首销只作候选，不证明连续有货'},'/?page=business-actions');
 }
 for(const r of stocks.filter(r=>r.qty<0||r.qty-r.reserved_qty<0||r.reserved_qty<0))add('inventory',r.site,r.channel,'',r.sku,'核对库存与预留冲突','供应链',[r],{book:r.qty,reserved:r.reserved_qty,available:r.qty-r.reserved_qty,updatedAt:r.updated_at,reason:'按期初、入库、销售、调拨及预留逐笔核对；不得直接补零'},'/?page=inventory');
 const stockKeys=new Set(stocks.map(r=>key(r.site,r.channel,r.sku)));
 const missingStocks=sales.filter(r=>!stockKeys.has(key(r.site,r.channel,r.sku)));
 for(const r of [...new Map(missingStocks.map(r=>[key(r.site,r.channel,r.sku),r])).values()])add('inventory',r.site,r.channel,'',r.sku,'核对缺失库存记录','供应链',[r],{reason:'销售存在但库存记录缺失',saleId:r.id,batch:r.import_id},'/?page=inventory');
 for(const d of summary?[]:defects.filter(t=>t.kind==='inventory')){
  const trail=await rows(db,'SELECT id,movement_type,qty_delta,balance_after,reference_type,reference_id,note,created_at FROM inventory_movements WHERE site=? AND channel=? AND sku=? ORDER BY created_at DESC,rowid DESC LIMIT 61',[d.site,d.channel,d.sku]);
  d.sources.trail=trail.slice(0,60);d.sources.moreMovements=trail.length>60;
  d.sources.reservations=d.site==='印尼'?await rows(db,"SELECT o.id orderId,o.order_no,o.status,a.qty-a.shipped_qty-a.released_qty remaining FROM wholesale_allocations a JOIN wholesale_order_items i ON i.id=a.order_item_id JOIN wholesale_orders o ON o.id=i.order_id WHERE o.site=? AND a.channel=? AND i.sku=? AND a.qty-a.shipped_qty-a.released_qty>0",[d.site,d.channel,d.sku]):[];
 }
 // Finance dates are grouped across SKU and across the three action types.
 const actions=await rows(db,"SELECT id,site,channel,sku,snapshot_json FROM business_actions WHERE status<>'resolved'"+filter,args),finance=new Map();
 for(const r of actions){const snap=JSON.parse(r.snapshot_json);for(const d of snap.financeDays||[]){if(d.status==='confirmed')continue;const k=key(r.site,r.channel,d.date),v=finance.get(k)||{...r,date:d.date,items:[],actionIds:[]};v.items.push(r);v.actionIds.push(r.id);finance.set(k,v);}}
 for(const g of finance.values())add('cost',g.site,g.channel,g.date,'','核对当日成本及凭据','财务',g.items,{reason:'先补共同来源，再核对真实成本归属；滚动复用已核实日期',actionIds:[...new Set(g.actionIds)]},'/?page=cost-profit');
 const savedByKey=new Map(saved.map(row=>[row.task_key,row]));
 const tasks=await Promise.all(defects.map(async d=>{const old=savedByKey.get(d.key);return {...d,correction:old&&old.status!=='resolved'?JSON.parse(old.snapshot_json).correction:null,basisHash:summary?'':await hash(d),version:old?.version||0,ownerId:old?.owner_id||'',dueAt:old?.due_at||'',status:old?.status==='resolved'?'reopened':old?.status||'open'};}));
 for(const old of saved)if(!tasks.some(t=>t.key===old.task_key))tasks.push({...JSON.parse(old.snapshot_json),key:old.task_key,version:old.version,ownerId:old.owner_id,dueAt:old.due_at,status:old.status==='resolved'?'resolved':'review_ready',basisHash:'cleared'});
 if(await clock(db)!==sourceVersion)fail('证据已更新，请刷新',409);
 const visibleTasks=a.role==='供应链'?tasks.filter(t=>!['money','ad_repeat'].includes(t.kind)):tasks;
 for(const task of visibleTasks){
   if(['money','ad_repeat'].includes(task.kind)&&a.role==='财务')
     task.href='/?page=business-actions&view=evidence&entity='+encodeURIComponent(task.key);
 }
 if(summary){
   const showValue=['管理员','财务','运营','运营主管'].includes(a.role);
   const costs=!showValue?[]:await rows(db,'SELECT site,sku,total,purchase,freight,effective_date FROM product_cost_versions WHERE 1=1'+(a.role==='运营'?' AND site=?':'')+' ORDER BY effective_date DESC,version DESC',a.role==='运营'?[a.site]:[]);
   const units=new Map();
   for(const c of costs){const k=key(c.site,c.sku);if(!units.has(k)&&c.effective_date<=localDay(now,c.site))units.set(k,c.total??(c.purchase!=null&&c.freight!=null?c.purchase+c.freight:null));}
   const balances=new Map(stocks.map(b=>[key(b.site,b.channel,b.sku),b]));
   const items=visibleTasks.filter(t=>t.status!=='resolved'&&(a.role==='管理员'||a.role==='运营主管'||t.role===a.role||t.correction?.userId===a.id)).map(t=>{
     let value=0,unknown=0;
     for(const sku of t.skus){const stock=balances.get(key(t.site,t.channel,sku)),unit=units.get(key(t.site,sku));
       if(!stock||stock.qty<0||stock.reserved_qty<0||stock.qty<stock.reserved_qty||unit==null)unknown++;
       else value+=(stock.qty-stock.reserved_qty)*unit;
     }
     const possible=users.filter(u=>u.role===t.role&&actionScope(u,t));
     return {key:t.key,kind:t.kind,ownerId:t.ownerId,title:t.title,site:t.site,channel:t.channel,date:t.date,skuCount:t.skus.length,showValue,unknown,valueCny:unknown===t.skus.length?null:value/10000,
       status:t.status,role:t.role,owner:users.find(u=>u.id===t.ownerId)?.name||'',suggested:possible.length===1?possible[0].name:'',mine:t.ownerId===a.id||t.correction?.userId===a.id};
   }).sort((x,y)=>Number(y.mine)-Number(x.mine)||y.skuCount-x.skuCount||(y.valueCny??-1)-(x.valueCny??-1)||x.date.localeCompare(y.date));
   const groups=new Map();
   for(const item of items){const id=key(item.kind,item.site,item.channel,item.ownerId,item.status==='review_ready');const g=groups.get(id);if(g){g.taskCount++;if(item.date<g.firstDate)g.firstDate=item.date;if(item.date>g.lastDate)g.lastDate=item.date;}else groups.set(id,{...item,taskCount:1,firstDate:item.date,lastDate:item.date});}
   return {count:items.length,groupCount:groups.size,items:[...groups.values()].slice(0,5),generatedAt:now.toISOString()};
 }
 const taskKeys=new Set(visibleTasks.map(t=>t.key)),events=(await rows(db,'SELECT e.*,u.name actorName FROM evidence_task_events e JOIN users u ON u.id=e.actor_id ORDER BY e.created_at DESC')).filter(e=>taskKeys.has(e.task_key)).map(e=>({...e,detail:JSON.parse(e.detail_json),detail_json:undefined}));
 return {tasks:visibleTasks,groups:groupEvidenceTasks(visibleTasks,now),events,users:users.filter(u=>a.role!=='运营'||u.role!=='运营'||u.site===a.site&&u.channel===a.channel),sourceVersion,actor:{id:a.id,role:a.role},generatedAt:now.toISOString()};
}
export async function readEvidenceVoucher(db,a,taskKey){
 await access(db,a);
 let parts;try{parts=JSON.parse(taskKey);}catch{fail('无效的日报凭据',400);}
 if(!Array.isArray(parts)||parts.length!==5||!parts.every(v=>typeof v==='string'))fail('无效的日报凭据');
 const [kind,site,channel,date,amount]=parts;
 if(!['money','ad_repeat'].includes(kind)||!zeroSalesSites.includes(site)||!['TikTok','Shopee'].includes(channel)||!/^\d{4}-\d\d-\d\d$/.test(date)||a.role==='供应链'||!actionScope(a,{site,channel}))fail('未找到当前岗位可核对的凭据',404);
 const source=await rows(db,`SELECT r.import_id,r.sku,r.business_date,r.qty,r.currency,r.reported_amount,r.ad_cost,r.reversed_at,u.name recorder
   FROM sales_records r LEFT JOIN users u ON u.id=r.actor_id WHERE r.site=? AND r.channel=? AND r.business_date=?
   ORDER BY r.created_at DESC,r.id`,[site,channel,date]);
 const saved=await db.prepare('SELECT snapshot_json FROM evidence_tasks WHERE task_key=?').bind(taskKey).first();
 const affected=new Set(saved?JSON.parse(saved.snapshot_json).skus:[]);
 const current=source.filter(r=>!r.reversed_at);
 if(kind==='money'){
   for(const r of current)if(r.currency!==SITE_CURRENCIES[site]||r.reported_amount==null)affected.add(r.sku);
 }else{
   const pools=new Set((await rows(db,'SELECT currency FROM sales_ad_spend WHERE site=? AND channel=? AND business_date=? AND deleted_at IS NULL',[site,channel,date])).map(r=>r.currency));
   const groups=new Map();
   for(const r of current)if(Number(amount)>0&&r.ad_cost===Number(amount)&&!pools.has(r.currency)){
     if(!groups.has(r.currency))groups.set(r.currency,new Set());
     groups.get(r.currency).add(r.sku);
   }
   for(const skus of groups.values())if(skus.size>=3)for(const sku of skus)affected.add(sku);
 }
 if(!affected.size)fail('此凭据已更新，请刷新核对任务',404);
 return {rows:source.filter(r=>affected.has(r.sku))};
}

export async function evidenceHandoffs(db,a){
 if(!['财务','运营','管理员'].includes(a.role))return [];
 const saved=await rows(db,`SELECT task_key,site,channel,owner_id,snapshot_json FROM evidence_tasks WHERE status<>'resolved' AND json_extract(snapshot_json,'$.correction.userId') IS NOT NULL
   AND (owner_id=? OR json_extract(snapshot_json,'$.correction.userId')=? OR ?='管理员')`,[a.id,a.id,a.role]);
 const tasks=[];
 for(const row of saved){
   const t=JSON.parse(row.snapshot_json);
   if(a.role==='运营'&&(a.site!==t.site||a.channel!==t.channel))continue;
   const values=[t.site,t.channel,t.date];
   let defect;
   if(t.kind==='money')defect=await db.prepare('SELECT 1 FROM sales_records WHERE site=? AND channel=? AND business_date=? AND reversed_at IS NULL AND (reported_amount IS NULL OR currency<>?) LIMIT 1').bind(...values,SITE_CURRENCIES[t.site]).first();
   else if(t.kind==='ad_repeat')defect=await db.prepare(`SELECT 1 FROM sales_records r WHERE site=? AND channel=? AND business_date=? AND reversed_at IS NULL AND ad_cost=?
     AND NOT EXISTS(SELECT 1 FROM sales_ad_spend a WHERE a.site=r.site AND a.channel=r.channel AND a.business_date=r.business_date AND a.currency=r.currency AND a.deleted_at IS NULL)
     GROUP BY currency HAVING COUNT(DISTINCT sku)>=3`).bind(...values,Number(t.sku)).first();
   else continue;
   if(defect?t.correction.userId!==a.id:row.owner_id!==a.id&&!(a.role==='管理员'&&!row.owner_id))continue;
   tasks.push({tab:'business-actions',view:'evidence',entity:row.task_key,title:defect?'更正财务退回的日报':'复核运营已更正的日报',detail:[t.site,t.channel,t.date,t.correction.note].join(' · '),level:'amber'});
 }
 return tasks;
}

export async function mutateEvidenceTask(db,a,p,now=new Date()){
 await access(db,a);await assertWritable(db);const data=await readEvidenceWorkbench(db,a,now);
 if(p.action==='evidenceBulkAssign'){
  if(a.role!=='管理员')fail('仅管理员可批量分配',403);
  if(!Array.isArray(p.items)||!p.items.length||p.items.length>50||new Set(p.items.map(i=>i.key)).size!==p.items.length)fail('每次选择1至50项不同任务');
  const selected=p.items.map(i=>data.tasks.find(t=>t.key===i.key));
  if(selected.some(t=>!t||t.status==='resolved'||t.status==='review_ready')||new Set(selected.map(t=>key(t.kind,t.site,t.channel,t.role))).size!==1)fail('请选择同一问题类型、站点、渠道和岗位的待核对任务');
  const statements=p.items.flatMap(i=>evidenceStatements(db,a,{...p,...i,action:'evidenceAssign'},data,now));
  await atomicBatch(db,statements);return {ok:true,count:p.items.length};
 }
 await atomicBatch(db,evidenceStatements(db,a,p,data,now));return {ok:true};
}
function evidenceStatements(db,a,p,data,now){
 const t=data.tasks.find(t=>t.key===p.key);
 if(!t||t.version!==p.version||t.basisHash!==p.basisHash)fail('任务或来源已变化，请刷新核对',409);
 const note=String(p.note||'').trim();if(note.length<4||note.length>2000)fail('请填写核对依据或处理说明');
 let ownerId=t.ownerId,dueAt=t.dueAt,status=t.status,correction=t.correction||null;
 const extra=[];
 if(p.action==='evidenceAssign'){
  if(a.role!=='管理员')fail('仅管理员确认唯一核对人',403);const u=data.users.find(u=>u.id===p.ownerId&&u.role===t.role&&actionScope(u,t));if(!u)fail('请选择对应岗位及站点渠道的有效人员');
  const due=Date.parse(p.dueAt);if(!Number.isFinite(due)||due<+now||due>+now+90*86400000)fail('截止时间须为未来90天内');ownerId=u.id;dueAt=new Date(due).toISOString();status='open';
 }else if(p.action==='evidenceReturn'){
   if(!['管理员','财务'].includes(a.role)||!['money','ad_repeat'].includes(t.kind)||t.basisHash==='cleared'||(ownerId&&ownerId!==a.id&&a.role!=='管理员'))fail('仅负责财务或管理员可退回该日报',403);
   const recipient=data.users.find(u=>u.id===p.operatorId&&u.role==='运营'&&u.site===t.site&&u.channel===t.channel);
   if(!recipient)fail('请选择本站点、渠道的录入运营');
   extra.push(guardStatement(db,a,'evidence.return',"EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role='运营' AND site=? AND channel=?)",[recipient.id,t.site,t.channel]));
   if(!ownerId&&a.role==='财务')ownerId=a.id;
   correction={userId:recipient.id,note,requestedAt:now.toISOString()};status='in_progress';
 }else if(p.action==='evidenceStart'){
  if(a.id!==ownerId)fail('请由已指定核对人处理',403);status='in_progress';
 }else if(p.action==='evidenceReview'){
  if(a.id!==ownerId&&a.role!=='管理员')fail('由核对人或管理员复查',403);if(t.basisHash!=='cleared')fail('原始证据缺口仍存在，请先在原单据修正；不能仅凭已执行结案');status='resolved';correction=null;
 }else fail('不支持的证据任务动作');
 return [guardStatement(db,a,p.action,"COALESCE((SELECT version FROM evidence_tasks WHERE task_key=?),0)=? AND COALESCE((SELECT version FROM business_action_source_clock WHERE id='global'),0)=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role=?)",[t.key,t.version,data.sourceVersion,a.id,a.role]),...extra,...(ownerId?[guardStatement(db,a,'evidence.owner',"EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role=? AND (?<>'运营' OR (site=? AND channel=?)))",[ownerId,t.role,t.role,t.site,t.channel])]:[]),db.prepare('INSERT INTO evidence_tasks VALUES(?,?,?,?,?,?,1,?,?) ON CONFLICT(task_key) DO UPDATE SET owner_id=excluded.owner_id,due_at=excluded.due_at,status=excluded.status,version=evidence_tasks.version+1,updated_at=excluded.updated_at,snapshot_json=excluded.snapshot_json').bind(t.key,t.site,t.channel,ownerId||null,dueAt||null,status,now.toISOString(),JSON.stringify({...t,correction})),db.prepare('INSERT INTO evidence_task_events VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),t.key,p.action,JSON.stringify({note,before:t.status,status,ownerId,dueAt,correction,basisHash:t.basisHash}),a.id,now.toISOString())];
}

export function groupEvidenceTasks(tasks,now=new Date()){
 const groups=new Map();
 for(const t of tasks.filter(t=>t.status!=='resolved')){
  const id=key(t.kind,t.site,t.channel,t.role,t.ownerId||''),g=groups.get(id)||{id,kind:t.kind,title:t.title,site:t.site,channel:t.channel,role:t.role,ownerId:t.ownerId||'',count:0,overdue:0,review:0,skus:new Set(),keys:[],firstDate:'',lastDate:''};
  g.count++;g.overdue+=Number(Boolean(t.dueAt&&Date.parse(t.dueAt)<+now));g.review+=Number(t.status==='review_ready');
  for(const sku of t.skus||[])g.skus.add(sku);g.keys.push(t.key);
  if(t.date){g.firstDate=!g.firstDate||t.date<g.firstDate?t.date:g.firstDate;g.lastDate=t.date>g.lastDate?t.date:g.lastDate;}
  groups.set(id,g);
 }
 return [...groups.values()].map(g=>({...g,skuCount:g.skus.size,skus:undefined})).sort((a,b)=>b.overdue-a.overdue||b.review-a.review||b.skuCount-a.skuCount);
}
