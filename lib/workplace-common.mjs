import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';
export const rows=async(db,sql,args=[])=>(await db.prepare(sql).bind(...args).all()).results||[];
export function fail(message,status=400){throw Object.assign(new Error(message),{status});}
export function text(v,label,max=160){if(typeof v!=='string'||!v.trim()||v.trim().length>max)fail(`${label}不能为空或过长`);return v.trim();}
export function day(v){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v+'T00:00:00Z'))||new Date(v+'T00:00:00Z').toISOString().slice(0,10)!==v)fail('日期无效');return v;}
export const clock=async db=>(await db.prepare("SELECT version FROM workplace_clock WHERE id='global'").first()).version;
export async function context(db,a){
 const version=await clock(db),live=await db.prepare('SELECT id,name,role,site,channel,active FROM users WHERE id=?').bind(a?.id||'').first();
 if(!live?.active||live.role!==a.role)fail('账号权限已变化',403);
 const [units,profiles,shifts,grants]=await Promise.all(['workplace_units','workplace_profiles','workplace_shifts','workplace_grants'].map(t=>rows(db,`SELECT * FROM ${t}`)));
 const c={db,a:live,version,units,profiles,shifts,grants};c.profile=profiles.find(p=>p.user_id===live.id&&p.active&&units.some(u=>u.id===p.unit_id&&u.active&&(!live.site||live.site===u.site)));return c;
}
export const has=(c,cap,unit)=>c.grants.some(g=>g.user_id===c.a.id&&g.unit_id===unit&&g.capability===cap)&&(cap!=='finance'||c.a.role==='财务');
export const manager=(c,user,unit)=>c.a.id!==user&&(c.profiles.some(p=>p.user_id===user&&p.unit_id===unit&&p.active&&p.manager_id===c.a.id)||has(c,'manager',unit));
export const canRead=(c,r)=>r.user_id===c.a.id||manager(c,r.user_id,r.unit_id)||has(c,r.kind==='expense'?'finance':'hr',r.unit_id)||(r.kind==='expense'&&has(c,'executive',r.unit_id));
export function event(db,a,id,action,data){const at=new Date().toISOString(),json=JSON.stringify(data);return [db.prepare('INSERT INTO workplace_events VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),id,action,a.id,json,at),db.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),`workplace.${action}`,'workplace',id,json,a.id,a.name,at)];}
export const guard=c=>guardStatement(c.db,c.a,'workplace',"(SELECT version FROM workplace_clock WHERE id='global')=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role=?) AND NOT EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>?)",[c.version,c.a.id,c.a.role,new Date().toISOString()]);
export async function write(c,statements){await assertWritable(c.db);await atomicBatch(c.db,[guard(c),...statements]);}
export function profileRequired(c){if(!c.profile)fail('请先由管理员配置组织、岗位和直属主管');return c.profile;}
export function requestVersion(r,p){if(!r||r.version!==Number(p.version))fail('单据版本已变化，请刷新',409);}
export async function configure(db,a,p){
 const c=await context(db,a),admin=a.role==='管理员',id=p.id||crypto.randomUUID();let statement,detail;
 if(p.action==='unit'){
  if(!admin)fail('仅管理员配置组织',403);const old=c.units.find(x=>x.id===id);if((old?.version||0)!==Number(p.version||0))fail('配置版本已变化',409);
  const tz=text(p.timezone,'时区');try{new Intl.DateTimeFormat('en',{timeZone:tz});}catch{fail('请输入有效的 IANA 时区');}
  const site=text(p.site,'站点');if(!['印尼','马来西亚','泰国','越南','菲律宾','中国'].includes(site))fail('站点无效');
  detail={name:text(p.name,'组织名称'),legalEntity:text(p.legalEntity,'法人主体'),site,department:text(p.department,'部门'),workplace:text(p.workplace,'工作地点'),timezone:tz};
  // Identity/scope is immutable once used; create a new unit for transfers.
  if(old&&(old.legal_entity!==detail.legalEntity||old.site!==site||old.timezone!==tz))fail('法人、站点和时区不可原地修改，请新建组织并调整人员归属');
  statement=db.prepare('INSERT INTO workplace_units VALUES(?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET name=excluded.name,department=excluded.department,workplace=excluded.workplace,version=excluded.version').bind(id,detail.name,detail.legalEntity,site,detail.department,detail.workplace,tz,(old?.version||0)+1);
 }else if(p.action==='shift'){
  const unit=c.units.find(u=>u.id===p.unitId&&u.active);if(!unit||!(admin||has(c,'hr',unit.id)))fail('无权配置该组织班次',403);const old=c.shifts.find(s=>s.id===id);if((old?.version||0)!==Number(p.version||0)||old&&old.unit_id!==unit.id)fail('班次版本或组织已变化',409);
  const ints=[p.startMinute,p.endMinute,p.graceIn??0,p.graceOut??0].map(Number);if(ints.some(n=>!Number.isInteger(n))||ints.slice(0,2).some(n=>n<0||n>1439)||ints[0]===ints[1]||ints.slice(2).some(n=>n<0||n>120))fail('请设置有效班次时间和宽限分钟');
  if(!Array.isArray(p.weekdays)||!p.weekdays.length||p.weekdays.some(n=>!Number.isInteger(n)||n<0||n>6))fail('请选择工作星期，周日为0');detail={unitId:unit.id,name:text(p.name,'班次名称'),startMinute:ints[0],endMinute:ints[1],weekdays:[...new Set(p.weekdays)],graceIn:ints[2],graceOut:ints[3]};
  statement=db.prepare('INSERT INTO workplace_shifts VALUES(?,?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET name=excluded.name,start_minute=excluded.start_minute,end_minute=excluded.end_minute,weekdays_json=excluded.weekdays_json,grace_in=excluded.grace_in,grace_out=excluded.grace_out,version=excluded.version').bind(id,unit.id,detail.name,ints[0],ints[1],JSON.stringify(detail.weekdays),ints[2],ints[3],(old?.version||0)+1);
 }else if(p.action==='profile'){
  if(!admin)fail('仅管理员配置人员组织与主管',403);const users=await rows(db,'SELECT id,active,site,role FROM users'),u=users.find(x=>x.id===p.userId&&x.active),unit=c.units.find(x=>x.id===p.unitId&&x.active),old=c.profiles.find(x=>x.user_id===p.userId),managerId=p.managerId||null,shiftId=p.shiftId||null;
  if(!u||!unit||managerId&&(!users.some(x=>x.id===managerId&&x.active)||managerId===u.id)||shiftId&&!c.shifts.some(x=>x.id===shiftId&&x.unit_id===unit.id&&x.active))fail('人员、主管或班次配置无效');
  if(u.site&&u.site!==unit.site)fail('员工账号站点与组织不一致，请先核对人员归属');if((old?.version||0)!==Number(p.version||0))fail('人员配置已变化',409);
  const seen=new Set([u.id]);let next=managerId;while(next){if(seen.has(next))fail('主管关系不能形成循环');seen.add(next);next=c.profiles.find(x=>x.user_id===next)?.manager_id;}
  detail={userId:u.id,unitId:unit.id,jobTitle:text(p.jobTitle,'组织岗位'),managerId,shiftId};statement=db.prepare('INSERT INTO workplace_profiles VALUES(?,?,?,?,?,?,1) ON CONFLICT(user_id) DO UPDATE SET unit_id=excluded.unit_id,job_title=excluded.job_title,manager_id=excluded.manager_id,shift_id=excluded.shift_id,version=excluded.version,active=1').bind(u.id,unit.id,detail.jobTitle,managerId,shiftId,(old?.version||0)+1);
 }else if(p.action==='billScope'){
  if(!admin)fail('仅管理员可核定历史应付归属',403);const unit=c.units.find(u=>u.id===p.unitId&&u.active),key=text(p.businessKey,'原资金账应付编号');
  const source=await db.prepare("SELECT * FROM finance_documents WHERE kind='supplier_bill' AND business_key=? ORDER BY revision DESC LIMIT 1").bind(key).first();
  if(!unit||!source||source.status!=='active'||source.site!==unit.site||p.entityConfirmed!==true)fail('请核对原应付、国家及付款法人后确认归属');
  if(await db.prepare('SELECT business_key FROM workplace_bill_scopes WHERE business_key=?').bind(key).first())fail('应付已有归属，不可覆盖',409);
  detail={businessKey:key,unitId:unit.id,legalEntity:unit.legal_entity,reason:text(p.reason,'法人归属依据',500)};statement=db.prepare('INSERT INTO workplace_bill_scopes VALUES(?,?,?,?,?)').bind(key,unit.id,unit.legal_entity,a.id,new Date().toISOString());
 }else if(p.action==='financeMode'){
  if(!admin)fail('仅管理员配置财务范围',403);const u=await db.prepare("SELECT id FROM users WHERE id=? AND active=1 AND role='财务'").bind(p.userId||'').first();if(!u||!['headquarters','scoped'].includes(p.mode))fail('请选择有效财务账号与权限范围');
  detail={userId:u.id,mode:p.mode,reason:text(p.reason,'权限边界核定依据',500)};statement=db.prepare('INSERT INTO finance_access_modes VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET mode=excluded.mode,actor_id=excluded.actor_id,reason=excluded.reason,updated_at=excluded.updated_at').bind(u.id,p.mode,a.id,detail.reason,new Date().toISOString());
 }else if(p.action==='grant'){
  if(!admin)fail('仅管理员配置授权',403);if(!['hr','manager','finance','executive'].includes(p.capability)||!c.units.some(u=>u.id===p.unitId&&u.active))fail('授权范围无效');const u=await db.prepare('SELECT active,role FROM users WHERE id=?').bind(p.userId||'').first();if(!u?.active||p.capability==='finance'&&u.role!=='财务')fail('财务授权必须使用有效财务账号');detail={userId:p.userId,unitId:p.unitId,capability:p.capability,enabled:p.enabled===true,reason:text(p.reason,'授权变更依据',500)};
  statement=p.enabled===true?db.prepare('INSERT OR IGNORE INTO workplace_grants VALUES(?,?,?)').bind(p.userId,p.unitId,p.capability):db.prepare('DELETE FROM workplace_grants WHERE user_id=? AND unit_id=? AND capability=?').bind(p.userId,p.unitId,p.capability);
 }else fail('配置动作无效');
 await write(c,[statement,...event(db,c.a,p.userId||id,p.action,detail)]);return {ok:true,id};
}
export async function configurationView(c){
 const admin=c.a.role==='管理员',units=c.units.filter(u=>admin||u.id===c.profile?.unit_id||c.grants.some(g=>g.user_id===c.a.id&&g.unit_id===u.id));
 return {financeModes:admin?await rows(c.db,'SELECT * FROM finance_access_modes'):[],units,shifts:c.shifts.filter(s=>units.some(u=>u.id===s.unit_id)),profiles:c.profiles.filter(p=>admin||p.user_id===c.a.id||has(c,'hr',p.unit_id)||manager(c,p.user_id,p.unit_id)),grants:c.grants.filter(g=>admin||g.user_id===c.a.id),users:admin?await rows(c.db,'SELECT id,name,role,site FROM users WHERE active=1'):[],canConfigure:admin};
}
