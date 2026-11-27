import {canCreatorScope} from './creator-policy.mjs';
import {fail,required,integer} from './creator-model.mjs';

export const mcnScopes=(actor,context)=>actor.role==='达人BD'?context.scopes.filter(s=>s.site==='印尼'&&s.platform==='TikTok'&&canCreatorScope(actor,s)):[];
export function mcnTerms(payload,signedOn,actor){
 if(payload.confirmed!==true)fail('请确认已与 MCN 核对协议和寄样条件');
 const mcn={name:required(payload.mcn?.name,'MCN 机构名称',150),contactName:required(payload.mcn?.contactName,'机构联系人',100),contactMethod:required(payload.mcn?.contactMethod,'机构联系方式',200),cooperationRef:required(payload.mcn?.cooperationRef,'本次合作编号',150),purpose:required(payload.mcn?.purpose,'寄样用途',1000)};
 if(!Array.isArray(payload.items)||!payload.items.length||payload.items.length>100)fail('请填写1至100项寄样 SKU');
 const items=payload.items.map(i=>({sku:required(i.sku,'寄样 SKU',150),sampleQty:integer(i.sampleQty,'样品数量',1,10000)}));
 if(new Set(items.map(i=>i.sku)).size!==items.length)fail('同一 SKU 请合并数量，不要重复填写');
 if(!['sample_only','content'].includes(payload.fulfillment))fail('请选择机构合作交付方式');
 const content={status:payload.fulfillment==='sample_only'?'not_required':'executing',requirement:required(payload.requirement,'机构约定交付说明',2000),dueDate:''};
 if(payload.fulfillment==='content'){
  const date=String(payload.dueDate||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||date<signedOn)fail('机构交付日期无效或早于协议签署日期');
  content.dueDate=date;
 }
 const normalize=s=>s.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
 return {mcn,key:JSON.stringify([normalize(mcn.name),normalize(mcn.cooperationRef)]),content,terms:{items,sampleQty:items.reduce((n,i)=>n+i.sampleQty,0),sampleOnly:payload.fulfillment==='sample_only',requirement:content.requirement,dueDate:content.dueDate,confirmedBy:actor.id}};
}
