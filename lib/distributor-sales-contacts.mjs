import {assertWritable,atomicBatch,guardStatement} from './atomic.mjs';
import {distFail} from './distributor-accounts.mjs';

const eligible="active=1 AND (role IN ('管理员','销售') OR (role='运营' AND site='印尼'))";
export function normalizeSalesWhatsApp(value){
 if(typeof value!=='string'||value.length>40)distFail(400,'请填写带国家区号的 WhatsApp 号码');
 let phone=value.trim().replace(/[\s().-]/g,'');
 if(/^08\d{7,12}$/.test(phone))phone='+62'+phone.slice(1);
 if(phone.startsWith('00'))phone='+'+phone.slice(2);
 if(phone&&!/^\+[1-9]\d{7,14}$/.test(phone))distFail(400,'请填写有效国际号码，例如 +62… 或 +86…，不要粘贴网址');
 return phone;
}
export async function saveDistributorSalesContact(db,actor,input){
 if(actor.role!=='管理员')distFail(403,'仅管理员可维护对外销售联系方式');
 const {userId,version}=input;
 if(typeof userId!=='string'||!Number.isSafeInteger(version)||version<0)distFail(400,'请选择销售账号并刷新版本');
 const displayName=typeof input.displayName==='string'?input.displayName.trim():'';
 const whatsapp=normalizeSalesWhatsApp(input.whatsapp);
 if(displayName.length>80||/[\u0000-\u001f\u3400-\u9fff<>]/u.test(displayName)||whatsapp&&!displayName)distFail(400,'请填写供印尼客户识别的对外姓名（英文或印尼语，最多80字）');
 await assertWritable(db);
 const guard=`EXISTS(SELECT 1 FROM users WHERE id=? AND ${eligible}) AND COALESCE((SELECT version FROM distributor_sales_contacts WHERE user_id=?),0)=?`;
 const now=new Date().toISOString();
 await atomicBatch(db,[
  guardStatement(db,actor,'更新分销销售联系方式',guard,[userId,userId,version],crypto.randomUUID(),{userId,version}),
  db.prepare(`INSERT INTO distributor_sales_contacts(user_id,display_name,whatsapp,version,updated_by,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,whatsapp=excluded.whatsapp,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).bind(userId,displayName,whatsapp,version+1,actor.id,now),
  db.prepare("INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,'分销销售联系',?,?,?,?,?)")
    .bind(crypto.randomUUID(),'更新分销销售联系方式',userId,JSON.stringify({displayName,whatsapp,version:version+1}),actor.id,actor.name,now)
 ]);
 return {version:version+1};
}
export async function distributorSalesContact(db,ownerId){
 const row=await db.prepare(`SELECT c.display_name,c.whatsapp FROM users u JOIN distributor_sales_contacts c ON c.user_id=u.id WHERE u.id=? AND u.active=1 AND (u.role IN ('管理员','销售') OR (u.role='运营' AND u.site='印尼'))`).bind(ownerId).first();
 if(!row||!/^\+[1-9]\d{7,14}$/.test(row.whatsapp)||!row.display_name)return null;
 return {name:row.display_name,whatsapp:row.whatsapp,href:'https://wa.me/'+row.whatsapp.slice(1)+'?text='+encodeURIComponent('Halo, saya mitra LOONG JUMP. Saya ingin bertanya tentang produk atau pesanan toko saya.')};
}
