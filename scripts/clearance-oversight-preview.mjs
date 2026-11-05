// Extend only the fixed synthetic preview. This cannot choose a production DB.
import {openDatabase} from '../server/storage.mjs';
import {mutateClearance} from '../lib/clearance.mjs';
import {actionFinanceDay} from '../lib/business-action-data.mjs';
import {resolve} from 'node:path';
import {existsSync} from 'node:fs';
const path=resolve('work/clearance-zero-preview/business.sqlite');
if(!existsSync(path))throw Error('First create the isolated zero-sales fixture');
const db=openDatabase(path),sql=db.sqlite;
try{
 if(!sql.prepare("SELECT id FROM product_cost_versions WHERE id='TEST-ONLY-ZERO-COST-ID'").get())throw Error('Not the synthetic preview');
 const admin=sql.prepare("SELECT * FROM users WHERE id='admin-1'").get(),finance=sql.prepare("SELECT * FROM users WHERE id='finance-1'").get(),ops=sql.prepare("SELECT * FROM users WHERE id='id-ops'").get();
 if(!admin||!finance||!ops)throw Error('Missing synthetic roles');
 const at=date=>new Date(date+'T04:00:00Z'),row=id=>sql.prepare('SELECT * FROM clearance_lines WHERE id=?').get(id);
 const change=(actor,id,action,p={},date='2026-11-04')=>mutateClearance(db,actor,{id,version:row(id).version,action,operationId:crypto.randomUUID(),note:'TEST-ONLY 三方协作验证',...p},at(date));
 if(!sql.prepare("SELECT id FROM finance_rates WHERE month='2026-11' AND currency='IDR'").get())sql.prepare("INSERT INTO finance_rates VALUES('TEST-ONLY-CLEARANCE-RATE','2026-11','IDR',1,0.00045,'TEST-ONLY 合成汇率，不作业务依据','finance-1','2026-11-01')").run();
 const create=async(sku,end='2026-11-30',date='2026-11-04')=>(await mutateClearance(db,ops,{action:'create',operationId:crypto.randomUUID(),month:'2026-11',site:'印尼',channel:'TikTok',sku,ownerId:ops.id,start:date,end,targetQty:20,proposedPrice:99000,reason:'TEST-ONLY 合成清仓计划',strategy:'TEST-ONLY 优化素材后对照日报与库存'},at(date))).id;
 const check=(id,date='2026-11-04')=>change(finance,id,'financeCheck',{price:99000,floorPrice:80000,allowancePercent:25,supportBudget:200000,lossLimit:500000,source:'TEST-ONLY 财务模拟凭据'},date);
 let b=sql.prepare("SELECT * FROM clearance_lines WHERE sku='BAG-B'").get();
 if(!b)b=row(await create('BAG-B','2026-11-03','2026-11-01'));
 if(b.status!=='active'){
  const id=b.id;
  if(row(id).status==='draft')await change(ops,id,'submit',{},'2026-11-01');
  if(row(id).status==='finance_review')await check(id,'2026-11-01');
  if(row(id).status==='admin_review')await change(admin,id,'approve',{},'2026-11-01');
  await change(ops,id,'start',{actualPrice:99000,source:'TEST-ONLY 平台执行记录',confirmed:true},'2026-11-01');
  await change(ops,id,'log',{kind:'creative',source:'TEST-ONLY 素材示例',note:'TEST-ONLY 更换主图，继续核对销量'},'2026-11-02');
  const d=await actionFinanceDay(db,row(id),'2026-11-03');
  await change(finance,id,'financeDay',{date:'2026-11-03',basisHash:d.basisHash,revision:d.revision,costs:{landed:120000,ads:0,platform:10000,fulfillment:5000,returns:0,other:0},source:'TEST-ONLY 逐日成本凭据',confirmed:true});
  await change(finance,id,'log',{kind:'support',source:'TEST-ONLY 支持意见',note:'TEST-ONLY 维持批准预算，先补齐前两日费用'});
 }
 if(!sql.prepare("SELECT id FROM clearance_lines WHERE sku='BAG-D'").get()){const id=await create('BAG-D');await change(ops,id,'submit');}
 let a=sql.prepare("SELECT * FROM clearance_lines WHERE sku='BAG-A'").get();if(!a)a=row(await create('BAG-A'));
 if(a.status==='draft')await change(ops,a.id,'submit');if(row(a.id).status==='finance_review')await check(a.id);
 console.log('TEST-ONLY preview ready: approval, financial review, active daily tracking');
}finally{sql.close();}
