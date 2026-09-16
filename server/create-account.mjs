import {randomUUID} from 'node:crypto';
import {hashPassword} from './accounts.mjs';
import {hasPermission} from '../lib/permissions.mjs';

class AccountError extends Error {
  constructor(status,message){super(message);this.status=status;}
}

function field(input,key,label,max,required=false){
  const value=input[key];
  if(value!=null&&typeof value!=='string')throw new AccountError(400,`${label}格式不正确`);
  const text=(value??'').trim();
  if((required&&!text)||text.length>max)throw new AccountError(400,`请填写${label}，最多${max}个字符`);
  return text;
}

// Web creation is insert-only: it must never reset or overwrite an existing account.
// Users, credentials and audit history commit together on the same connection.
export function createCompanyAccount(db,actor,input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new AccountError(400,'请求内容格式不正确');
  const name=field(input,'name','姓名',120,true);
  const email=field(input,'email','邮箱',254,true).toLowerCase();
  const role=field(input,'role','角色',20,true);
  const responsibilityUnit=field(input,'responsibilityUnit','责任单位',120)||null;
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new AccountError(400,'请填写有效的邮箱地址');
  if(!['管理员','销售','运营','运营主管','新品开发','财务','供应链','工厂','海运'].includes(role))throw new AccountError(400,'角色无效');
  let site=null,channel=null;
  if(role==='运营'){
    site=field(input,'site','站点',20,true);
    channel=field(input,'channel','渠道',20,true);
    if(!['马来西亚','印尼','泰国','越南','菲律宾'].includes(site)||!['TikTok','Shopee'].includes(channel))throw new AccountError(400,'运营账号必须选择有效站点和 TikTok / Shopee 渠道');
  }else if(role==='销售'){site='印尼';channel='线下分销';}
  if(input.active!==undefined&&typeof input.active!=='boolean')throw new AccountError(400,'账号状态无效');
  const active=input.active===false?0:1;
  if(typeof input.password!=='string'||input.password.length<12||input.password.length>256)throw new AccountError(400,'初始密码必须为12—256个字符');

  db.exec('BEGIN IMMEDIATE');
  try{
    const admin=db.prepare('SELECT role,active,name FROM users WHERE id=?').get(actor.id);
    if(!admin||admin.active!==1||!hasPermission(admin.role,'user.manage'))throw new AccountError(403,'只有启用中的管理员可以新增用户');
    const now=new Date().toISOString();
    const lock=db.prepare("SELECT mode,expires_at FROM system_maintenance WHERE id='global'").get();
    if(lock&&lock.mode!=='normal'&&lock.expires_at>now)throw new AccountError(409,'系统正在备份或迁移，请稍后再新增用户');
    if(db.prepare('SELECT 1 FROM users WHERE lower(email)=? UNION ALL SELECT 1 FROM local_accounts WHERE lower(email)=? LIMIT 1').get(email,email))throw new AccountError(409,'该邮箱已存在，请在成员列表中管理已有账号');
    const userId=`company_${randomUUID()}`;
    const passwordHash=hashPassword(input.password);
    db.prepare('INSERT INTO users (id,email,name,role,site,channel,responsibility_unit,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(userId,email,name,role,site,channel,responsibilityUnit,active,now,now);
    db.prepare('INSERT INTO local_accounts (user_id,email,password_hash,updated_at) VALUES (?,?,?,?)').run(userId,email,passwordHash,now);
    db.prepare('INSERT INTO audit_logs (id,actor_id,actor_name,action,entity_type,entity_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?)').run(`audit_${randomUUID()}`,actor.id,admin.name,'新增用户','user',userId,JSON.stringify({email,name,role,site,channel,responsibilityUnit,active}),now);
    db.exec('COMMIT');
    return {userId};
  }catch(error){db.exec('ROLLBACK');throw error;}
}
