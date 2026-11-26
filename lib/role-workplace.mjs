// Entries describe where a role works; approval authority still comes from
// workplace profiles and explicit grants on the server.
export const operationsWorkplaceRoles=Object.freeze(['运营','运营主管']);
export function personalWorkplaceEntries(actor){
 const entries=[
  {page:'attendance',view:'mine',label:'每日打卡',icon:'audit'},
  {page:'attendance',view:'leave',label:'请假申请',icon:'monthly'},
 ];
 if(actor.role==='运营')entries.push({page:'finance-workbench',view:'advertising',label:'广告申请',icon:'promotions'});
 if(operationsWorkplaceRoles.includes(actor.role))entries.push({page:'finance-workbench',view:'advertising-trend',label:'广告趋势分析',icon:'sales'});
 return entries;
}
export function workplaceSection(actor,page,section=''){
 if(page==='attendance')return ['management','approvals'].includes(section)?section:section==='leave'?'leave':'mine';
 if(page!=='finance-workbench')return section;
 if(section==='advertising')return actor.role==='运营'?section:'advertising-approvals';
 if(section==='advertising-trend')return operationsWorkplaceRoles.includes(actor.role)?section:'expenses';
 return section==='advertising-approvals'?section:'expenses';
}
export function workplaceScope(view,section){
 return view==='attendance'&&['mine','leave'].includes(section)||view==='finance'&&section==='advertising'?'mine':'authorized';
}
export function workplaceAccess(c){
 const leads=c.profiles.some(p=>p.active&&p.manager_id===c.a.id)||c.grants.some(g=>g.user_id===c.a.id&&g.capability==='manager');
 const ownGrants=c.grants.filter(g=>g.user_id===c.a.id);
 return {
  attendanceManagement:c.a.role==='管理员'||leads||ownGrants.some(g=>['hr','executive'].includes(g.capability)),
  advertisingApprovals:['管理员','财务','运营主管'].includes(c.a.role)||leads||ownGrants.some(g=>g.capability==='finance'),
 };
}
export function financeWorkplaceTabs(actor,access={}){
 return [
  ...(actor.role==='运营'?[{view:'advertising',label:'广告申请'}]:[]),
  ...(operationsWorkplaceRoles.includes(actor.role)?[{view:'advertising-trend',label:'广告趋势分析'}]:[]),
  ...(access.advertisingApprovals?[{view:'advertising-approvals',label:'广告审批'}]:[]),
  {view:'expenses',label:'费用与付款'},
 ];
}
