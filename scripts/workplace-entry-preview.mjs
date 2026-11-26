// Disposable synthetic data only. Does not import production storage or credentials.
import {workplaceFixture} from '../tests/workplace-fixture.mjs';
import {mutateLeave} from '../lib/attendance.mjs';
import {mutateExpense} from '../lib/finance-workbench.mjs';
import {releaseMigrations} from '../lib/backup-version.mjs';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root=resolve('work/workplace-entry-preview'),target=root+'/business.sqlite';
if(existsSync(target))throw Error('Existing TEST preview retained; use it without overwriting');
mkdirSync(root,{recursive:true,mode:0o700});
const f=await workplaceFixture(),stamp=new Date().toISOString();
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta'}).format(new Date());
const plus=(date,n)=>new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const nextWorkingDay=date=>{while([0,6].includes(new Date(date+'T00:00:00Z').getUTCDay()))date=plus(date,1);return date;};
try{
 // Keep one fully unconfigured operator to verify that entrances remain visible.
 f.sqlite.prepare("DELETE FROM workplace_profiles WHERE user_id='my-ops'").run();
 for(const u of f.sqlite.prepare('SELECT id,role FROM users').all()){
  const name=`TEST-ONLY ${u.id} · ${u.role}`;
  f.sqlite.prepare('UPDATE users SET name=?,email=? WHERE id=?').run(name,u.id+'@example.test',u.id);
  const actor=Object.values(f.users).find(a=>a.id===u.id);if(actor)actor.name=name;
 }
 const leaveDate=nextWorkingDay(today),reviewDate=nextWorkingDay(plus(leaveDate,1));
 await mutateLeave(f.db,f.users.indonesia,{action:'leaveCreate',operationId:crypto.randomUUID(),date:leaveDate,portion:'full',reason:'TEST-ONLY 请假交接：合成演示记录'});
 const reviewing=await mutateLeave(f.db,f.users.indonesia,{action:'leaveCreate',operationId:crypto.randomUUID(),date:reviewDate,portion:'first',reason:'TEST-ONLY 半班请假：等待独立人事复核'});
 await mutateLeave(f.db,f.users.manager,{action:'managerApprove',id:reviewing.id,version:1,reason:'TEST-ONLY 主管演示审批'});
 for(const [stage,amount] of [['submitted',100],['manager_approved',200],['approved',300]]){
  const {id}=await mutateExpense(f.db,f.users.indonesia,{action:'advertisingCreate',operationId:crypto.randomUUID(),startDate:today,endDate:plus(today,7),currency:'CNY',amount,shop:'TEST-ONLY 印尼 TikTok 店铺',adAccount:'TEST-ONLY-AD-ACCOUNT',purpose:'TEST-ONLY 入口验收预算 · '+stage});
  if(stage!=='submitted')await f.change(f.users.manager,id,'managerApprove');
  if(stage==='approved')await f.change(f.users.finance,id,'advertisingApprove',{approvedAmount:280});
 }
 await f.expense({businessDate:today,settlementDate:today,purpose:'TEST-ONLY 办公费用：与广告申请分开展示'});
 // Explicit reported zero and an absent day let the trend page distinguish zero from missing.
 const spend=f.sqlite.prepare('INSERT INTO sales_ad_spend(id,business_date,site,channel,currency,amount,note,version,updated_at,actor_id) VALUES(?,?,?,?,?,?,?,1,?,?)');
 for(const [offset,amount] of [[6,12000],[5,15000],[3,0],[2,18000],[1,21000],[0,1000]])spend.run(crypto.randomUUID(),plus(today,-offset),'印尼','TikTok','IDR',amount,'TEST-ONLY 合成广告费用',stamp,f.users.indonesia.id);
 spend.run(crypto.randomUUID(),plus(today,-1),'马来西亚','TikTok','MYR',12,'TEST-ONLY 另一站点范围隔离',stamp,f.users.malaysia.id);
 f.sqlite.exec('CREATE TABLE workplace_preview_marker(id TEXT PRIMARY KEY,created_at TEXT NOT NULL)');
 f.sqlite.prepare('INSERT INTO workplace_preview_marker VALUES(?,?)').run('TEST-ONLY-WORKPLACE-ENTRY-v1',stamp);
 f.sqlite.exec('CREATE TABLE local_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TEXT NOT NULL)');
 for(const m of releaseMigrations)f.sqlite.prepare('INSERT INTO local_migrations VALUES(?,?,?)').run(m.name,m.sha256,stamp);
 f.sqlite.exec("VACUUM INTO '"+target.replaceAll("'","''")+"'");
 const roles={studio:'studio',operator:'id-ops',unconfigured:'my-ops',manager:'manager',finance:'finance-1',hr:'hr',admin:'admin-1'};
 writeFileSync(root+'/preview.json',JSON.stringify({testOnly:true,createdAt:stamp,today,leaveDate,reviewDate,origin:'http://127.0.0.1:57339',roles},null,2),{mode:0o600});
 console.log('TEST-ONLY workplace preview fixture ready: '+root);
 console.log('Current-month advertising requests and expenses, leave approvals, and scoped trend facts are synthetic.');
}finally{f.sqlite.close();}
