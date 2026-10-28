import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';
import {CostError,fail,text,number,date,fx,money,cents,allocate,consumedCost,ticketCosts,warehouseCost,contribution,simulate,marketState} from './cost-profit-model.mjs';
import {costSalesSources} from './cost-sale-sources.mjs';
import {skuContributions} from './cost-profit-allocation.mjs';
import {financeClock,financeGuardSql,assertFinanceOpen,closedFinanceMonths} from './finance-periods.mjs';
export {CostError};
const roles=['管理员','财务','运营','运营主管','供应链'];
const rows=async(db,sql,args=[])=>(await db.prepare(sql).bind(...args).all()).results||[];
const omit=(o,keys)=>Object.fromEntries(Object.entries(o).filter(([k])=>!keys.includes(k)));
const identifier=(v,label)=>{const s=text(v,label,120);if([...s].some(c=>c==='|'||c.charCodeAt(0)<32))fail(label+'不能含竖线或控制字符');return s;};
const parse=r=>({...r,data:JSON.parse(r.data_json)});
const key=r=>r.kind+'|'+r.business_key;
const latest=rs=>[...rs.reduce((m,r)=>{if(!m.has(key(r))||m.get(key(r)).revision<r.revision)m.set(key(r),r);return m;},new Map()).values()];
const digest=async v=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(v)))),b=>b.toString(16).padStart(2,'0')).join('');
const scope=(a,r)=>a.role!=='运营'||a.site===r.site&&a.channel===r.channel;
const validScope=p=>{const site=text(p.site,'站点'),channel=text(p.channel,'渠道');if(!['马来西亚','印尼','泰国','越南','菲律宾'].includes(site)||!['TikTok','Shopee','线下分销'].includes(channel))fail('站点/渠道无效');return {site,channel};};
const revision=p=>number(p.revision,'当前修订号',{integer:true,max:1e6});
const fee=p=>({...money(p?.amount,p?.state,p?.source),...fx(p||{})});
const identity=d=>JSON.stringify(d.lines.map(l=>({lineKey:l.lineKey,sku:l.sku,batch:l.batch,qty:l.qty})).sort((a,b)=>a.lineKey.localeCompare(b.lineKey)));
const saleSignature=s=>JSON.stringify([s.id,s.qty,s.reported_amount,s.currency,s.reversed_at,s.business_date,...(s.stockChannels?[s.stockChannels]:[])]);
export async function costAccess(db,a,mode='read'){
 if(!a||!roles.includes(a.role))fail('当前岗位不可访问成本利润账册',403);
 const live=await db.prepare('SELECT active,role,site,channel FROM users WHERE id=?').bind(a.id).first();
 if(!live||live.active!==1||live.role!==a.role||a.role==='运营'&&(live.site!==a.site||live.channel!==a.channel))fail('账号权限已变化',403);
 const grant=await db.prepare('SELECT * FROM cost_access WHERE user_id=?').bind(a.id).first();
 const allowed=mode==='analysis'?['管理员','财务','运营','运营主管'].includes(a.role)&&(a.role==='管理员'||grant?.can_read===1&&grant?.can_write===1):mode==='read'?a.role==='管理员'||grant?.can_read===1:mode==='write'?['管理员','财务','供应链'].includes(a.role)&&(a.role==='管理员'||grant?.can_read===1&&grant?.can_write===1):a.role==='财务'&&grant?.can_read===1&&grant?.can_review===1;
 if(!allowed)fail('成本账册权限尚未启用；录入与财务复核独立授权',403);
 return {canAnalyze:['管理员','财务','运营','运营主管'].includes(a.role)&&(a.role==='管理员'||grant?.can_write===1),canWrite:['管理员','财务','供应链'].includes(a.role)&&(a.role==='管理员'||grant?.can_write===1),canReview:a.role==='财务'&&grant?.can_review===1};
}
const clock=financeClock;
async function records(db,a){const f=a.role==='运营'?' WHERE c.site=? AND c.channel=?':'';return (await rows(db,`SELECT c.*,r.tax_treatment,r.note review_note,r.actor_id reviewer_id,r.created_at reviewed_at FROM cost_records c LEFT JOIN cost_reviews r ON r.record_id=c.id${f} ORDER BY c.created_at,c.id`,a.role==='运营'?[a.site,a.channel]:[])).map(parse);}
const sales=costSalesSources;
function audit(db,a,id,action,detail){return db.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),action,'cost_profit',id,JSON.stringify(detail),a.id,a.name,new Date().toISOString());}
function insert(db,a,p){return db.prepare('INSERT INTO cost_records(id,kind,business_key,site,channel,revision,business_date,data_json,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(p.id,p.kind,p.business_key,p.site,p.channel,p.revision,p.business_date,JSON.stringify(p.data),p.reason,a.id,p.created_at);}
function guard(db,a,version){const g=financeGuardSql(version);return guardStatement(db,a,'cost-profit.write',g.sql+' AND EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role=?)',[...g.args,a.id,a.role]);}
async function write(db,a,version,statements){await assertWritable(db);try{await atomicBatch(db,[guard(db,a,version),...statements]);}catch(e){if(/UNIQUE constraint/.test(String(e)))fail('重复业务键、重复导入或并发修订，本次未写入',409);throw e;}}
function newRecord(a,kind,p,data){return {id:crypto.randomUUID(),kind,business_key:identifier(p.businessKey,'业务单号'),...validScope(p),revision:revision(p)+1,business_date:date(p.businessDate),data,reason:text(p.reason,'新增/修订原因',1000),actor_id:a.id,created_at:new Date().toISOString()};}
async function normalizeTicket(db,p){
 const d={warehouse:text(p.warehouse,'仓库'),legId:text(p.legId,'系统运输分腿ID',120,true),effectiveAt:date(p.effectiveAt),source:text(p.source,'票次依据',1000),lines:[]};
 if(d.legId){const leg=await db.prepare('SELECT * FROM transport_legs WHERE id=?').bind(d.legId).first();if(!leg||leg.site!==p.site||leg.channel!==p.channel||leg.warehouse_name!==d.warehouse)fail('关联运输分腿的站点、渠道或仓库不一致');}
 if(!Array.isArray(p.lines)||!p.lines.length||p.lines.length>200)fail('每票须有1—200行商品');
 const seen=new Set();for(const l of p.lines){try{const line={lineKey:identifier(l.lineKey,'票内唯一行号'),sku:text(l.sku,'SKU',120).toUpperCase(),batch:text(l.batch,'采购/生产子批次',120),qty:number(l.qty,'数量',{min:1,integer:true}),volume:number(l.volume,'总体积'),weight:number(l.weight,'总重量'),...fee(l)};if(seen.has(line.lineKey))fail('票内行号重复');seen.add(line.lineKey);if(!await db.prepare('SELECT sku FROM sku_settings WHERE sku=?').bind(line.sku).first())fail(`未知SKU ${line.sku}`);d.lines.push(line);}catch(error){error.row=l._row;throw error;}}
 d.lines.sort((a,b)=>a.lineKey.localeCompare(b.lineKey));
 for(const k of ['sea','tax','inbound']){if(k==='inbound'&&!p[k]?.state)p[k]={amount:null,state:'missing',source:'国内运输/保险/入仓费用范围待核实',currency:'CNY',fx:1,fxVersion:'待财务核定',basis:'qty'};d[k]={...fee(p[k]),basis:text(p[k]?.basis,'分摊依据')};if(!['qty','volume','weight'].includes(d[k].basis))fail('分摊依据须为 qty/volume/weight');if(d.lines.some(l=>l[d[k].basis]<=0))fail('每行分摊依据必须大于0（总体积/总重量）');}
 if(d.legId){const linked=await rows(db,'SELECT sku,SUM(qty) qty FROM transport_leg_items WHERE leg_id=? GROUP BY sku',[d.legId]);for(const l of linked){if(d.lines.filter(x=>x.sku===l.sku).reduce((s,x)=>s+x.qty,0)!==l.qty)fail('成本票次SKU数量必须与关联运输分腿完整一致');}if(d.lines.some(l=>!linked.some(x=>x.sku===l.sku)))fail('成本票次含运输分腿之外的SKU');}
 ticketCosts(d);return d;
}
function checkRevision(rs,r,allowRelink=false){const prev=latest(rs).find(x=>key(x)===key(r));if((prev?.revision||0)!==r.revision-1)fail(`单号 ${r.business_key} 已存在或版本变化；请明确填写当前修订号`,409);if(prev&&(prev.site!==r.site||prev.channel!==r.channel))fail('修订不能更改原站点/渠道');if(prev&&JSON.stringify(prev.data)===JSON.stringify(r.data))fail('相同业务内容已存在，无需重复导入',409);if(prev&&r.kind==='ticket'&&(identity(prev.data)!==identity(r.data)||prev.data.legId!==r.data.legId||prev.data.warehouse!==r.data.warehouse||prev.data.effectiveAt!==r.data.effectiveAt))fail('成本修订只能改金额、状态和证据，不能改变原批次、数量、运输分腿、仓库或生效日期');if(prev&&r.kind==='order'&&!allowRelink&&JSON.stringify(prev.data.lines)!==JSON.stringify(r.data.lines))fail('结算修订不能更改原出库关联；请核实来源');return prev;}
export async function previewCostImport(db,a,input){
 await costAccess(db,a,'write');if(!Array.isArray(input)||!input.length||input.length>200)fail('导入须为1—200行');
 const version=await clock(db),sourceVersion=(await db.prepare("SELECT version FROM business_action_source_clock WHERE id='global'").first())?.version||0,rs=await records(db,a),groups=new Map(),errors=[];
 input.forEach((r,i)=>{try{if(!r||typeof r!=='object')fail('行格式错误');const k=text(r.businessKey,'成本票号',120);if(!groups.has(k))groups.set(k,[]);groups.get(k).push({...r,_row:Number.isSafeInteger(r._row)&&r._row>=2?r._row:i+2});}catch(e){errors.push({row:i+2,message:e.message});}});
 if(groups.size>20)fail('每次最多20票，请拆分文件');const docs=[];
 for(const [businessKey,lines] of groups){try{
 const first=lines[0],shared=['site','channel','businessDate','revision','reason','warehouse','legId','effectiveAt','ticketSource','seaAmount','seaState','seaCurrency','seaFx','seaFxVersion','seaSource','seaBasis','taxAmount','taxState','taxCurrency','taxFx','taxFxVersion','taxSource','taxBasis','inboundAmount','inboundState','inboundCurrency','inboundFx','inboundFxVersion','inboundSource','inboundBasis'];
 if(lines.some(l=>shared.some(k=>String(l[k]??'')!==String(first[k]??''))))fail('同票表头字段不一致；海运/税费总额只计算一次，不能填写各行分摊额');
 const p={...first,businessKey,source:first.ticketSource,lines:lines.map(l=>({...l,amount:l.unitCost,source:l.productSource,state:l.productState})),...Object.fromEntries(['sea','tax','inbound'].map(k=>[k,{amount:first[k+'Amount'],state:first[k+'State'],currency:first[k+'Currency'],fx:first[k+'Fx'],fxVersion:first[k+'FxVersion'],source:first[k+'Source'],basis:first[k+'Basis']}]))};
 await assertFinanceOpen(db,p.effectiveAt);await assertFinanceOpen(db,p.businessDate);for(const o of latest(rs).filter(x=>x.kind==='order'&&!x.data.voided&&x.data.lines.some(l=>l.ticketKey===businessKey)))await assertFinanceOpen(db,o.business_date);
 const data=await normalizeTicket(db,p),r=newRecord(a,'ticket',p,data);checkRevision(rs,r);if(latest([...rs,...docs]).some(x=>x.kind==='ticket'&&x.business_key!==r.business_key&&x.site===r.site&&x.channel===r.channel&&(data.legId&&x.data.legId===data.legId||x.data.warehouse===data.warehouse&&x.data.source===data.source)))fail('同一运输分腿或同仓库票次凭据已有成本票，不能换单号重复导入',409);docs.push(r);
 }catch(e){if(e.row)errors.push({row:e.row,message:e.message+'；该票全部不写入'});else for(const l of lines)errors.push({row:l._row,message:e.message});}}
 const canonical=docs.map(r=>omit(r,['id','created_at','actor_id'])).sort((a,b)=>a.business_key.localeCompare(b.business_key));
 const fingerprint=await digest(canonical);if(!errors.length&&await db.prepare('SELECT fingerprint FROM cost_imports WHERE fingerprint=?').bind(fingerprint).first())errors.push({row:0,message:'相同内容已导入，请勿重复提交'});
 if(((await db.prepare("SELECT version FROM business_action_source_clock WHERE id='global'").first())?.version||0)!==sourceVersion)fail('来源数据变化，请重新预览',409);
 return {version,sourceVersion,fingerprint,errors,documents:docs,preview:docs.map(r=>({businessKey:r.business_key,revision:r.revision,site:r.site,channel:r.channel,lines:ticketCosts(r.data),status:'待财务复核'}))};
}
export async function commitCostImport(db,a,p){const preview=await previewCostImport(db,a,p.rows);if(preview.errors.length)fail(preview.errors.map(e=>`第${e.row}行：${e.message}`).join('；'));if(p.version!==preview.version||p.fingerprint!==preview.fingerprint)fail('预览已过期或内容有变化，请重新预览',409);const ids=preview.documents.map(r=>r.id);await write(db,a,preview.version,[guardStatement(db,a,'cost-profit.import-source',"COALESCE((SELECT version FROM business_action_source_clock WHERE id='global'),0)=?",[preview.sourceVersion]),...preview.documents.flatMap(r=>[insert(db,a,r),audit(db,a,r.id,'cost.import',{businessKey:r.business_key,revision:r.revision,fingerprint:preview.fingerprint})]),db.prepare('INSERT INTO cost_imports VALUES(?,?,?,?,?)').bind(preview.fingerprint,text(p.fileName,'文件名'),JSON.stringify(ids),a.id,new Date().toISOString())]);return {ok:true,ids};}

// Current contribution uses latest reviewed cost revisions. Stored order snapshots never change.
export function costState(allRecords,saleRows){
 const rs=latest(allRecords),tickets=rs.filter(r=>r.kind==='ticket'),orders=rs.filter(r=>r.kind==='order'&&!r.data.voided).sort((a,b)=>a.data.sequence.localeCompare(b.data.sequence)),lots=new Map(),saleMap=new Map(saleRows.map(s=>[s.id,s])),usedSales=new Map();
 for(const t of tickets)for(const l of ticketCosts(t.data,t.tax_treatment||'inventory'))lots.set(t.business_key+'|'+l.lineKey,{...l,ticket:t,used:0,sold:{product:0,sea:0,tax:0,inbound:0}});
 const ads=new Map();for(const ad of rs.filter(r=>r.kind==='advertising')){const values=allocate(cents(ad.data.amount*ad.data.fx),ad.data.allocations.map(x=>x.weight));ad.data.allocations.forEach((x,i)=>ads.set(x.orderKey,{amount:values[i],record:ad}));}
 const result=orders.map(o=>{
 const d=o.data,costs={product:0,sea:0,tax:0,inbound:0},missing=[],evidence=[];let estimated=false;
 for(const line of d.lines){const l=lots.get(line.ticketKey+'|'+line.lineKey),s=saleMap.get(line.salesRecordId);usedSales.set(line.salesRecordId,(usedSales.get(line.salesRecordId)||0)+line.qty);
 if(!s||s.reversed_at||saleSignature(s)!==d.salesBasis[line.salesRecordId])missing.push('销售依据已变更/冲销');
 if(!l){missing.push('缺少批次');for(const k of Object.keys(costs))costs[k]=null;continue;}const before=l.used;l.used+=line.qty;
 if(l.used>l.qty)missing.push('出库关联数量超过批次');if(!l.ticket.reviewed_at)missing.push('最新成本待财务复核');if(l.missing.length)missing.push(...l.missing);estimated ||= l.estimated;
 const share={};for(const k of Object.keys(costs)){const total=l.costs[k];share[k]=total==null?null:consumedCost(total,before,line.qty,l.qty);if(share[k]==null){missing.push('缺失'+k);costs[k]=null;}else{if(costs[k]!=null)costs[k]+=share[k];l.sold[k]+=share[k];}}evidence.push({...line,sku:l.sku,batch:l.batch,costs:share,costRecordId:l.ticket.id,costRevision:l.ticket.revision,source:l.source});
 }
 const convert=f=>f.amount==null?null:cents(f.amount*d.fx),ad=d.adMode==='allocated'?(ads.get(o.business_key)?.amount??null):convert(d.advertising);
 if(d.adMode==='allocated'&&ad==null)missing.push('共享广告尚未分摊');
 if(d.adMode==='allocated'&&ads.has(o.business_key)){const pool=ads.get(o.business_key).record;const basis=pool.data.allocations.find(x=>x.orderKey===o.business_key)?.basis;if(basis!==JSON.stringify([d.revenue,d.revenueBasis,d.fx,d.platform]))missing.push('共享广告收入依据已变化，请修订费用池');estimated ||= pool.data.state==='estimated';}
 for(const [k,f] of Object.entries({platform:d.platform,refund:d.refund,advertising:d.adMode==='direct'?d.advertising:{state:'actual'},warehouse:d.warehouse})){if(['missing','pending'].includes(f.state))missing.push(k+'待核实');estimated ||= f.state==='estimated';}
 const calc=contribution({revenue:cents(d.revenue*d.fx),basis:d.revenueBasis,...costs,platform:convert(d.platform),warehouse:d.warehouse.amount==null?null:cents(d.warehouse.amount*d.fx),advertising:ad,refund:convert(d.refund)});
 // Compare against the first saved settlement without rewriting any revision snapshot.
 const first=allRecords.filter(r=>r.kind==='order'&&r.business_key===o.business_key).sort((a,b)=>a.revision-b.revision)[0];
 const comparisonSnapshot=first?.data.snapshot||d.snapshot||null;
 return {...o,quantity:d.lines.reduce((s,l)=>s+l.qty,0),...calc,contribution:missing.length?null:calc.contribution,missing:[...new Set(missing)],estimated,evidence,adAttribution:d.adMode==='allocated'?{mode:'按收入分摊',pool:ads.get(o.business_key)?.record.business_key}: {mode:'直接归属'},snapshot:d.snapshot||null,comparisonSnapshot,adjustment:comparisonSnapshot?.contribution!=null&&calc.contribution!=null&&!missing.length?calc.contribution-comparisonSnapshot.contribution:null};
 });
 for(const o of result)if(o.data.lines.some(l=>(usedSales.get(l.salesRecordId)||0)>(saleMap.get(l.salesRecordId)?.qty||0))){o.missing.push('销售关联总数量超过来源');o.contribution=null;}
 return {orders:result,lots:[...lots.values()].map(l=>({...l,remainingQty:l.qty-l.used,remaining:Object.fromEntries(Object.entries(l.costs).map(([k,n])=>[k,n==null?null:n-l.sold[k]]))})),usedSales};
}
async function normalizeOrder(db,a,p,rs,saleRows){
 const d={allocationBasis:p.allocationBasis==='quantity'?'quantity':'source_revenue',...fx(p),revenue:number(p.revenue,'收入/净结算金额'),revenueBasis:text(p.revenueBasis,'收入口径'),source:text(p.source,'结算及出库依据',1000),traceBasis:text(p.traceBasis,'批次关联依据'),traceNote:text(p.traceNote,'关联凭据/计价约定',1000),adMode:text(p.adMode,'广告归属'),lines:[],salesBasis:{}};
 if(!['gross','net'].includes(d.revenueBasis))fail('收入口径须为 gross 或 net');if(!['evidence_manual','valuation_convention'].includes(d.traceBasis))fail('须明确人工凭证关联或计价约定');if(!['direct','allocated'].includes(d.adMode))fail('广告归属无效');
 if(!Array.isArray(p.lines)||!p.lines.length||p.lines.length>100)fail('出库关联须有1—100行');const tickets=latest(rs).filter(r=>r.kind==='ticket'),seen=new Set();
 const other=latest(rs).filter(r=>r.kind==='order'&&!r.data.voided&&r.business_key!==p.businessKey),usedLots=new Map(),usedSales=new Map();for(const o of other)for(const l of o.data.lines){const k=l.ticketKey+'|'+l.lineKey;usedLots.set(k,(usedLots.get(k)||0)+l.qty);usedSales.set(l.salesRecordId,(usedSales.get(l.salesRecordId)||0)+l.qty);}
 for(const line of p.lines){const l={ticketKey:text(line.ticketKey,'成本票号',120),lineKey:text(line.lineKey,'票内行号',120),salesRecordId:text(line.salesRecordId,'销售来源ID',120),qty:number(line.qty,'出库数量',{min:1,integer:true})},k=l.ticketKey+'|'+l.lineKey+'|'+l.salesRecordId;if(seen.has(k))fail('出库关联行重复');seen.add(k);
 const t=tickets.find(t=>t.business_key===l.ticketKey),lot=t?.data.lines.find(x=>x.lineKey===l.lineKey),sale=saleRows.find(s=>s.id===l.salesRecordId);
 const offline=p.site==='印尼'&&p.channel==='线下分销'&&['wholesale','consignment'].includes(sale?.sourceKind);
 if(!t||t.site!==p.site||(!offline&&t.channel!==p.channel)||!lot)fail('成本票次/行号或站点渠道不匹配');if(!sale||sale.reversed_at||sale.site!==p.site||sale.channel!==p.channel||sale.sku!==lot.sku||sale.business_date!==p.businessDate)fail('销售来源须为同日同SKU同站点渠道的有效记录');if(p.businessDate<t.data.effectiveAt)fail('销售日期早于成本生效日期');
 const lotKey=l.ticketKey+'|'+l.lineKey;usedLots.set(lotKey,(usedLots.get(lotKey)||0)+l.qty);usedSales.set(l.salesRecordId,(usedSales.get(l.salesRecordId)||0)+l.qty);if(usedLots.get(lotKey)>lot.qty||usedSales.get(l.salesRecordId)>sale.qty)fail('累计关联数量超过成本批次或真实销售数量');
 if(offline){if(d.traceBasis!=='evidence_manual')fail('线下出库须按真实凭据关联原成本批次');const capacity=sale.stockChannels?.find(c=>c.channel===t.channel)?.qty||0;const associated=[...other.flatMap(o=>o.data.lines),...d.lines];const consumed=associated.reduce((n,x)=>{const src=saleRows.find(s=>s.id===x.salesRecordId),ticket=tickets.find(c=>c.business_key===x.ticketKey);return n+(src?.stockSourceKey===sale.stockSourceKey&&ticket?.channel===t.channel?x.qty:0);},0);if(consumed+l.qty>capacity)fail('成本批次渠道与原出库份额不符，或累计关联超过该渠道实际出货量');}
 d.salesBasis[sale.id]=saleSignature(sale);d.lines.push(l);
 }
 for(const k of ['platform','refund','advertising'])d[k]=money(p[k]?.amount,p[k]?.state,p[k]?.source);
 if(d.adMode==='allocated'&&d.advertising.state!=='not_applicable')fail('共享广告模式下直接广告填0及not_applicable，避免重复计费');
 const qty=d.lines.reduce((s,l)=>s+l.qty,0),w=p.warehouse||{};d.warehouse=['pending','missing'].includes(w.state)?money(null,w.state,w.source):{...money(warehouseCost(w,qty)/100,w.state,w.source),perOrder:number(w.perOrder,'每单费用'),perParcel:number(w.perParcel,'每包裹费用'),perItem:number(w.perItem,'每件费用'),parcels:number(w.parcels,'包裹数',{min:1,integer:true})};
 const prev=latest(rs).find(r=>r.kind==='order'&&r.business_key===p.businessKey);d.sequence=prev?.data.sequence||new Date().toISOString()+'|'+p.businessKey;
 return d;
}
export async function mutateCost(db,a,p){
 if(p.action==='previewImport'){const v=await previewCostImport(db,a,p.rows);return omit(v,['documents']);}
 if(p.action==='commitImport')return commitCostImport(db,a,p);
 if(p.action==='correctTicket'){
  await costAccess(db,a,'write');if(!['管理员','财务'].includes(a.role))fail('批次数量纠错由管理员或财务登记',403);const version=await clock(db),rs=await records(db,a),prev=latest(rs).find(r=>r.kind==='ticket'&&r.business_key===p.businessKey);if(!prev)fail('成本票次不存在',404);if(revision(p)!==prev.revision)fail('成本票次版本已变化',409);
  await assertFinanceOpen(db,prev.business_date);await assertFinanceOpen(db,prev.data.effectiveAt);
  if(!Array.isArray(p.quantities)||p.quantities.length!==prev.data.lines.length||new Set(p.quantities.map(q=>q.lineKey)).size!==p.quantities.length)fail('请逐行核对原批次全部数量');
  const input={...prev.data,site:prev.site,channel:prev.channel,lines:prev.data.lines.map(l=>({...l,qty:p.quantities.find(q=>q.lineKey===l.lineKey)?.qty}))};const data=await normalizeTicket(db,input);
  const orders=latest(rs).filter(r=>r.kind==='order'&&!r.data.voided);for(const o of orders.filter(o=>o.data.lines.some(l=>l.ticketKey===prev.business_key)))await assertFinanceOpen(db,o.business_date);
  for(const l of data.lines){const used=orders.flatMap(o=>o.data.lines).filter(x=>x.ticketKey===prev.business_key&&x.lineKey===l.lineKey).reduce((s,x)=>s+x.qty,0);if(used>l.qty)fail('修订数量小于已关联数量，请先纠正或作废错误结算关联');}
  const r=newRecord(a,'ticket',{...p,site:prev.site,channel:prev.channel,businessDate:prev.business_date},data);if(identity(data)===identity(prev.data))fail('数量未变化');await write(db,a,version,[insert(db,a,r),audit(db,a,r.id,'cost.correctTicket',{businessKey:r.business_key,revision:r.revision,reason:r.reason})]);return {ok:true,id:r.id};
 }
 if(p.action==='review'){
 await costAccess(db,a,'review');const version=await clock(db),r=(await records(db,a)).find(r=>r.id===p.id);if(!r||r.kind!=='ticket'||!scope(a,r))fail('成本票次不存在',404);if(r.actor_id===a.id)fail('录入人不能复核自己的成本版本',403);if(r.reviewed_at)fail('此版本已经复核',409);const current=await db.prepare("SELECT MAX(revision) revision FROM cost_records WHERE kind='ticket' AND business_key=?").bind(r.business_key).first();if(current.revision!==r.revision)fail('已有更新版本，请复核最新修订',409);
 await assertFinanceOpen(db,r.data.effectiveAt);for(const o of latest(await records(db,a)).filter(x=>x.kind==='order'&&!x.data.voided&&x.data.lines.some(l=>l.ticketKey===r.business_key)))await assertFinanceOpen(db,o.business_date);
 const treatment=text(p.taxTreatment,'税费分类'),note=text(p.note,'复核依据',1000);if(!['inventory','period','recoverable','not_applicable'].includes(treatment))fail('税费分类无效');if(treatment==='not_applicable'&&r.data.tax.state!=='not_applicable')fail('不适用分类只接受已明确不适用的税费');
 await write(db,a,version,[db.prepare('INSERT INTO cost_reviews VALUES(?,?,?,?,?)').bind(r.id,treatment,note,a.id,new Date().toISOString()),audit(db,a,r.id,'cost.review',{taxTreatment:treatment,note})]);return {ok:true};
 }
 const mode=p.action==='simulation'||p.action==='market'?'analysis':'write';await costAccess(db,a,mode);if(!['order','replaceOrder','voidOrder','market','simulation','advertising'].includes(p.action))fail('不支持的成本动作');if(['order','replaceOrder','voidOrder','advertising'].includes(p.action)&&!['管理员','财务'].includes(a.role))fail('结算/广告分摊仅由财务或管理员录入',403);if(p.action==='market'&&!['管理员','财务','运营','运营主管'].includes(a.role))fail('当前岗位不可维护市场证据',403);
 const version=await clock(db),rs=await records(db,a),saleRows=await sales(db,a),s=validScope(p);if(!scope(a,s))fail('无权操作其他站点渠道',403);let data;
 if(['order','replaceOrder'].includes(p.action))data=await normalizeOrder(db,a,p,rs,saleRows);
 if(p.action==='voidOrder'){const previous=latest(rs).find(r=>r.kind==='order'&&r.business_key===p.businessKey);if(!previous||previous.data.voided)fail('有效结算单不存在',404);data={...previous.data,voided:true};}
 if(['order','replaceOrder','voidOrder','advertising'].includes(p.action)){await assertFinanceOpen(db,p.businessDate);const old=latest(rs).find(r=>r.business_key===p.businessKey&&r.kind===(p.action==='advertising'?'advertising':'order'));if(old){await assertFinanceOpen(db,old.business_date);if(old.business_date!==p.businessDate)fail('修订须保留原业务日期');}}
 if(p.action==='advertising'){
 data={...fee(p),source:text(p.source,'广告账单依据',1000),allocations:[]};if(data.amount==null)fail('分摊需已知总金额');if(!Array.isArray(p.orderKeys)||!p.orderKeys.length||p.orderKeys.length>100||new Set(p.orderKeys).size!==p.orderKeys.length)fail('共享广告须选择1—100个不重复订单');
 const orders=costState(rs,saleRows).orders,otherPools=latest(rs).filter(r=>r.kind==='advertising'&&r.business_key!==p.businessKey);
 const previousPool=latest(rs).find(r=>r.kind==='advertising'&&r.business_key===p.businessKey);for(const orderKey of new Set([...p.orderKeys,...(previousPool?.data.allocations||[]).map(x=>x.orderKey)])){const linked=latest(rs).find(r=>r.kind==='order'&&r.business_key===orderKey);if(linked)await assertFinanceOpen(db,linked.business_date);}
 for(const orderKey of [...p.orderKeys].sort()){const o=orders.find(r=>r.business_key===orderKey);if(!o||o.site!==s.site||o.channel!==s.channel||o.data.adMode!=='allocated'||o.gross==null||o.gross<=0)fail('分摊订单须同站点渠道、明确正收入且选择共享广告');if(otherPools.some(r=>r.data.allocations.some(x=>x.orderKey===orderKey)))fail('订单已属于另一广告费用池，不能重复分摊');data.allocations.push({orderKey,weight:o.gross,basis:JSON.stringify([o.data.revenue,o.data.revenueBasis,o.data.fx,o.data.platform])});}
 data.method='revenue';data.allocated=allocate(cents(data.amount*data.fx),data.allocations.map(x=>x.weight));
 }
 if(p.action==='market'){
 data={sku:text(p.sku,'自家SKU',120).toUpperCase(),name:text(p.name,'商品名称'),url:text(p.url,'证据链接',1500),observedAt:date(p.observedAt),material:text(p.material,'材质'),size:text(p.size,'尺寸'),tier:text(p.tier,'档次'),rankEvidence:text(p.rankEvidence,'头部/排名依据或待核实说明',1000),comparability:text(p.comparability,'同国家平台/材质尺寸档次可比依据',1000),displayPrice:number(p.displayPrice,'展示价'),promotionPrice:p.promotionPrice===''||p.promotionPrice==null?null:number(p.promotionPrice,'促销价'),shipping:p.shipping===''||p.shipping==null?null:number(p.shipping,'运费'),conditions:text(p.conditions,'优惠条件'),stock:text(p.stock,'库存状态'),...fx(p)};
 if(!/^https?:\/\//i.test(data.url))fail('证据链接须为http(s)');if(!['in_stock','out_of_stock','unknown'].includes(data.stock))fail('库存状态无效');if(data.observedAt>new Date().toISOString().slice(0,10))fail('观察日期不能晚于今天');if(!await db.prepare('SELECT sku FROM sku_settings WHERE sku=?').bind(data.sku).first())fail('未知自家SKU');
 }
 if(p.action==='simulation'){
 const ticket=latest(rs).find(r=>r.kind==='ticket'&&r.business_key===p.ticketKey&&r.site===s.site&&r.channel===s.channel),line=ticket&&ticketCosts(ticket.data,ticket.tax_treatment).find(l=>l.lineKey===p.lineKey);if(!line)fail('成本批次不存在');const unit=ticket.reviewed_at&&line.total!=null&&!line.missing.length?line.total/line.qty:null;data={ticketKey:p.ticketKey,lineKey:p.lineKey,sku:line.sku,costRecordId:ticket.id,costRevision:ticket.revision,estimated:line.estimated,missing:line.missing,result:simulate(p,unit),label:'预计定价测算；未自动调价/投放'};
 }
 const relink=['replaceOrder','voidOrder'].includes(p.action);const r=newRecord(a,relink?'order':p.action,p,data),prev=checkRevision(rs,r,relink);if(relink&&!prev)fail('纠错需要已有结算单及当前修订号');if(prev&&p.action==='simulation')fail('测算快照不可覆盖；请使用新的测算编号');if(prev&&p.action==='market'&&prev.actor_id!==a.id&&!['管理员','财务'].includes(a.role))fail('不可修订他人的市场证据',403);
 if(['order','replaceOrder'].includes(p.action)){const state=costState([...rs,r],saleRows),current=state.orders.find(o=>o.id===r.id);r.data.snapshot={gross:current.gross,costs:current.costs,contribution:current.contribution,missing:current.missing,evidence:current.evidence,createdAt:r.created_at};}
 // Sales source mutations also invalidate the optimistic write boundary.
 const sourceVersion=(await db.prepare("SELECT version FROM business_action_source_clock WHERE id='global'").first())?.version||0;
 // Re-read source rows to detect edits during normalization before taking the guard.
 if(['order','replaceOrder'].includes(p.action)){const refreshed=await sales(db,a);for(const id of Object.keys(data.salesBasis)){const current=refreshed.find(x=>x.id===id);if(!current||saleSignature(current)!==data.salesBasis[id])fail('销售依据变化，请刷新',409);}}
 await costAccess(db,a,mode);
 await write(db,a,version,[guardStatement(db,a,'cost-profit.sales-basis',"COALESCE((SELECT version FROM business_action_source_clock WHERE id='global'),0)=?",[sourceVersion]),insert(db,a,r),audit(db,a,r.id,'cost.'+p.action,{businessKey:r.business_key,revision:r.revision,reason:r.reason})]);return {ok:true,id:r.id};
}

export async function readCostProfit(db,a,query={}){
 const access=await costAccess(db,a),version=await clock(db),salesVersion=(await db.prepare("SELECT version FROM business_action_source_clock WHERE id='global'").first())?.version||0,all=await records(db,a),saleRows=await sales(db,a);
 if(query.history){const r=all.find(r=>r.id===query.history);if(!r)fail('记录不存在或无权查看',404);return {history:all.filter(x=>key(x)===key(r)).sort((a,b)=>b.revision-a.revision)};}
 const state=a.role==='运营'?costState(await records(db,{...a,role:'管理员'}),await sales(db,{role:'管理员'})):costState(all,saleRows),frozenPeriods=(await closedFinanceMonths(db)).map(r=>({month:r.month,data:JSON.parse(r.snapshot_json)}));
 const frozenMonths=frozenPeriods.map(r=>r.month),sourceForAllocation=saleRows.filter(s=>!frozenMonths.includes(s.business_date.slice(0,7)));
 state.orders=state.orders.filter(o=>!frozenMonths.includes(o.business_date.slice(0,7)));
 for(const frozen of frozenPeriods){state.orders.push(...frozen.data.orders.filter(o=>scope(a,o)).map(o=>({...o,frozenMonth:frozen.month})));sourceForAllocation.push(...frozen.data.sales.filter(s=>scope(a,s)));}
 const rs=latest(all),from=query.from?date(query.from):'',to=query.to?date(query.to):'';if(from&&to&&from>to)fail('起始日期不可晚于结束日期');
 const inScope=r=>(!query.site||r.site===query.site)&&(!query.channel||r.channel===query.channel),inDate=r=>(!from||r.business_date>=from)&&(!to||r.business_date<=to);
 const orders=state.orders.filter(r=>scope(a,r)&&inScope(r)&&inDate(r)&&(!query.sku||r.evidence.some(l=>l.sku===query.sku))&&(!query.ticket||r.evidence.some(l=>l.ticketKey===query.ticket)));
 const tickets=rs.filter(r=>r.kind==='ticket'&&inScope(r)&&(!query.ticket||r.business_key===query.ticket)&&(!query.sku||r.data.lines.some(l=>l.sku===query.sku))).map(t=>({...t,lots:state.lots.filter(l=>l.ticket.id===t.id).map(l=>omit(l,['ticket']))}));
 const allocations=orders.map(o=>({order:o,...skuContributions(o,sourceForAllocation)}));const skuRows=allocations.flatMap(({order:o,rows})=>rows.map(r=>({...r,orderKey:o.business_key,site:o.site,channel:o.channel,business_date:o.business_date}))).filter(r=>!query.sku||r.sku===query.sku);const unallocated=allocations.filter(a=>a.rows.some(r=>r.allocationPending)).map(a=>({orderKey:a.order.business_key,contribution:a.unallocated,estimated:a.order.estimated,reason:'SKU分摊依据未齐全；金额仅保留在整单，不重复分给SKU'}));
 const totals={gross:0,contribution:0,confirmedContribution:0,estimatedContribution:0,complete:0,pending:0,estimated:0,costs:Object.fromEntries(['product','sea','tax','inbound','warehouse','platform','advertising','refund'].map(k=>[k,0]))};
 const selected=query.sku?skuRows:orders;
 for(const o of selected){if(o.contribution==null){totals.pending++;continue;}totals.complete++;totals.estimated+=o.estimated?1:0;totals.gross+=o.gross;totals.contribution+=o.contribution;totals[o.estimated?'estimatedContribution':'confirmedContribution']+=o.contribution;for(const k of Object.keys(totals.costs))totals.costs[k]+=o.costs[k]||0;}
 const activeSales=saleRows.filter(s=>!s.reversed_at&&inScope(s)&&inDate(s)&&(!query.sku||s.sku===query.sku));const uncovered=activeSales.map(s=>({...s,uncoveredQty:Math.max(0,s.qty-(state.usedSales.get(s.id)||0))})).filter(s=>s.uncoveredQty>0);
 const market=rs.filter(r=>r.kind==='market'&&inScope(r)&&(!query.sku||r.data.sku===query.sku)).map(r=>({...r,evidenceState:marketState(r.data)}));
 const actions=await rows(db,'SELECT id,site,channel,sku,kind,status,owner_id,due_at,review_at FROM business_actions'+(a.role==='运营'?' WHERE site=? AND channel=?':''),a.role==='运营'?[a.site,a.channel]:[]);
 const candidates=saleRows.filter(s=>!s.reversed_at&&s.qty>0&&inScope(s)&&inDate(s)).map(s=>({...s,availableQty:Math.max(0,s.qty-(state.usedSales.get(s.id)||0))}));
 if(await clock(db)!==version||((await db.prepare("SELECT version FROM business_action_source_clock WHERE id='global'").first())?.version||0)!==salesVersion)fail('数据在读取期间变化，请刷新',409);
 return {actor:{id:a.id,role:a.role,site:a.site,channel:a.channel},...access,version,generatedAt:new Date().toISOString(),latestEvidenceAt:all.map(r=>r.created_at).sort().at(-1)||null,tickets,orders,skuRows,unallocated,frozenMonths,voidedOrders:rs.filter(r=>r.kind==='order'&&r.data.voided&&inScope(r)&&inDate(r)),totals,uncovered,market,simulations:rs.filter(r=>r.kind==='simulation'&&inScope(r)&&inDate(r)),advertising:rs.filter(r=>r.kind==='advertising'&&inScope(r)&&inDate(r)),actions:actions.filter(inScope),sales:candidates,scopeNote:'实际与暂估贡献分别展示；SKU按来源收入或明确件数分摊共享费用，分摊总额守恒。整单作为追溯证据。未关联销售、公司期间费用及净利润不包含在已核对贡献中。'};
}
