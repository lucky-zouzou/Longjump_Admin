import {navigationForRole,ROLE_PERMISSIONS} from './permissions.mjs';
import {MODULE_FIELDS} from './workspace-model.mjs';

// A successful HTTP status can still contain a proxy page or an incomplete body.
// Reject it before replacing the last usable workspace snapshot.
export async function parseWorkspaceResponse(response, {snapshot=false}={}) {
  let result;
  try { result=await response.json(); }
  catch { throw new Error('服务器返回了无法识别的结果，请刷新核对状态，勿重复提交'); }
  if(!response.ok)throw new Error(typeof result?.error==='string'?result.error:'操作失败');
  if(!result||typeof result!=='object'||Array.isArray(result)||result.error)
    throw new Error(typeof result?.error==='string'?result.error:'服务器返回的数据不完整，请刷新核对状态，勿重复提交');
  if(snapshot){
    const actor=result.actor,fields=MODULE_FIELDS[result.module];
    if(!actor||typeof actor.id!=='string'||!actor.id||!Object.hasOwn(ROLE_PERMISSIONS,actor.role)||
      !fields||!navigationForRole(actor.role).includes(result.module)||!Array.isArray(result.myTasks)||
      fields.filter(key=>!(actor.role==='工厂'&&key==='adSpend')).some(key=>key==='currentMonth'?typeof result[key]!=='string':key==='metrics'?
        !result[key]||typeof result[key]!=='object'||Array.isArray(result[key]):!Array.isArray(result[key])))
      throw new Error('工作区数据不完整，请刷新重试；上次数据已保留');
  }
  return result;
}
