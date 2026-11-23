import {fixture} from './fixtures.mjs';
import {configure} from '../lib/workplace-common.mjs';
import {mutateExpense,expenseRequest} from '../lib/finance-workbench.mjs';
import {uploadWorkplaceProof} from '../lib/workplace-files.mjs';
export async function workplaceFixture(){
 const f=fixture(),s=f.sqlite;
 const add=(id,role,site=null)=>{const a={id,name:'TEST-ONLY '+id,role,site};s.prepare('INSERT INTO users(id,email,name,role,site,active,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)').run(id,id+'@example.test',a.name,role,site,'2026-01-01','2026-01-01');f.users[id]=a;return a;};
 add('manager','运营主管','印尼');add('hr','员工');add('finance2','财务');add('boss','运营主管');add('studio','拍摄剪辑','印尼');
 const config=(p)=>configure(f.db,f.users.admin,p);for(const [id,site,tz] of [['ID','印尼','Asia/Jakarta'],['MY','马来西亚','Asia/Kuala_Lumpur']])await config({action:'unit',id,name:'TEST '+id,legalEntity:'TEST ENTITY '+id,site,timezone:tz,department:'TEST ops',workplace:'TEST office'});
 await config({action:'shift',id:'day',unitId:'ID',name:'TEST day',startMinute:540,endMinute:1080,weekdays:[1,2,3,4,5],graceIn:5,graceOut:0});await config({action:'shift',id:'night',unitId:'ID',name:'TEST night',startMinute:1320,endMinute:360,weekdays:[1,2,3,4,5],graceIn:0,graceOut:0});
 for(const a of [f.users.indonesia,f.users.studio])await config({action:'profile',userId:a.id,unitId:'ID',jobTitle:'TEST job',managerId:'manager',shiftId:'day'});
 await config({action:'profile',userId:'my-ops',unitId:'MY',jobTitle:'TEST MY',managerId:'manager'});
 for(const [id,cap] of [['hr','hr'],['finance-1','finance'],['finance2','finance'],['boss','executive']])await config({action:'grant',userId:id,unitId:'ID',capability:cap,enabled:true,reason:'TEST ONLY'});
 s.prepare("INSERT INTO finance_documents VALUES('TEST-BILL-ID','supplier_bill','TEST-BILL',1,'2026-09-01','TEST supplier','印尼','TikTok','CNY',100000,'active',?,'TEST invoice','TEST seeded approved existing bill','finance-1','2026-09-01')").run(JSON.stringify({reference:'TEST-INVOICE',matchStatus:'matched'}));await config({action:'billScope',businessKey:'TEST-BILL',unitId:'ID',entityConfirmed:true,reason:'TEST ENTITY verification'});
 const contents=new Map();f.bucket={put:async(k,b)=>contents.set(k,b),get:async k=>contents.has(k)?{body:new Blob([contents.get(k)]).stream()}:null,delete:async k=>contents.delete(k)};f.contents=contents;f.config=config;
 f.expense=async(extra={},actor=f.users.indonesia)=>(await mutateExpense(f.db,actor,{action:'expenseCreate',operationId:crypto.randomUUID(),businessDate:'2026-09-10',settlementDate:'2026-09-10',category:'office',currency:'CNY',amount:100,channel:'TikTok',shop:'TEST store',sourceReference:'TEST source',purpose:'TEST ONLY supplies',...extra})).id;
 f.change=async(actor,id,action,extra={})=>mutateExpense(f.db,actor,{id,action,version:(await expenseRequest(f.db,id)).version,reason:'TEST checked',...extra});
 f.approve=async(id)=>{await f.change(f.users.manager,id,'managerApprove');await f.change(f.users.finance,id,'financeApprove',{sourceKey:'TEST-BILL',entityConfirmed:true});};
 f.proof=async(id,content=crypto.randomUUID(),actor=f.users.finance)=>(await uploadWorkplaceProof(f.db,f.bucket,actor,id,new File(['%PDF-1.7\nTEST ONLY '+content],'TEST-proof.pdf',{type:'application/pdf'}))).id;
 f.pay=async(id,amount=40,extra={})=>f.change(f.users.finance,id,'payment',{amount,bankDate:'2026-09-11',bankAccount:'TEST BANK',bankReference:crypto.randomUUID(),proofId:await f.proof(id),...extra});
 f.close=()=>s.prepare("INSERT INTO finance_period_events VALUES('TEST-CLOSE','2026-09',1,'closed','{}','TEST ONLY','admin-1','2026-10-01')").run();
 return f;
}
