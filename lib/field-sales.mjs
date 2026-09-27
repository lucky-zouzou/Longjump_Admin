import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';
export class FieldError extends Error{constructor(message,status=400){super(message);this.status=status;}}
export const fieldToday=()=>new Date(Date.now()+7*3600000).toISOString().slice(0,10);
const text=(v,max=2000)=>String(v??'').trim().slice(0,max);
const fail=(s,status=400)=>{throw new FieldError(s,status)};
export function fieldAccess(actor){if(!actor||!['管理员','财务','销售'].includes(actor.role)||(actor.role==='销售'&&actor.site!=='印尼'))fail('无权访问线下销售工作台',403);}
export const fieldOwn=(actor,r)=>actor.role!=='销售'||r.sales_user_id===actor.id;
const date=(v)=>{const s=text(v,40);if(!/^20\d\d-\d\d-\d\d$/.test(s)||Number.isNaN(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s)fail('日期无效');return s;};
const rows=async(db,sql,args=[]) =>(await db.prepare(sql).bind(...args).all()).results;
const parsed=r=>({...r,data:JSON.parse(r.data_json)});
const snapshot=c=>({id:c.id,code:c.code,name:c.name,contact:c.contact,phone:c.phone,city:c.city,address:c.address});
export async function fieldRecord(db,actor,id){fieldAccess(actor);const r=await db.prepare('SELECT * FROM field_records WHERE id=?').bind(text(id,100)).first();if(!r||!fieldOwn(actor,r))fail('记录不存在或无权访问',404);return parsed(r);}
function audit(db,actor,id,action,before,after,reason=''){return db.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),'field.'+action,'field_record',id,JSON.stringify({before,after,reason}),actor.id,actor.name,new Date().toISOString());}
async function commit(db,actor,p,id,guard,args,statements){
 const key=text(p.operationId,100);if(!key)fail('操作编号缺失，请刷新重试');
 const request=JSON.stringify(p),old=await db.prepare('SELECT actor_id,request_json FROM system_operations WHERE id=?').bind(key).first();
 if(old){if(old.actor_id!==actor.id||old.request_json!==request)fail('操作编号冲突',409);return {ok:true,id,replayed:true};}
 await atomicBatch(db,[guardStatement(db,actor,'field.'+p.action,guard,args,key,p),...statements]);return {ok:true,id};
}
export function attendance(month,users,records,now=fieldToday()){
 const end=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).getUTCDate();
 return users.map(user=>{const own=records.filter(r=>r.sales_user_id===user.id),days=[];
 for(let n=1;n<=end;n++){const day=`${month}-${String(n).padStart(2,'0')}`,week=new Date(day).getUTCDay(),valid=own.filter(r=>r.kind==='visit'&&r.business_date===day&&r.status==='valid'),count=new Set(valid.map(r=>r.data.identity||r.customer_id)).size,leave=own.find(r=>r.kind==='leave'&&r.status==='approved'&&r.business_date<=day&&r.end_date>=day),pending=own.filter(r=>r.kind==='visit'&&r.business_date===day&&r.status==='review').length;
 const status=day>now?'future':day<user.created_at.slice(0,10)?'not_started':week===0||week===6?'weekend':leave?'leave':count>=3?'met':day===now?'in_progress':count?'short':'verify';
 days.push({date:day,status,count,pending,leave:leave?.data.leaveType||'',conflict:!!leave&&count>0});}
 return {id:user.id,name:user.name,days,summary:Object.fromEntries(['met','short','verify','leave','weekend','in_progress'].map(s=>[s,days.filter(d=>d.status===s).length]))};});
}
export async function mutateField(db,actor,p){
 fieldAccess(actor);if(actor.role==='财务')fail('财务仅可查看和导出',403);await assertWritable(db);
 if(!p||typeof p!=='object')fail('请求无效');
 // Retry must be checked before state transitions; a successful submit is no longer a draft.
 const op=text(p.operationId,100),prior=op&&await db.prepare('SELECT actor_id,request_json FROM system_operations WHERE id=?').bind(op).first();
 if(prior){if(prior.actor_id!==actor.id||prior.request_json!==JSON.stringify(p))fail('操作编号冲突',409);return {ok:true,id:p.id||`field_${op}`,replayed:true};}
 const now=new Date().toISOString(),today=fieldToday();
 if(p.action==='create'){
  const kind=p.kind;if(!['visit','leave','contract'].includes(kind))fail('记录类型无效');
  const owner=actor.role==='管理员'?text(p.salesUserId,100):actor.id,user=await db.prepare("SELECT id FROM users WHERE id=? AND role='销售' AND site='印尼' AND active=1").bind(owner).first();if(!user)fail('请选择有效的印尼销售账号');
  const day=date(p.businessDate),end=kind==='leave'?date(p.endDate):day;if(end<day||Number(new Date(end))-Number(new Date(day))>366*86400000)fail('结束日期须在开始日期之后，单次不超过一年');if(kind!=='leave'&&day>today)fail('不能录入未来的拜访或合同');
  let customer=null,data={};
  if(kind==='leave'){if(!['sick','personal','annual'].includes(p.leaveType)||text(p.note).length<2)fail('请选择假别并填写原因');data={leaveType:p.leaveType,note:text(p.note)};}
  else{customer=await db.prepare('SELECT * FROM wholesale_customers WHERE id=? AND active=1 AND sales_user_id=?').bind(text(p.customerId,100),owner).first();if(!customer)fail('请选择该销售负责的客户；新客户请先建立客户档案');
   if(!customer.address||!customer.contact||!customer.phone)fail('请先完善客户地址、联系人和电话');
   data={customer:snapshot(customer)};
   if(kind==='visit'){
    if(!['cold','followup'].includes(p.visitType)||text(p.note).length<10)fail('请选择拜访类型，拜访描述至少10个字符');
    data={...data,visitType:p.visitType,note:text(p.note),nextFollowup:p.nextFollowup?date(p.nextFollowup):'',identity:customer.id};if(data.nextFollowup&&data.nextFollowup<day)fail('跟进日期不能早于拜访日期');
   }else{if(text(p.contractNo,100).length<2)fail('请填写签约合同编号');data={...data,contractNo:text(p.contractNo,100),note:text(p.note),photoIds:[]};}
  }
  const id=`field_${op}`,guard=customer?'EXISTS(SELECT 1 FROM wholesale_customers WHERE id=? AND version=? AND sales_user_id=? AND active=1)':'1',args=customer?[customer.id,customer.version,owner]:[];
  return commit(db,actor,p,id,guard,args,[db.prepare('INSERT INTO field_records(id,kind,sales_user_id,customer_id,business_date,end_date,status,version,data_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?,?)').bind(id,kind,owner,customer?.id||null,day,end,'draft',JSON.stringify(data),now,now),audit(db,actor,id,'create',null,{kind,owner,day,data})]);
 }
 const r=await fieldRecord(db,actor,p.id);if(Number(p.version)!==r.version)fail('记录已变化，请刷新后重试',409);
 let status=r.status,data={...r.data},extraGuard='1',extraArgs=[],reason=text(p.reason);
 if(p.action==='submit'){
  if(r.status!=='draft')fail('只能提交草稿');
  const files=await rows(db,'SELECT id,sha256,content_type,created_at FROM field_files WHERE record_id=?',[r.id]);
  if(r.kind==='visit'){
   if(!files.some(f=>f.content_type.startsWith('image/')))fail('请先上传现场照片');
   const repeated=await rows(db,"SELECT DISTINCT f.id FROM field_files f JOIN field_files own ON own.sha256=f.sha256 JOIN field_records other ON other.id=f.record_id WHERE own.record_id=? AND f.record_id<>? AND other.kind='visit'",[r.id,r.id]);
   const reasons=[];if(r.business_date!==today||files.some(f=>new Date(new Date(f.created_at).getTime()+7*3600000).toISOString().slice(0,10)!==r.business_date))reasons.push('backdated');if(repeated.length)reasons.push('reused_photo');
   const previous=await rows(db,"SELECT id FROM field_records WHERE kind='visit' AND customer_id=? AND status<>'draft' AND status<>'withdrawn' AND business_date<=?",[r.customer_id,r.business_date]);
   extraGuard="(SELECT COUNT(*) FROM field_records WHERE kind='visit' AND customer_id=? AND status NOT IN ('draft','withdrawn') AND business_date<=?)=?";extraArgs=[r.customer_id,r.business_date,previous.length];
   data={...data,visitNumber:previous.length+1,checks:reasons,rule:'documents_v1'};status=reasons.length?'review':'valid';
  }else if(r.kind==='contract'){
   if(!files.length)fail('请上传已签署合同的PDF或照片');
   const photos=await rows(db,"SELECT f.id FROM field_files f JOIN field_records r ON r.id=f.record_id WHERE r.customer_id=? AND r.sales_user_id=? AND r.kind='visit' AND r.status='valid' AND f.content_type LIKE 'image/%' ORDER BY f.created_at DESC LIMIT 6",[r.customer_id,r.sales_user_id]);data.photoIds=photos.map(f=>f.id);status='pending';
   extraGuard="NOT EXISTS(SELECT 1 FROM field_records WHERE kind='contract' AND id<>? AND status IN ('pending','active') AND lower(json_extract(data_json,'$.contractNo'))=lower(?))";extraArgs=[r.id,data.contractNo];
  }else{status='pending';extraGuard="NOT EXISTS(SELECT 1 FROM field_records WHERE kind='leave' AND sales_user_id=? AND id<>? AND status IN ('pending','approved') AND business_date<=? AND end_date>=?)";extraArgs=[r.sales_user_id,r.id,r.end_date,r.business_date];}
 }else if(p.action==='review'){
  if(actor.role!=='管理员')fail('仅管理员可复核或审批',403);if(reason.length<2)fail('请填写审批或复核原因');
  const allowed=r.kind==='visit'?['valid','review','rejected']:r.kind==='leave'?['pending']:['pending'];if(!allowed.includes(r.status))fail('该状态不能审批');
  if(!['approve','reject'].includes(p.decision))fail('审批结果无效');status=p.decision==='reject'?'rejected':r.kind==='visit'?'valid':r.kind==='leave'?'approved':'active';data.review={by:actor.name,at:now,reason};
 }else if(p.action==='withdraw'){
  if(!['draft','pending','review'].includes(r.status))fail('该记录已确认，不能撤回');if(reason.length<2)fail('请填写撤回原因');status='withdrawn';
 }else if(p.action==='void'){
  if(actor.role!=='管理员'||!['active','approved'].includes(r.status))fail('仅管理员可作废已确认合同或请假',403);if(reason.length<2)fail('请填写作废原因');status='void';
 }else fail('操作无效');
 return commit(db,actor,p,r.id,`EXISTS(SELECT 1 FROM field_records WHERE id=? AND version=?) AND (${extraGuard})`,[r.id,r.version,...extraArgs],[db.prepare('UPDATE field_records SET status=?,data_json=?,version=version+1,updated_at=?,submitted_at=COALESCE(submitted_at,?) WHERE id=?').bind(status,JSON.stringify(data),now,p.action==='submit'?now:null,r.id),audit(db,actor,r.id,p.action,{status:r.status,data:r.data},{status,data},reason)]);
}
export async function readField(db,actor,month){
 fieldAccess(actor);if(!/^20\d\d-(0[1-9]|1[0-2])$/.test(month))fail('月份无效');
 const own=actor.role==='销售',users=await rows(db,"SELECT id,name,created_at,active FROM users WHERE role='销售' AND site='印尼'"+(own?' AND id=?':''),own?[actor.id]:[]);
 const all=(await rows(db,'SELECT * FROM field_records'+(own?' WHERE sales_user_id=?':''),own?[actor.id]:[])).map(parsed);
 const records=all.filter(r=>r.kind==='contract'||(r.business_date<=month+'-31'&&r.end_date>=month+'-01')||(r.kind==='visit'&&r.status==='valid'&&r.data.nextFollowup&&r.data.nextFollowup<=fieldToday()));
 const files=await rows(db,'SELECT f.id,f.record_id,f.name,f.content_type,f.size,f.created_at FROM field_files f JOIN field_records r ON r.id=f.record_id'+(own?' WHERE r.sales_user_id=?':''),own?[actor.id]:[]);
 const history=await rows(db,"SELECT a.entity_id,a.action,a.detail_json,a.actor_name,a.created_at FROM audit_logs a JOIN field_records r ON r.id=a.entity_id WHERE a.entity_type='field_record'"+(own?' AND r.sales_user_id=?':'')+' ORDER BY a.created_at DESC',own?[actor.id]:[]);
 const customers=await rows(db,'SELECT id,code,name,contact,phone,city,address,sales_user_id FROM wholesale_customers WHERE active=1'+(own?' AND sales_user_id=?':''),own?[actor.id]:[]);
 const shipments=await rows(db,`SELECT o.sales_user_id,i.sku,i.name,s.business_date,si.qty,si.amount FROM wholesale_shipment_items si JOIN wholesale_shipments s ON s.id=si.shipment_id JOIN wholesale_orders o ON o.id=s.order_id JOIN wholesale_order_items i ON i.id=si.order_item_id WHERE substr(s.business_date,1,7)=? ${own?'AND o.sales_user_id=?':''}`,[month,...own?[actor.id]:[]]);
 const returns=await rows(db,`SELECT o.sales_user_id,i.sku,r.qty,r.amount FROM wholesale_returns r JOIN wholesale_orders o ON o.id=r.order_id JOIN wholesale_order_items i ON i.id=r.order_item_id WHERE substr(r.business_date,1,7)=? ${own?'AND o.sales_user_id=?':''}`,[month,...own?[actor.id]:[]]);
 const finance=await rows(db,`SELECT o.sales_user_id,f.kind,f.amount FROM wholesale_finance_entries f JOIN wholesale_orders o ON o.id=f.order_id WHERE substr(f.business_date,1,7)=? ${own?'AND o.sales_user_id=?':''}`,[month,...own?[actor.id]:[]]);
 const contractFirst=await rows(db,"SELECT id,customer_id,sales_user_id,business_date,created_at FROM field_records WHERE kind='contract' AND status='active' ORDER BY business_date,created_at");
 const contributions=users.map(u=>{const visit=all.filter(r=>r.sales_user_id===u.id&&r.kind==='visit'&&r.status==='valid'&&r.business_date.startsWith(month)),first=new Map();for(const r of contractFirst)if(!first.has(r.customer_id))first.set(r.customer_id,r);
 const sh=shipments.filter(r=>r.sales_user_id===u.id),rt=returns.filter(r=>r.sales_user_id===u.id),fn=finance.filter(r=>r.sales_user_id===u.id),skus=new Map();for(const r of sh){const s=skus.get(r.sku)||{sku:r.sku,name:r.name,qty:0,amount:0,returned:0};s.qty+=r.qty;s.amount+=r.amount;skus.set(r.sku,s);}for(const r of rt){const s=skus.get(r.sku)||{sku:r.sku,name:r.sku,qty:0,amount:0,returned:0};s.returned+=r.qty;skus.set(r.sku,s);}const sum=(rs,k)=>rs.reduce((s,r)=>s+r[k],0);
 return {id:u.id,name:u.name,visits:new Set(visit.map(r=>r.business_date+'|'+(r.data.identity||r.customer_id))).size,clients:new Set(visit.map(r=>r.data.identity||r.customer_id)).size,signed:[...first.values()].filter(r=>r.sales_user_id===u.id&&r.business_date.startsWith(month)).length,quantity:sum(sh,'qty'),amount:sum(sh,'amount'),returnQty:sum(rt,'qty'),returnAmount:sum(rt,'amount'),receipts:fn.reduce((s,r)=>s+(r.kind==='receipt'?r.amount:['receipt_void','receipt_unallocate'].includes(r.kind)?-r.amount:0),0),refunds:fn.reduce((s,r)=>s+(r.kind==='refund'?r.amount:r.kind==='refund_void'?-r.amount:0),0),skus:[...skus.values()].sort((a,b)=>(b.qty-b.returned)-(a.qty-a.returned)||a.sku.localeCompare(b.sku))};});
 // Explicit allowlist: no costs, supplier details, financial research or unrestricted system payload.
 const inventory=await rows(db,'SELECT sku,MAX(name) name,SUM(qty) qty,SUM(reserved_qty) reserved,SUM(pending_shelf_qty) pending,SUM(quarantine_qty) quarantine,SUM(MAX(0,qty-reserved_qty)) available,SUM(CASE WHEN site=\'印尼\' AND channel IN (\'TikTok\',\'Shopee\') THEN MAX(0,qty-reserved_qty) ELSE 0 END) indonesia,MAX(updated_at) updated_at FROM inventory_balances GROUP BY sku ORDER BY sku');
 const products=await rows(db,"SELECT id,sku,name,stage,status,current_due_at,updated_at FROM new_product_projects WHERE status<>'abandoned' ORDER BY updated_at DESC");
 const followups=all.filter(r=>r.kind==='visit'&&r.status==='valid'&&r.data.nextFollowup&&r.data.nextFollowup<=fieldToday()&&!all.some(n=>n.customer_id===r.customer_id&&n.kind==='visit'&&n.status==='valid'&&(n.business_date>r.business_date||(n.business_date===r.business_date&&n.created_at>r.created_at))));
 return {followups,actor:{id:actor.id,role:actor.role,name:actor.name},today:fieldToday(),month,users,customers,records,files,history,attendance:attendance(month,users,all),contributions,inventory,products};
}
