import {hasPermission} from './permissions.mjs';
export const transportSteps=[['booking','订舱交接'],['sea_freight','海运运输'],['port_arrived','已到港'],['customs_clearance','清关中'],['last_mile_delivery','派送中'],['awaiting_receipt','待仓库签收'],['shelf_pending','待运营上架'],['on_shelf','已完成']];
const actions={
  booking:{label:'登记开船并交接海运',owner:'供应链',hint:'填写开船日期（ETD）、预计到仓日期（ETA）及交接凭证。确认后由承运商对应的海运账号跟进。',permission:'transport.advance.supply'},
  sea_freight:{label:'登记已到港',owner:'海运',hint:'货物实际到港后，填写到港通知或物流凭证与说明，进入已到港节点。',permission:'transport.advance.sea'},
  port_arrived:{label:'登记转入清关',owner:'海运',hint:'填写实际到港日期、港口及清关交接凭证，进入清关中。',permission:'transport.advance.sea'},
  customs_clearance:{label:'登记清关完成并派送',owner:'海运',hint:'清关放行后，填写放行或派送凭证，进入目的地派送。',permission:'transport.advance.sea'},
  last_mile_delivery:{label:'交仓并通知供应链签收',owner:'海运',hint:'交付目的仓后填写交仓凭证。下一步由供应链核对实收与破损数量。',permission:'transport.advance.sea'},
  awaiting_receipt:{label:'登记到仓数量',owner:'供应链',hint:'按实际签收分批登记，填写到仓单号、凭证及隔离数量。全部收齐后交对应站点运营上架；登记到仓还不会增加可售库存。',permission:'transport.receive'},
  shelf_pending:{label:'确认上架',owner:'运营',hint:'对应站点运营核对平台已上架数量与凭证，确认后转为可售库存。隔离品须由供应链处理，不能直接上架。',permission:'transport.shelf'},
};
export function transportGuidance(leg,actor,users=[]){
  const config=actions[leg.stage],index=transportSteps.findIndex(([key])=>key===leg.stage);
  if(!config)return {index,label:leg.stage==='on_shelf'?'已完成':'未知节点',owner:'—',hint:leg.stage==='on_shelf'?'到仓及上架流程已完成，可展开查看SKU与节点记录。':'当前状态无法识别，请刷新后联系管理员核对。',allowed:false,canEta:false};
  const assigned=actor.role==='管理员'||actor.role==='海运'&&actor.id===leg.assigned_user_id;
  const ownScope=actor.role!=='运营'||actor.site===leg.site&&actor.channel===leg.channel;
  const allowed=hasPermission(actor.role,config.permission)&&(config.owner!=='海运'||assigned)&&ownScope;
  const responsible=users.find(u=>u.id===leg.assigned_user_id)||(actor.id===leg.assigned_user_id?actor:null);
  const owner=config.owner==='海运'?`${responsible?.name||'承运商对应海运账号'}${!leg.assigned_user_id?'（尚未绑定，请管理员核对承运商）':''}`:config.owner==='运营'?`${leg.site} · ${leg.channel} 运营`:config.owner;
  return {...config,index,owner,allowed,canEta:index>=0&&index<=4&&hasPermission(actor.role,'transport.eta')&&assigned};
}
