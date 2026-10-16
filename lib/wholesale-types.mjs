export const SALE_TYPES=Object.freeze({consignment:"寄售",cash:"现金销售",clearance_cash:"特价清仓现金销售"});
export const saleTypeLabel=type=>SALE_TYPES[type]||"历史未分类";
export const productStatus=type=>type==="clearance_cash"?"商品清仓":Object.hasOwn(SALE_TYPES,type)?"正常销售":"历史未分类";
export const cooperationMode=type=>type==="consignment"?"寄售":["cash","clearance_cash"].includes(type)?"现款":"历史未分类";
export const consignmentSold=(sales=[],returns=[],itemId)=>sales.filter(r=>!itemId||r.order_item_id===itemId).reduce((s,r)=>s+Number(r.qty),0)-returns.filter(r=>!itemId||r.order_item_id===itemId).reduce((s,r)=>s+Number(r.consignment_sold_qty||0),0);
