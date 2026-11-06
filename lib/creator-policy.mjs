export async function creatorActor(db,actor){
 const user=await db.prepare('SELECT u.role,u.active,b.display_name FROM users u LEFT JOIN creator_bd_names b ON b.user_id=u.id WHERE u.id=?').bind(actor.id).first();
 const lead=await db.prepare('SELECT active FROM creator_leads WHERE user_id=?').bind(actor.id).first();
 const owned=(await db.prepare('SELECT DISTINCT scope_id FROM creator_profiles WHERE owner_bd_id=?').bind(actor.id).all()).results;
 return {...actor,name:user?.display_name||actor.name,creatorLead:!!(user?.active&&user.role==='达人BD'&&lead?.active),creatorScopeIds:owned.map(p=>p.scope_id)};
}
export const canCreatorScope=(a,s)=>!!s&&(['管理员','运营主管','财务'].includes(a.role)||a.creatorLead||(a.role==='达人BD'&&(s.bd_id===a.id||a.creatorScopeIds?.includes(s.id)))||(a.role==='运营'&&[s.operator_id,s.backup_id].includes(a.id)));
export const canReviewExperience=a=>['管理员','运营主管'].includes(a.role)||a.creatorLead===true;
export const canManageBd=a=>a.role==='管理员'||a.creatorLead===true;
export const canDeliverCreator=(a,p)=>a.role==='运营'||a.role==='达人BD'&&(a.creatorLead||!p.owner_bd_id||p.owner_bd_id===a.id);
export const canCreatorProfile=(a,p,s)=>canCreatorScope(a,s)&&(a.role!=='达人BD'||a.creatorLead||(p.owner_bd_id||s.bd_id)===a.id);
