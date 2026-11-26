export async function financeMode(db,actor){
 if(actor?.role!=='财务')return actor?.role==='管理员'?'headquarters':null;
 const r=await db.prepare('SELECT mode FROM finance_access_modes WHERE user_id=?').bind(actor.id).first();
 // Existing finance accounts keep their documented HQ boundary until an administrator changes it.
 return r?.mode||'headquarters';
}
export function scopedFinanceRequestAllowed(request){
 const u=new URL(request.url);if(u.pathname==='/api/finance-hub')return request.method==='GET';
 if(['/api/workplace','/api/workplace/files','/api/employee-assistant'].includes(u.pathname))return ['GET','POST'].includes(request.method);
 return u.pathname==='/api/system'&&request.method==='GET'&&['home','attendance','finance-workbench',null].includes(u.searchParams.get('module'))&&[...u.searchParams.entries()].every(([k,v])=>k==='module'||k==='navigation'&&['shell','page','tasks'].includes(v));
}
