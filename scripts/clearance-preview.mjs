// Isolated synthetic acceptance data only. Never reads a production database.
import {fixture} from '../tests/fixtures.mjs';
import {mutateClearance} from '../lib/clearance.mjs';
import {actionFinanceDay} from '../lib/business-action-data.mjs';
import {releaseMigrations} from '../lib/backup-version.mjs';
import {existsSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve('work/clearance-preview'),target=root+'/business.sqlite';if(existsSync(target))throw Error('Existing preview retained; no overwrite');mkdirSync(root,{recursive:true});
const f=fixture(),now=new Date('2026-10-25T05:00:00Z'),end=new Date('2026-11-01T05:00:00Z');
f.sqlite.prepare("INSERT INTO users(id,email,name,role,created_at,updated_at) VALUES('local-admin','admin@loongjump.local','本地演示管理员','管理员','2026-01-01','2026-01-01')").run();
f.sqlite.prepare("UPDATE sku_settings SET name='演示箱包（合成数据）'").run();
const sites=[['印尼','IDR',.0005,'TikTok'],['马来西亚','MYR',1.6,'Shopee'],['菲律宾','PHP',.12,'TikTok'],['泰国','THB',.2,'Shopee'],['越南','VND',.00028,'TikTok']];
for(const [i,[site,currency,rate,channel]] of sites.entries()){
 const ownerId='clearance-ops-'+i;f.sqlite.prepare('INSERT INTO users(id,email,name,role,site,channel,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(ownerId,ownerId+'@example.test',site+'运营（演示）','运营',site,channel,'2026-01-01','2026-01-01');const operator={id:ownerId,role:'运营',site,channel};
 f.stock('BAG-A',180+i*30,150+i*40,site);
 f.sqlite.prepare("INSERT INTO product_cost_versions(id,sku,site,version,total,currency,basis,effective_date,source_json,import_id,reason,actor_id,actor_name,created_at) VALUES(?,'BAG-A',?,1,220000,'CNY','landed','2026-10-01','{}','TEST-ONLY','合成演示成本','finance-1','演示财务','2026-10-01')").run('preview-cost-'+i,site);
 f.sqlite.prepare("INSERT INTO finance_rates VALUES(?,'2026-10',?,1,?,'TEST-ONLY合成汇率非业务依据','finance-1','2026-10-01')").run('preview-rate-'+i,currency,rate);
 const price=Math.round(30/rate*100)/100;
 const id=(await mutateClearance(f.db,f.users.admin,{action:'create',operationId:crypto.randomUUID(),month:'2026-10',site,channel,sku:'BAG-A',ownerId,start:'2026-10-25',end:'2026-10-31',targetQty:120,proposedPrice:price,reason:'TEST-ONLY 演示：库存覆盖偏高，近期转化走弱。先检查素材、价格与评价。',strategy:'分配重点清仓库存，更新素材并分平台执行，7天核对销量与费用。'},now)).id;
 const call=async(actor,action,p={},when=now)=>mutateClearance(f.db,actor,{id,version:f.sqlite.prepare('SELECT version FROM clearance_lines WHERE id=?').get(id).version,action,operationId:crypto.randomUUID(),note:'演示记录：人工核实后执行，不作为真实经营依据',...p},when);
 if(i===4)continue;
 await call(operator,'submit');if(i===3)continue;
 await call(f.users.finance,'financeCheck',{price,floorPrice:Math.round(price*.8*100)/100,allowancePercent:25,supportBudget:Math.round(100/rate),lossLimit:Math.round(150/rate),source:'TEST-ONLY 演示成本单'});if(i===2)continue;
 await call(f.users.admin,'approve');await call(operator,'start',{actualPrice:price,source:'TEST-ONLY 平台执行示例',confirmed:true});
 for(let j=25;j<=31;j++){const date='2026-10-'+j,qty=10+i*3+(j-25),amount=Math.round(qty*price*100)/100,imp='preview-'+i+'-'+j;
  if(i===1&&j===28)continue;
  f.sqlite.prepare('INSERT INTO sales_imports(id,import_key,business_date,site,channel,row_count,total_qty,actor_id,created_at,report_kind) VALUES(?,?,?,?,?,1,?,?,?,?)').run(imp,imp,date,site,channel,qty,ownerId,date,'complete');
  f.sqlite.prepare("INSERT INTO sales_records(id,import_id,business_date,site,channel,sku,qty,currency,reported_amount,actor_id,created_at) VALUES(?,?,?,?,?,'BAG-A',?,?,?,?,?)").run(imp,imp,date,site,channel,qty,currency,amount,ownerId,date);
  const d=await actionFinanceDay(f.db,{site,channel,sku:'BAG-A'},date);await call(f.users.finance,'financeDay',{date,basisHash:d.basisHash,revision:d.revision,costs:{landed:Math.round(qty*22/rate*100)/100,ads:0,platform:Math.round(amount*.12*100)/100,fulfillment:Math.round(qty*2/rate*100)/100,returns:0,other:Math.round(2/rate*100)/100},source:'TEST-ONLY 演示结算单 '+date,confirmed:true},end);
 }
 await call(operator,'log',{kind:'creative',source:'TEST-ONLY 素材优化记录',note:'更新首图、使用场景与短视频，安排直播组合展示。'},new Date('2026-10-27T05:00:00Z'));
 await call(f.users.finance,'log',{kind:'support',source:'TEST-ONLY 支持记录',note:'核对活动底价，批准限额内素材制作支持，实际费用按日核实。'},new Date('2026-10-27T05:00:00Z'));
}
f.sqlite.exec('CREATE TABLE local_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TEXT NOT NULL)');for(const m of releaseMigrations)f.sqlite.prepare('INSERT INTO local_migrations VALUES(?,?,?)').run(m.name,m.sha256,new Date().toISOString());
f.sqlite.exec("VACUUM INTO '"+target.replaceAll("'","''")+"'");f.sqlite.close();console.log('Synthetic clearance preview ready');
