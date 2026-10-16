import { SALE_TYPES,saleTypeLabel,productStatus,cooperationMode } from "./wholesale-types.mjs";
import { translateWholesale } from "./wholesale-i18n.mjs";
import { WholesaleError } from "./wholesale.mjs";

// A:Q follows the customer's warehouse template. Additional traceability stays to the right.
export const OUTBOUND_HEADERS=["序号","出库日期","客户代码","出库单号","SKU编码","产品名称","产品颜色","产品尺寸","订单数量","单价","金额合计","商品状态","客户合作方式","客户代码","业务代码","销售员","出库经办人","业务类型","原订单号","订单日期","订单版本","发货仓库","联系人","联系方式","收货地址"];
export function warehouseSheets(snapshot,{mode,orderId,version,month,language="zh",exportedAt=""}){
  const t=v=>translateWholesale(language,v),preparing=mode==="prepare";
  let orders=snapshot.orders;
  if(preparing){
    if(!["管理员","财务","供应链"].includes(snapshot.actor.role))throw new WholesaleError(403,"无权导出仓库备货单");
    const order=orders.find(o=>o.id===orderId);
    if(!order)throw new WholesaleError(404,"订单不存在或不在本人责任范围内");
    if(Number(version)!==Number(order.version))throw new WholesaleError(409,"订单已更新，请刷新后重新导出备货单");
    if(!["approved","packing","partial"].includes(order.status))throw new WholesaleError(409,"仅已审核且尚未完成发货的订单可导出备货单");
    orders=[order];
  }
  const rows=[];
  const append=(o,item,{qty,date="",no="",actor="",warehouse=""})=>{
    rows.push([`P${String(rows.length+1).padStart(3,"0")}`,date,o.customer?.code||"",no,item.sku,item.name,item.product_color||t("未维护"),item.product_size||t("未维护"),qty,Number(item.unit_price),qty*Number(item.unit_price),t(productStatus(o.sale_type)),t(cooperationMode(o.sale_type)),o.customer?.code||"",o.business_code||t("未维护"),o.sales_name||"",actor,t(saleTypeLabel(o.sale_type)),o.order_no,o.business_date,o.version,warehouse,o.customer?.contact||"",o.customer?.phone||"",o.customer?.address||""]);
  };
  for(const o of orders){
    if(preparing){for(const item of o.items){const qty=Number(item.qty)-Number(item.shipped_qty);if(qty>0)append(o,item,{qty,actor:t("待实际出库登记")});}}
    else for(const s of o.shipments.filter(s=>s.business_date.startsWith(month)))for(const si of s.items){
      const item=o.items.find(i=>i.id===si.order_item_id);
      if(!item)throw new WholesaleError(500,"出库记录缺少原始SKU，无法生成明细");
      append(o,item,{qty:Number(si.qty),date:s.business_date,no:s.shipment_no,actor:s.actor_name||s.actor_id||"",warehouse:s.warehouse});
    }
  }
  if(preparing&&!rows.length)throw new WholesaleError(409,"该订单已无待备货数量，请刷新核对");
  const name=t(preparing?"仓库备货单":"商品销售出库明细");
  const note=t(preparing?"仅供仓库备货，数量为导出时未发余量；不代表已付款或已出库，不扣库存。发货前核对最新订单，避免重复备货。":"仅统计所选月实际出库记录，每次分批出库单独列示；退货另表核对。寄售金额为出库货值，不代表客户已售或已收款。");
  const header=OUTBOUND_HEADERS.map(t);if(preparing)header[8]=t("本次待备货数量");
  const summary=Object.keys(SALE_TYPES).concat("legacy").map(type=>{const selected=rows.filter(r=>r[17]===t(saleTypeLabel(type)));return [t(saleTypeLabel(type)),selected.length,selected.reduce((s,r)=>s+r[8],0),selected.reduce((s,r)=>s+r[10],0)];});
  return [{name,title:preparing?`${name} · ${orders[0].order_no}`:`${month} · ${name}`,headers:header,rows,template:true,note:`${note}\n${t("导出时间UTC")}: ${exportedAt}`},
    {name:t("业务分类汇总"),headers:[t("业务类型"),t("明细行数"),t("数量"),t("货值IDR")],rows:summary}];
}
