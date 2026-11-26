import { SALE_TYPES,saleTypeLabel,productStatus,cooperationMode } from "./wholesale-types.mjs";
import { translateWholesale } from "./wholesale-i18n.mjs";
import { WholesaleError } from "./wholesale.mjs";

// A:Q follows the customer's warehouse template. Additional traceability stays to the right.
export const OUTBOUND_HEADERS=["序号","出库日期","客户代码","出库单号","SKU编码","产品名称","产品颜色","产品尺寸","订单数量","单价","金额合计","商品状态","客户合作方式","客户代码","业务代码","销售员","出库经办人","业务类型","原订单号","订单日期","订单版本","发货仓库","联系人","联系方式","收货地址"];
export function warehouseSheets(snapshot,{mode,orderId,version,month,language="zh",exportedAt=""}){
  if(['confirmation','instruction'].includes(mode))return workflowDocumentSheets(snapshot,{mode,orderId,version,exportedAt});
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

// Customer confirmation is never a warehouse authorization. Official instructions
// retain their issuance snapshot, and exporting rechecks current fulfillment gates.
export function workflowDocumentSheets(snapshot,{mode,orderId,version,exportedAt=''}){
 const o=snapshot.orders.find(o=>o.id===orderId);if(!o)throw new WholesaleError(404,'订单不存在或不在本人范围内');
 if(Number(version)!==Number(o.version))throw new WholesaleError(409,'订单已变化，请刷新后导出');
 const w=o.workflow,official=mode==='instruction';
 if(!w||o.workflow_version!==2)throw new WholesaleError(409,'旧单请使用原备货和实际出库单据');
 if(!['approved','packing','partial','completed','closed'].includes(o.status))throw new WholesaleError(409,'订单尚未审核或已经取消');
 if(official&&(!w.releaseInstruction||w.releaseReason))throw new WholesaleError(409,w.releaseReason||'尚未生成正式出库指令');
 const title=official?'正式出库指令 / Instruksi pengeluaran resmi':'客户确认及付款单 / Konfirmasi pesanan dan pembayaran';
 const note=official?'仅授权按本单未发余量办理；仓库须复核最新状态、上传打包照片及实际运单，系统登记发货才扣库存。 / Periksa status terbaru, foto kemasan dan resi sebelum pengiriman.':'用于核对商品、价格及结算约定，不是出库指令；付款截图不代表财务实际到账。 / Bukan izin pengiriman. Bukti transfer belum berarti dana telah dikonfirmasi.';
 const label={prepaid:'现款 / Tunai sebelum kirim',credit:'账期 / Kredit',consignment:'寄卖 / Konsinyasi'};
 return [{name:official?'正式出库指令':'客户确认付款单',title,headers:['项目 / Informasi','内容 / Rincian'],rows:[['单据类型 / Jenis dokumen',title],['用途说明 / Penggunaan',note],['订单号 / Nomor pesanan',o.order_no],['正式指令 / Instruksi',official?w.releaseInstruction.no:'不适用 / Tidak berlaku'],['客户 / Pelanggan',o.customer.name],['公司简称 / Nama singkat',o.customer.company_short_name||'未维护 / Belum diisi'],['客户编号 / Kode pelanggan',o.customer.code],['金额 / Jumlah IDR',o.total_amount],['结算方式 / Pembayaran',label[w.mode]],['合同依据 / Referensi kontrak',w.contractReference],['到期日期 / Jatuh tempo',o.due_date||'先款后货 / Sebelum kirim'],['锁库截止 / Reservasi sampai',w.reservationExpiresAt],['客户确认时间 / Konfirmasi pelanggan',w.customerConfirmedAt||'待确认 / Menunggu'],['当前财务净到账 / Dana terkonfirmasi',o.paid],['物流协调人账号 / Koordinator',o.logistics_user_id||''],['仓库执行人账号 / Petugas gudang',o.warehouse_user_id||''],['发货仓库 / Gudang',w.warehouse],['生成时间 / Dibuat',official?w.releaseInstruction.issuedAt:exportedAt],['当前订单版本 / Versi',o.version]],note},
 {name:'商品明细 Produk',headers:['SKU','商品 / Produk','订单件数 / Dipesan','已发件数 / Dikirim','未发件数 / Sisa','单价 IDR / Harga','金额 IDR / Jumlah'],rows:o.items.map(i=>[i.sku,i.name,i.qty,i.shipped_qty,Math.max(0,i.qty-i.shipped_qty),i.unit_price,i.amount]),note}];
}
