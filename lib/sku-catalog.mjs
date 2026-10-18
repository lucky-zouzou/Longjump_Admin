import {hasPermission} from './permissions.mjs';
import {assertWritable,atomicBatch} from './atomic.mjs';

import {SkuCatalogError,skuRegistration} from './sku-catalog-model.mjs';
export {SkuCatalogError} from './sku-catalog-model.mjs';

export async function createCatalogSku(db,actor,payload){
  if(!hasPermission(actor.role,'sku.manage'))throw new SkuCatalogError(403,'仅管理员或供应链可新增SKU');
  await assertWritable(db);
  const item=skuRegistration(payload);
  if(await db.prepare('SELECT sku FROM sku_settings WHERE sku=?').bind(item.sku).first())throw new SkuCatalogError(409,`SKU ${item.sku} 已存在，请选择已有SKU维护；本次未覆盖资料`);
  const timestamp=new Date().toISOString();
  try{
    await atomicBatch(db,[
      db.prepare('INSERT INTO sku_settings(sku,name,product_series,product_type,lead_time_days,updated_at) VALUES(?,?,?,?,56,?)').bind(item.sku,item.name,item.productSeries,item.productType,timestamp),
      db.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(`audit_${crypto.randomUUID()}`,'新增SKU档案','sku',item.sku,JSON.stringify({...item,source:payload.source==='inbound'?'到仓入库':'SKU系列与供应参数',inventoryChanged:false}),actor.id,actor.name,timestamp),
    ]);
  }catch(e){
    if(/UNIQUE constraint failed: sku_settings\.sku/i.test(String(e)))throw new SkuCatalogError(409,`SKU ${item.sku} 已被创建，请刷新商品列表；本次未覆盖资料`);
    throw e;
  }
  return {ok:true,sku:await db.prepare('SELECT * FROM sku_settings WHERE sku=?').bind(item.sku).first()};
}
