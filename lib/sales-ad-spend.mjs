import {hasPermission} from './permissions.mjs';
import {SITE_CURRENCIES,SALES_CURRENCIES,salesMoney} from './sales-data.mjs';
import {guardStatement,atomicBatch,assertWritable} from './atomic.mjs';
import {reportToday} from './sales-dashboard.mjs';
export class SalesAdSpendError extends Error {constructor(status,message){super(message);this.status=status;}}
const fail=(status,message)=>{throw new SalesAdSpendError(status,message);};
// Move a verified duplicated shop total out of SKU rows without touching quantities,
// inventory, import identity or the existing daily completeness confirmation.
export async function repairRepeatedAdSpend(db,actor,p){
 if(!hasPermission(actor.role,'sales.correct')||!hasPermission(actor.role,'sales.ad_spend'))fail(403,'无权修正此广告费用');
 await assertWritable(db);
 const source=await db.prepare('SELECT * FROM sales_imports WHERE id=? AND reversed_at IS NULL').bind(String(p.importId||'')).first();
 if(!source)fail(409,'该销售批次不存在或已修订');
 if(actor.role==='运营'&&(actor.site!==source.site||actor.channel!==source.channel))fail(403,'只能修正本人站点渠道');
 const records=(await db.prepare('SELECT id,sku,currency,ad_cost FROM sales_records WHERE import_id=? AND reversed_at IS NULL').bind(source.id).all()).results||[];
 const currency=records[0]?.currency,cost=records[0]?.ad_cost,note=String(p.note||'').trim();
 if(records.length<3||!(cost>0)||!SALES_CURRENCIES.includes(currency)||records.some(r=>r.currency!==currency||r.ad_cost!==cost)||p.expectedCost!==cost||p.expectedRows!==records.length)fail(409,'批次不再满足重复费用条件，请刷新核对');
 if(p.confirmed!==true||note.length<5||note.length>500)fail(400,'请确认重复填报并填写核对依据');
 const old=await db.prepare('SELECT * FROM sales_ad_spend WHERE site=? AND channel=? AND business_date=? AND currency=?').bind(source.site,source.channel,source.business_date,currency).first();
 if(old&&!old.deleted_at)fail(409,'该日已有渠道费用，请先核对现有记录，避免覆盖');
 let total;try{total=salesMoney(p.totalAmount);}catch{fail(400,'请填写有效的当天总费用，最多两位小数');}if(!(total>0))fail(400,'请填写核实后的当天总费用');
 const stamp=new Date().toISOString(),id=old?.id||crypto.randomUUID();
 const guard=`EXISTS(SELECT 1 FROM sales_imports WHERE id=? AND reversed_at IS NULL) AND (SELECT COUNT(*) FROM sales_records WHERE import_id=? AND reversed_at IS NULL)=? AND NOT EXISTS(SELECT 1 FROM sales_records WHERE import_id=? AND reversed_at IS NULL AND (ad_cost IS NULL OR ad_cost<>? OR currency IS NULL OR currency<>?)) AND ${old?'EXISTS(SELECT 1 FROM sales_ad_spend WHERE id=? AND version=? AND deleted_at IS NOT NULL)':'NOT EXISTS(SELECT 1 FROM sales_ad_spend WHERE site=? AND channel=? AND business_date=? AND currency=?)'}`;
 const args=[source.id,source.id,records.length,source.id,cost,currency,...(old?[old.id,old.version]:[source.site,source.channel,source.business_date,currency])];
 await atomicBatch(db,[guardStatement(db,actor,'修正重复全店广告费',guard,args),
  db.prepare('UPDATE sales_records SET ad_cost=NULL WHERE import_id=? AND reversed_at IS NULL').bind(source.id),
  db.prepare('INSERT INTO sales_ad_spend(id,business_date,site,channel,currency,amount,note,version,updated_at,actor_id) VALUES(?,?,?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET amount=excluded.amount,note=excluded.note,version=sales_ad_spend.version+1,updated_at=excluded.updated_at,actor_id=excluded.actor_id,deleted_at=NULL').bind(id,source.business_date,source.site,source.channel,currency,total,note,stamp,actor.id),
  db.prepare('INSERT INTO audit_logs(id,actor_id,actor_name,action,entity_type,entity_id,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),actor.id,actor.name,'修正重复全店广告费','sales_import',source.id,JSON.stringify({note,before:records,previousChannelTotal:old,channelTotal:{id,currency,amount:total},quantitiesUnchanged:true}),stamp),
 ]);
 return {ok:true,clearedRows:records.length,totalAmount:total,currency};
}
export async function saveSalesAdSpend(db,actor,p){
 if(!hasPermission(actor.role,'sales.ad_spend'))fail(403,'当前账号无权维护广告费用');
 await assertWritable(db);
 const site=String(p.site||''),channel=String(p.channel||''),date=String(p.businessDate||''),currency=String(p.currency||''),note=String(p.note||'').trim(),today=reportToday();
 if(!Object.hasOwn(SITE_CURRENCIES,site)||!['TikTok','Shopee'].includes(channel))fail(400,'请选择电商站点与渠道');
 if(actor.role==='运营'&&(actor.site!==site||actor.channel!==channel))fail(403,'只能维护本人站点渠道');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||date>today||Date.parse(today)-Date.parse(date)>90*86400000)fail(400,'费用日期须在最近90天内');
 if(!SALES_CURRENCIES.includes(currency)||note.length<4||note.length>500)fail(400,'请填写有效币种及至少4字的核对依据');
 const old=await db.prepare('SELECT * FROM sales_ad_spend WHERE site=? AND channel=? AND business_date=? AND currency=?').bind(site,channel,date,currency).first();
 if(!Number.isSafeInteger(p.version)||p.version!==Number(old?.version||0))fail(409,'费用记录已变化，请刷新后核对');
 const deleting=p.action==='salesAdSpendDelete';
 if(deleting&&(!old||old.deleted_at))fail(409,'该费用记录已删除或不存在');
 let amount=old?.amount;
 if(!deleting){try{amount=salesMoney(p.amount);}catch{fail(400,'费用须为非负金额，最多两位小数');}if(amount==null)fail(400,'请填写当天渠道广告总费用；明确无投放填0');}
 const stamp=new Date().toISOString(),id=old?.id||crypto.randomUUID(),next={site,channel,business_date:date,currency,amount,note,version:(old?.version||0)+1,deleted_at:deleting?stamp:null};
 const statements=[guardStatement(db,actor,p.action,old?'EXISTS (SELECT 1 FROM sales_ad_spend WHERE id=? AND version=?)':'NOT EXISTS (SELECT 1 FROM sales_ad_spend WHERE site=? AND channel=? AND business_date=? AND currency=?)',old?[id,old.version]:[site,channel,date,currency]),db.prepare('INSERT INTO sales_ad_spend(id,site,channel,business_date,currency,amount,note,version,actor_id,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(site,channel,business_date,currency) DO UPDATE SET amount=excluded.amount,note=excluded.note,version=excluded.version,actor_id=excluded.actor_id,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at').bind(id,site,channel,date,currency,amount,note,next.version,actor.id,stamp,next.deleted_at),db.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),deleting?'删除渠道广告费用':'保存渠道广告费用','sales_ad_spend',id,JSON.stringify({before:old,after:next}),actor.id,actor.name,stamp)];
 await atomicBatch(db,statements);return {ok:true,id,version:next.version};
}
