import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';
import {loadSalesFx} from './sales-fx.mjs';
import {targetAccess,targetMonth,targetSites,targetChannels,targetFail,buildTargetReport,round} from './sales-target-model.mjs';
const all=async(db,sql,args=[])=>(await db.prepare(sql).bind(...args).all()).results||[];
const scoped=a=>a.role==='运营'?{sql:' AND site=? AND channel=?',args:[a.site,a.channel]}:{sql:'',args:[]};
export async function readSalesTargets(db,a,month,options={}){
 targetAccess(a);targetMonth(month);
 const now=options.now||new Date(),fx=options.fx||await loadSalesFx(db),f=scoped(a);
 const scopes=targetSites.flatMap(site=>targetChannels.map(channel=>({site,channel}))).filter(r=>a.role!=='运营'||r.site===a.site&&r.channel===a.channel);
 const args=[month+'-01',month+'-31',...f.args];
 // Read all facts in one snapshot. This is never the paginated recent-import list.
 const result=await db.batch([
  db.prepare(`SELECT * FROM (WITH r AS (SELECT * FROM sales_records WHERE reversed_at IS NULL AND business_date BETWEEN ? AND ? AND channel IN ('TikTok','Shopee')${f.sql}), repeated AS (
   SELECT business_date,site,channel,COALESCE(currency,'UNKNOWN') currency,ad_cost FROM r WHERE ad_cost>0 GROUP BY business_date,site,channel,COALESCE(currency,'UNKNOWN'),ad_cost HAVING COUNT(DISTINCT sku)>=3
  ) SELECT business_date date,site,channel,COALESCE(currency,'UNKNOWN') currency,SUM(qty) qty,SUM(reported_amount) revenue,SUM(ad_cost) adCost,
   SUM(CASE WHEN reported_amount IS NULL THEN 1 ELSE 0 END) revenueMissing,SUM(CASE WHEN ad_cost IS NULL THEN 1 ELSE 0 END) costMissing,
   EXISTS(SELECT 1 FROM repeated x WHERE x.business_date=r.business_date AND x.site=r.site AND x.channel=r.channel AND x.currency=COALESCE(r.currency,'UNKNOWN')) repeated
   FROM r GROUP BY business_date,site,channel,COALESCE(currency,'UNKNOWN'))`).bind(...args),
  db.prepare(`SELECT business_date date,site,channel,currency,amount FROM sales_ad_spend WHERE deleted_at IS NULL AND business_date BETWEEN ? AND ? AND channel IN ('TikTok','Shopee')${f.sql}`).bind(...args),
  db.prepare(`SELECT DISTINCT business_date date,site,channel FROM sales_imports WHERE reversed_at IS NULL AND report_kind IN ('complete','zero') AND business_date BETWEEN ? AND ? AND channel IN ('TikTok','Shopee')${f.sql}`).bind(...args),
  db.prepare(`SELECT site,channel,SUM(MAX(0,qty)+MAX(0,pending_shelf_qty)+MAX(0,quarantine_qty)) held,SUM(MAX(0,qty-MAX(0,reserved_qty))) available,SUM(MAX(0,reserved_qty)) reserved,SUM(MAX(0,pending_shelf_qty)) pending,SUM(MAX(0,quarantine_qty)) quarantine,SUM(CASE WHEN qty<0 OR reserved_qty<0 OR reserved_qty>qty OR pending_shelf_qty<0 OR quarantine_qty<0 THEN 1 ELSE 0 END) anomalies FROM inventory_balances WHERE channel IN ('TikTok','Shopee')${f.sql} GROUP BY site,channel`).bind(...f.args),
  db.prepare(`SELECT * FROM sales_monthly_targets WHERE month=?${f.sql}`).bind(month,...f.args),
  db.prepare(`SELECT id,name,role,site,channel,active FROM users WHERE role='运营'${f.sql} ORDER BY name,id`).bind(...f.args),
 ]);
 const [raw,spend,coverage,inventory,targets,users]=result.map(r=>r.results||[]);
 return {...buildTargetReport({month,scopes,raw,spend,coverage,inventory,targets,users,fx,now}),actor:{id:a.id,role:a.role,site:a.site,channel:a.channel},users:a.role==='管理员'?users.filter(u=>u.active):[],canManage:a.role==='管理员'};
}
const text=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
function amount(value,label){if(!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(String(value??''))||Number(value)>1e10)targetFail(`${label}须为非负人民币金额，最多两位小数，不超过100亿元`);return round(Number(value));}
export async function saveSalesTarget(db,a,p,now=new Date()){
 if(a.role!=='管理员')targetFail('仅管理员分配或调整月度任务',403);
 await assertWritable(db);const month=targetMonth(p.month),site=text(p.site,30),channel=text(p.channel,20);
 if(!targetSites.includes(site)||!targetChannels.includes(channel))targetFail('请选择五站 TikTok 或 Shopee');
 if(!Number.isSafeInteger(p.version)||p.version<0)targetFail('任务版本无效，请刷新',409);
 const old=await db.prepare('SELECT * FROM sales_monthly_targets WHERE month=? AND site=? AND channel=?').bind(month,site,channel).first();
 if(p.version!==(old?.version||0))targetFail('任务已被其他管理员调整，请刷新后核对',409);
 const owner=await db.prepare("SELECT id,name FROM users WHERE id=? AND active=1 AND role='运营' AND site=? AND channel=?").bind(text(p.ownerId,100),site,channel).first();
 if(!owner)targetFail('请选择该站点／平台的有效运营负责人');
 const revenue=amount(p.revenueCny,'销售额目标'),budget=amount(p.budgetCny,'广告预算'),quantity=Number(p.quantity);
 if(!/^\d+$/.test(String(p.quantity??''))||!Number.isSafeInteger(quantity)||quantity<0||quantity>1e9)targetFail('销量目标须为0至10亿的整数');
 const note=text(p.note,2000),reason=text(p.reason,1000);if(reason.length<4)targetFail('请填写至少4字的分配或调整依据');
 const id=old?.id||crypto.randomUUID(),at=now.toISOString();
 const after={id,month,site,channel,owner_id:owner.id,owner_name:owner.name,revenue_cny:revenue,quantity,budget_cny:budget,note,version:p.version+1};
 await atomicBatch(db,[
  guardStatement(db,a,'sales-target.save',old?'EXISTS(SELECT 1 FROM sales_monthly_targets WHERE id=? AND version=?)':'NOT EXISTS(SELECT 1 FROM sales_monthly_targets WHERE month=? AND site=? AND channel=?)',old?[id,p.version]:[month,site,channel]),
  guardStatement(db,a,'sales-target.owner',"EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role='运营' AND site=? AND channel=?)",[owner.id,site,channel]),
  old?db.prepare('UPDATE sales_monthly_targets SET owner_id=?,owner_name=?,revenue_cny=?,quantity=?,budget_cny=?,note=?,updated_by=?,updated_at=?,version=version+1 WHERE id=? AND version=?').bind(owner.id,owner.name,revenue,quantity,budget,note,a.id,at,id,p.version):db.prepare('INSERT INTO sales_monthly_targets(id,month,site,channel,owner_id,owner_name,revenue_cny,quantity,budget_cny,note,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,month,site,channel,owner.id,owner.name,revenue,quantity,budget,note,a.id,at,a.id,at),
  db.prepare('INSERT INTO sales_target_events(id,target_id,actor_id,actor_name,before_json,after_json,reason,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),id,a.id,a.name,old?JSON.stringify(old):null,JSON.stringify(after),reason,at),
  db.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),old?'调整月度销售任务':'分配月度销售任务','sales_monthly_target',id,JSON.stringify({before:old,after,reason}),a.id,a.name,at),
 ]);
 return {ok:true,id,version:p.version+1};
}
export async function salesTargetHistory(db,a,id){
 targetAccess(a);const r=await db.prepare('SELECT * FROM sales_monthly_targets WHERE id=?').bind(text(id,100)).first();
 if(!r||a.role==='运营'&&(r.site!==a.site||r.channel!==a.channel))targetFail('任务不存在或无权查看',404);
 return (await all(db,'SELECT actor_name,before_json,after_json,reason,created_at FROM sales_target_events WHERE target_id=? ORDER BY created_at DESC,rowid DESC',[r.id])).map(r=>({actor:r.actor_name,before:r.before_json?JSON.parse(r.before_json):null,after:JSON.parse(r.after_json),reason:r.reason,at:r.created_at}));
}
