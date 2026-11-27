// Extend only the existing synthetic preview. Never reads production data or secrets.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {openDatabase} from '../server/storage.mjs';
import {mutateMarketingSample} from '../lib/marketing-samples.mjs';
const root=resolve('work/bd-sample-entry-preview');
if(JSON.parse(readFileSync(root+'/fixture.json','utf8')).source!=='SYNTHETIC_ONLY_BD_SAMPLE_ENTRY')throw Error('Synthetic marker required');
const db=openDatabase(root+'/business.sqlite'),sql=db.sqlite,now=new Date().toISOString();
try{
 if(!sql.prepare("SELECT id FROM users WHERE id='sample-bd' AND email='sample-bd@example.test'").get())throw Error('Synthetic account required');
 sql.prepare("INSERT OR IGNORE INTO creator_scopes(id,site,platform,shop,operator_id,bd_id,updated_at) VALUES('sample-scope-b','印尼','TikTok','TEST B','id-ops','sample-bd',?)").run(now);
 const order=sql.prepare("SELECT * FROM marketing_sample_orders WHERE party_type='mcn' AND json_extract(mcn_json,'$.cooperationRef')='UI-MCN-1'").get();
 if(!order)throw Error('Expected previous MCN synthetic application');
 const actor=id=>sql.prepare('SELECT * FROM users WHERE id=?').get(id);
 const act=(who,action,p={})=>mutateMarketingSample(db,actor(who),{orderId:order.id,version:sql.prepare('SELECT version FROM marketing_sample_orders WHERE id=?').get(order.id).version,action,operationId:crypto.randomUUID(),...p});
 if(order.status==='approved')await act('supply-1','assign',{warehouseId:'sample-wh',warehouseUserId:'supply-2',reason:'TEST ONLY allocation preview'});
 const state=sql.prepare('SELECT status FROM marketing_sample_orders WHERE id=?').get(order.id).status;
 if(state==='assigned')await act('supply-2','ship',{shippedAt:new Date().toISOString(),carrier:'TEST CARRIER',trackingNo:'TEST ALLOCATION',items:sql.prepare('SELECT id,qty FROM marketing_sample_items WHERE order_id=?').all(order.id).map(i=>({itemId:i.id,qty:i.qty})),photos:[{name:'TEST.png',base64:Buffer.from('\x89PNG\r\n\x1a\nTEST','binary').toString('base64')}]});
 const shipment=sql.prepare('SELECT * FROM marketing_sample_shipments WHERE order_id=?').get(order.id);
 for(const kind of ['sample','freight'])if(!sql.prepare('SELECT id FROM marketing_sample_costs WHERE shipment_id=? AND kind=?').get(shipment.id,kind))await act('finance-1','cost',{shipmentId:shipment.id,kind,revision:0,businessDate:shipment.business_date,currency:'CNY',items:JSON.parse(shipment.items_json).map(i=>({itemId:i.itemId,unitCost:'2.50'})),amount:'3',sourceRef:'TEST-ALLOCATION-'+kind,evidence:'TEST ONLY synthetic cost proof',reason:'TEST ONLY finance verification'});
 writeFileSync(root+'/sample-import.csv','\ufeffSKU,寄样数量,商品名称\r\nBAG-A,2,TEST A\r\nBAG-B,3,TEST B\r\n');
 writeFileSync(root+'/sample-invalid.csv','\ufeffSKU,寄样数量\r\nBAG-A,2\r\nBAG-B,0\r\n');
 console.log(JSON.stringify({source:'SYNTHETIC_ONLY',order:order.order_no,costs:sql.prepare('SELECT count(*) n FROM marketing_sample_costs WHERE order_id=?').get(order.id).n,stock:sql.prepare("SELECT sku,qty,reserved_qty FROM inventory_balances WHERE site='印尼' AND channel='TikTok'").all()}));
}finally{sql.close();}
