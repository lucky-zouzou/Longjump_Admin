import {storeInsert} from './distributor-accounts.mjs';
import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';
import {InquiryError,inquiryHash} from './website-inquiry-auth.mjs';

const fail=(status,message)=>{throw new InquiryError(status,message);};
const text=(value,max=2000)=>{if(value==null)return '';if(typeof value!=='string'||value.length>max)fail(400,'字段格式或长度无效');return value.trim();};
const id=prefix=>prefix+'_'+crypto.randomUUID();
const stamp=()=>new Date().toISOString();
const q=(db,sql,args=[])=>db.prepare(sql).bind(...args);
const one=(db,sql,args=[])=>q(db,sql,args).first();
const all=async(db,sql,args=[])=>((await q(db,sql,args).all()).results||[]);
const parse=raw=>JSON.parse(raw);
const country=value=>({ID:'印尼',Indonesia:'印尼',印尼:'印尼',印度尼西亚:'印尼',MY:'马来西亚',Malaysia:'马来西亚',TH:'泰国',Thailand:'泰国',VN:'越南',Vietnam:'越南',PH:'菲律宾',Philippines:'菲律宾'}[value]||value);
export const distributorApplicationSource='distributor-application';
export const canManageLeads=actor=>actor?.role==='管理员'||actor?.role==='销售'&&(!actor.site||actor.site==='印尼')||actor?.role==='运营'&&actor?.site==='印尼';
const eligible=user=>user&&Number(user.active)===1&&(user.role==='管理员'||user.role==='销售'&&(!user.site||user.site==='印尼')||user.role==='运营'&&user.site==='印尼');
const ownerGuard="EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND (role='管理员' OR role='销售' AND (site IS NULL OR site='' OR site='印尼') OR role='运营' AND site='印尼'))";
const profile=(p={})=>{if(!p||typeof p!=='object'||Array.isArray(p))fail(400,'客户资料格式无效');return {name:text(p.name,120),contact:text(p.contact,100),phone:text(p.phone,60),email:text(p.email,160),city:text(p.city,100),address:text(p.address,600)};};
const event=(db,actor,leadId,action,detail)=>q(db,'INSERT INTO website_lead_events(id,lead_id,action,actor_id,actor_name,detail_json,created_at) VALUES(?,?,?,?,?,?,?)',[id('levent'),leadId,action,actor?.id||null,actor?.name||'网站同步',JSON.stringify(detail),stamp()]);
const visible=(actor,alias='l')=>actor.role==='管理员'?{sql:'1=1',args:[]}:{sql:`${alias}.owner_id=?`,args:[actor.id]};

function envelope(input,source){
 if(input.schemaVersion!==1||input.source!==source||!source)fail(400,'询盘来源或协议版本无效');
 const externalId=text(input.externalId,80);if(!/^[A-Za-z0-9_-]+$/.test(externalId))fail(400,'原询盘编号无效');
 const revision=input.revision;if(!Number.isSafeInteger(revision)||revision<1)fail(400,'询盘版本无效');
 const d=input.details;if(!d||typeof d!=='object'||Array.isArray(d))fail(400,'缺少询盘资料');
 const owner=input.assignee||{};if(typeof owner!=='object'||Array.isArray(owner))fail(400,'网站销售格式无效');
 if(d.items!==undefined&&!Array.isArray(d.items))fail(400,'询盘商品格式无效');
 const items=d.items||[];if(items.length>100)fail(400,'询盘商品过多');
 const extras=d.customFields||{};if(typeof extras!=='object'||Array.isArray(extras)||Object.keys(extras).length>30)fail(400,'询盘补充资料格式无效');
 const customFields=Object.fromEntries(Object.entries(extras).map(([key,value])=>[text(key,160),text(value,500)]));
 const timestamp=value=>{const v=text(value,40);if(!Number.isFinite(Date.parse(v)))fail(400,'询盘日期无效');return new Date(v).toISOString();};
 return {schemaVersion:1,source,externalId,revision,createdAt:timestamp(input.createdAt),updatedAt:timestamp(input.updatedAt),
   assignee:{id:text(owner.id,100),email:text(owner.email,160).toLowerCase(),name:text(owner.name,120)},status:text(input.status,40),salesNote:text(input.salesNote,2000),
   details:{buyerType:text(d.buyerType,50),customFields,topic:text(d.topic,60),name:text(d.name,100),company:text(d.company,120),contactType:text(d.contactType,20),contact:text(d.contact,160),country:country(text(d.country,80)),city:text(d.city,100),address:text(d.address,600),note:text(d.note,2000),timeline:text(d.timeline,100),quantity:text(d.quantity,20),
    items:items.map(i=>{if(!i||typeof i!=='object'||Array.isArray(i))fail(400,'询盘商品格式无效');return ({productId:text(i.productId,100),name:text(i.name,200),quantity:text(i.quantity,20)});})}};
}

export async function receiveWebsiteInquiry(db,input,source='loongjump-website'){
 const data=envelope(input,source),raw=JSON.stringify(data),hash=await inquiryHash(raw),d=data.details;
 const previous=await one(db,'SELECT * FROM website_leads WHERE source=? AND external_id=?',[source,data.externalId]);
 const ack=lead=>({ok:true,source,externalId:data.externalId,revision:data.revision,leadId:lead.id});
 if(previous&&previous.source_revision>=data.revision){
   if(previous.source_revision===data.revision&&previous.source_hash!==hash)fail(409,'同一询盘版本包含不同内容，请核对网站同步队列');
   return {...ack(previous),replayed:true};
 }
 await assertWritable(db);
 const mapping=data.assignee.id?await one(db,'SELECT u.* FROM website_sales_mappings m JOIN users u ON u.id=m.admin_user_id WHERE m.source=? AND m.external_user_id=?',[source,data.assignee.id]):null;
 const mappedOwner=eligible(mapping)?mapping.id:null,now=stamp(),leadId=previous?.id||id('lead');
 const statements=[];
 if(!previous){
   const p=profile({name:d.company,contact:d.name,phone:d.contactType==='WhatsApp'?d.contact:'',email:d.contactType==='Email'?d.contact:'',city:d.city,address:d.address});
   statements.push(q(db,`INSERT INTO website_leads(id,source,external_id,source_revision,source_hash,source_json,source_owner_id,source_owner_email,owner_id,assignment_state,country,business_kind,profile_json,source_created_at,source_updated_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[leadId,source,data.externalId,data.revision,hash,raw,data.assignee.id,data.assignee.email,mappedOwner,mappedOwner?'mapped':'pending',d.country,d.topic==='Grosir'?'wholesale':d.topic==='OEM & Custom'?'oem':'unclassified',JSON.stringify(p),data.createdAt,data.updatedAt,now,now]));
 }else{
   const changedOwner=previous.source_owner_id!==data.assignee.id;
   // Website updates never overwrite locally verified profiles, customer links or manual ownership.
   statements.push(q(db,`UPDATE website_leads SET source_revision=?,source_hash=?,source_json=?,source_owner_id=?,source_owner_email=?,source_updated_at=?,
    assignment_state=CASE WHEN ? AND assignment_state<>'manual' THEN 'source_changed' ELSE assignment_state END,version=version+1,updated_at=? WHERE id=?`,[data.revision,hash,raw,data.assignee.id,data.assignee.email,data.updatedAt,changedOwner?1:0,now,leadId]));
 }
 const guard=previous?'EXISTS(SELECT 1 FROM website_leads WHERE id=? AND version=? AND source_revision=?)':'NOT EXISTS(SELECT 1 FROM website_leads WHERE source=? AND external_id=?)';
 const args=previous?[leadId,previous.version,previous.source_revision]:[source,data.externalId];
 if(!previous&&mappedOwner){args.push(mappedOwner);}
 try{await atomicBatch(db,[guardStatement(db,{id:'website-sync'},'websiteInquiry',guard+(!previous&&mappedOwner?' AND '+ownerGuard:''),args),...statements,event(db,null,leadId,previous?'网站询盘更新':source===distributorApplicationSource?'收到分销申请':'接收网站询盘',{externalId:data.externalId,revision:data.revision})]);}
 catch(error){const saved=await one(db,'SELECT id,source_revision,source_hash FROM website_leads WHERE source=? AND external_id=?',[source,data.externalId]);if(saved&&(saved.source_revision>data.revision||saved.source_revision===data.revision&&saved.source_hash===hash))return {...ack(saved),replayed:true};throw error;}
 return ack({id:leadId});
}

export async function readWebsiteLeads(db,actor,input={}){
 if(!canManageLeads(actor))fail(403,'当前账号无权查看网站线索');
 const scope=visible(actor),clauses=[scope.sql],args=[...scope.args];
 const applications=input.source===distributorApplicationSource;
 if(input.source&&!applications&&input.source!=='website')fail(400,'线索来源无效');
 if(applications){clauses.push('l.source=?');args.push(distributorApplicationSource);}else if(input.source==='website')clauses.push("l.source<>'distributor-application'");
 const status=text(input.status,30),kind=text(input.kind,30),search=text(input.search,100);
 if(status==='pool'){if(actor.role!=='管理员')fail(403,'待分配线索由管理员分配');clauses.push('(l.owner_id IS NULL OR NOT EXISTS(SELECT 1 FROM users u WHERE u.id=l.owner_id AND u.active=1))');}
 else if(status){if(!['new','following','quoted','converted','closed'].includes(status))fail(400,'线索状态无效');clauses.push('l.status=?');args.push(status);}
 if(kind){if(!['wholesale','oem','unclassified','other_country'].includes(kind))fail(400,'业务分类无效');if(kind==='other_country')clauses.push("l.country NOT IN ('','印尼')");else{clauses.push('l.business_kind=?');args.push(kind);}}
 if(search){clauses.push("(l.external_id LIKE ? ESCAPE '\\' OR l.profile_json LIKE ? ESCAPE '\\')");const needle='%'+search.replace(/[\\%_]/g,'\\$&')+'%';args.push(needle,needle);}
 const where=clauses.join(' AND '),total=Number((await one(db,`SELECT COUNT(*) n FROM website_leads l WHERE ${where}`,args)).n),pages=Math.max(1,Math.ceil(total/30));
 const page=Math.min(pages,Math.max(1,Number.isSafeInteger(Number(input.page))?Number(input.page):1));
 const records=await all(db,`SELECT l.*,u.name owner_name,u.active owner_active,c.name customer_name FROM website_leads l LEFT JOIN users u ON u.id=l.owner_id LEFT JOIN wholesale_customers c ON c.id=l.customer_id WHERE ${where} ORDER BY l.updated_at DESC,l.id DESC LIMIT 30 OFFSET ?`,[...args,(page-1)*30]);
 const recordsView=records.map(({source_json,profile_json,...rest})=>({...Object.fromEntries(Object.entries(rest).filter(([key])=>key!=='source_hash')),sourceData:parse(source_json),profile:parse(profile_json)}));
 const selected=input.id?await one(db,`SELECT l.* FROM website_leads l WHERE l.id=? AND ${scope.sql}`,[text(input.id,100),...scope.args]):null;
 if(input.id&&!selected)fail(404,'线索不存在或无查看权限');
 const events=selected?await all(db,'SELECT action,actor_name,detail_json,created_at FROM website_lead_events WHERE lead_id=? ORDER BY created_at,id',[selected.id]):[];
 const customers=await all(db,`SELECT id,code,name,phone,city,address,contact,sales_user_id,version FROM wholesale_customers WHERE active=1 ${actor.role==='管理员'?'':'AND sales_user_id=?'} ORDER BY name`,actor.role==='管理员'?[]:[actor.id]);
 const users=actor.role==='管理员'?await all(db,"SELECT id,name,email,role,site FROM users WHERE active=1 AND (role='管理员' OR role='销售' AND (site IS NULL OR site='' OR site='印尼') OR role='运营' AND site='印尼') ORDER BY name"):[];
 const counts=await all(db,`SELECT l.status,COUNT(*) n FROM website_leads l WHERE ${scope.sql}${applications?' AND l.source=?':input.source==='website'?" AND l.source<>'distributor-application'":''} GROUP BY l.status`,applications?[...scope.args,distributorApplicationSource]:scope.args);
 let detail=null;
 if(selected){
   const {source_json,profile_json,...rest}=selected;
   detail={...Object.fromEntries(Object.entries(rest).filter(([key])=>key!=='source_hash')),sourceData:parse(source_json),profile:parse(profile_json)};
 }
 // Customer linkage is explicit. Matching contact details are hints, never automatic identity merges.
 const p=detail?.profile,contactKey=p?.email||p?.phone;
 const related=contactKey?await all(db,`SELECT l.id,l.external_id,l.status,l.customer_id FROM website_leads l WHERE l.id<>? AND ${scope.sql} AND (json_extract(l.profile_json,'$.email')=? OR json_extract(l.profile_json,'$.phone')=?) ORDER BY l.created_at DESC LIMIT 30`,[selected.id,...scope.args,contactKey,contactKey]):[];
 const orders=selected?await all(db,`SELECT o.id,o.order_no,o.status,o.total_qty,o.total_amount,o.customer_id FROM wholesale_orders o WHERE o.website_lead_id=? ${actor.role==='管理员'?'':'AND COALESCE(o.service_user_id,o.sales_user_id)=?'} ORDER BY o.created_at DESC`,actor.role==='管理员'?[selected.id]:[selected.id,actor.id]):[];
 const distributorLink=detail?.source===distributorApplicationSource&&detail.customer_id
   ? await one(db,'SELECT version,token_hash IS NOT NULL AS active FROM distributor_links WHERE customer_id=?',[detail.customer_id]):null;
 return {records:recordsView,detail,distributorLink,events:events.map(({detail_json,...row})=>({...row,detail:parse(detail_json)})),customers,users,related,orders,counts,total,page,pages};
}

export async function mutateWebsiteLead(db,actor,payload){
 if(!canManageLeads(actor))fail(403,'当前账号无权处理网站线索');
 await assertWritable(db);
 const operationId=text(payload.operationId,100);if(!/^[A-Za-z0-9_-]{16,100}$/.test(operationId))fail(400,'缺少有效操作编号');
 const hash=await inquiryHash(JSON.stringify(payload)),old=await one(db,'SELECT * FROM website_lead_operations WHERE id=?',[operationId]);
 if(old){if(old.actor_id!==actor.id||old.request_hash!==hash)fail(409,'操作编号已使用');return {...parse(old.result_json),replayed:true};}
 const lead=await one(db,'SELECT * FROM website_leads WHERE id=?',[text(payload.id,100)]);
 if(!lead||actor.role!=='管理员'&&lead.owner_id!==actor.id)fail(404,'线索不存在或无处理权限');
 if(lead.version!==Number(payload.version))fail(409,'线索已更新，请刷新后重试');
 const now=stamp(),statements=[],guardArgs=[lead.id,lead.version,actor.id,actor.role];
 let guard="EXISTS(SELECT 1 FROM website_leads WHERE id=? AND version=?) AND EXISTS(SELECT 1 FROM users WHERE id=? AND role=? AND active=1)";
 let result={ok:true,id:lead.id},detail={},action='';
 if(payload.action==='assign'){
   if(actor.role!=='管理员')fail(403,'仅管理员可以分配线索或对应销售账号');
   const owner=await one(db,'SELECT * FROM users WHERE id=?',[text(payload.ownerId,100)]);if(!eligible(owner))fail(400,'请选择有效的印尼销售或运营负责人');
   if(lead.customer_id){const customer=await one(db,'SELECT * FROM wholesale_customers WHERE id=?',[lead.customer_id]);if(customer?.sales_user_id!==owner.id)fail(409,'已关联客户的销售归属不同，请先在客户档案办理交接');}
   const reason=text(payload.reason,500);if(reason.length<4)fail(400,'请说明分配依据');
   guard+=' AND '+ownerGuard;guardArgs.push(owner.id);
   statements.push(q(db,"UPDATE website_leads SET owner_id=?,assignment_state='manual',version=version+1,updated_at=? WHERE id=?",[owner.id,now,lead.id]));
   if(payload.saveMapping===true){
     if(!lead.source_owner_id)fail(400,'网站尚未分配销售，不能保存账号对应关系');
     statements.push(q(db,'INSERT INTO website_sales_mappings(source,external_user_id,admin_user_id,actor_id,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(source,external_user_id) DO UPDATE SET admin_user_id=excluded.admin_user_id,actor_id=excluded.actor_id,updated_at=excluded.updated_at',[lead.source,lead.source_owner_id,owner.id,actor.id,now]));
     // Existing unassigned records remain reviewable; mapping only applies to new deliveries.
   }
   action='分配销售';detail={ownerId:owner.id,previousOwnerId:lead.owner_id,source:lead.source,sourceOwnerId:lead.source_owner_id,reason,saveMapping:payload.saveMapping===true};
 }else if(payload.action==='follow'){
   if(lead.customer_id)fail(409,'已转客户，请在客户档案维护资料');
   const p=profile(payload.profile),note=text(payload.note,2000),status=text(payload.status,30),next=text(payload.nextFollowUp,10);
   if(lead.source===distributorApplicationSource && (status==='closed'||lead.status==='closed') && actor.role!=='管理员')fail(403,'分销申请须由管理员审核');
   if(!['new','following','quoted','closed'].includes(status)||note.length<2)fail(400,'请选择跟进状态并填写跟进内容');
   if(p.phone&&!/^\+?[\d ()-]{8,60}$/.test(p.phone)||p.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email))fail(400,'电话或邮箱格式不正确');
   if(next&&(!/^\d{4}-\d{2}-\d{2}$/.test(next)||!Number.isFinite(Date.parse(next))||new Date(next).toISOString().slice(0,10)!==next))fail(400,'复跟日期无效');
   statements.push(q(db,'UPDATE website_leads SET profile_json=?,status=?,next_follow_up=?,version=version+1,updated_at=? WHERE id=?',[JSON.stringify(p),status,next||null,now,lead.id]));
   action=lead.source===distributorApplicationSource&&status==='closed'?'未通过分销申请':'销售跟进';detail={note,status,nextFollowUp:next,profile:p};
 }else if(payload.action==='qualify'){
   if(actor.role!=='管理员')fail(403,'跨国家及 OEM 转业务须由管理员确认');
   if(lead.customer_id)fail(409,'已转客户不能修改线索业务范围');
   const target=country(text(payload.country,80)),kind=text(payload.kind,30),reason=text(payload.reason,500);
   if(!target||!['wholesale','oem','unclassified'].includes(kind)||reason.length<4)fail(400,'请核实国家、业务类型并说明依据');
   statements.push(q(db,'UPDATE website_leads SET country=?,business_kind=?,qualification_note=?,version=version+1,updated_at=? WHERE id=?',[target,kind,reason,now,lead.id]));
   action='确认业务范围';detail={country:target,kind,reason};
 }else if(payload.action==='rejectApplication'){
   if(lead.source!==distributorApplicationSource||actor.role!=='管理员')fail(403,'分销申请须由管理员审核');
   if(lead.customer_id||lead.status==='closed')fail(409,'该申请已有审核结果');
   const reason=text(payload.reason,500);
   if(reason.length<4)fail(400,'请填写未通过的原因');
   statements.push(q(db,"UPDATE website_leads SET status='closed',version=version+1,updated_at=? WHERE id=?",[now,lead.id]));
   action='未通过分销申请';detail={reason};
 }else if(payload.action==='convert'){
   if(lead.source===distributorApplicationSource&&actor.role!=='管理员')fail(403,'分销申请须由管理员审核');
   if(lead.customer_id)return {ok:true,id:lead.id,customerId:lead.customer_id,replayed:true};
   if(lead.country!=='印尼'||lead.business_kind!=='wholesale')fail(400,'仅已确认的印尼批发线索可以转入 IDR 线下客户，其他国家及 OEM 请先保留并核实');
   if(lead.status==='closed')fail(409,'已关闭线索请先恢复跟进');
   const owner=await one(db,'SELECT * FROM users WHERE id=?',[lead.owner_id]);if(!eligible(owner))fail(400,'请先由管理员分配有效销售负责人');
   guard+=' AND '+ownerGuard;guardArgs.push(owner.id);
   const reason=text(payload.reason,500);if(payload.identityConfirmed!==true||reason.length<4)fail(400,'请核对客户身份并填写转客户依据');
   let customerId=text(payload.customerId,100);
   if(customerId){
     const c=await one(db,'SELECT * FROM wholesale_customers WHERE id=? AND active=1',[customerId]);
     if(!c||c.sales_user_id!==owner.id)fail(403,'只能关联同一销售负责人名下的有效客户，请管理员核对归属');
     if(!c.name||!c.contact||!c.phone||!c.city||!c.address)fail(400,'客户资料不全，请先补齐电话、城市和收货地址');
     guard+=' AND EXISTS(SELECT 1 FROM wholesale_customers WHERE id=? AND active=1 AND sales_user_id=? AND version=?)';guardArgs.push(c.id,owner.id,c.version);
   }else{
     const p=profile(parse(lead.profile_json));
     if(!p.name||!p.contact||!p.phone||!p.city||!p.address)fail(400,'资料未齐，请补齐客户名称、联系人、电话、城市和收货地址；不要填写占位内容');
     if(!/^\+?[\d ()-]+$/.test(p.phone)||p.phone.replace(/\D/g,'').length<8||p.phone.replace(/\D/g,'').length>15)fail(400,'请填写真实有效的客户电话');
     let duplicate="active=1 AND lower(trim(name))=lower(trim(?)) AND replace(replace(phone,' ',''),'-','')=replace(replace(?,' ',''),'-','')";
     if(lead.source===distributorApplicationSource){
       // Existing Indonesian customer records can store 08..., 628... or +628... .
       const normalized=column=>`replace(replace(replace(replace(replace(${column},' ',''),'-',''),'(',''),')',''),'+','')`;
       const canonical=column=>`CASE WHEN ${normalized(column)} LIKE '0%' THEN '62'||substr(${normalized(column)},2) ELSE ${normalized(column)} END`;
       duplicate="active=1 AND lower(trim(name))=lower(trim(?)) AND "+canonical('phone')+"=(SELECT "+canonical('number')+" FROM (SELECT ? AS number))";
     }
     if(await one(db,'SELECT id FROM wholesale_customers WHERE '+duplicate,[p.name,p.phone]))fail(409,'已有同名同电话客户，请核对并选择关联，避免重复建档');
     guard+=' AND NOT EXISTS(SELECT 1 FROM wholesale_customers WHERE '+duplicate+')';guardArgs.push(p.name,p.phone);
     customerId=id('customer');
     statements.push(q(db,'INSERT INTO wholesale_customers(id,code,name,contact,phone,city,address,note,sales_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[customerId,'ID-C-'+crypto.randomUUID().slice(0,8).toUpperCase(),p.name,p.contact,p.phone,p.city,p.address,(lead.source===distributorApplicationSource?'来自分销申请 ':'来自网站询盘 ')+lead.external_id,owner.id,now,now]));
   }
   statements.push(q(db,"UPDATE website_leads SET customer_id=?,status='converted',version=version+1,updated_at=? WHERE id=?",[customerId,now,lead.id]));
   if(lead.source===distributorApplicationSource)statements.push(storeInsert(db,customerId,actor,{approved:true}));
   action=lead.source===distributorApplicationSource?'批准分销申请':'线索转客户';detail={customerId,reason,linkedExisting:Boolean(payload.customerId)};result={...result,customerId};
 }else fail(400,'线索操作无效');
 await atomicBatch(db,[guardStatement(db,actor,'websiteLead',guard,guardArgs),...statements,event(db,actor,lead.id,action,detail),q(db,'INSERT INTO website_lead_operations(id,actor_id,request_hash,lead_id,result_json,created_at) VALUES(?,?,?,?,?,?)',[operationId,actor.id,hash,lead.id,JSON.stringify(result),now])]);
 return result;
}
