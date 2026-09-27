import {hasPermission} from './permissions.mjs';
import {SITE_CURRENCIES,SALES_CURRENCIES,salesMoney} from './sales-data.mjs';
import {guardStatement,atomicBatch,assertWritable} from './atomic.mjs';
import {reportToday} from './sales-dashboard.mjs';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
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
