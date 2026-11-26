import {fixture} from './fixtures.mjs';
import {mutateMarketingSample as mutate} from '../lib/marketing-samples.mjs';
const now=()=>new Date().toISOString(),day=()=>new Date(Date.now()+7*3600000).toISOString().slice(0,10),ago=()=>new Date(Date.now()-86400000).toISOString();
const photo={name:'package.png',base64:Buffer.from('\x89PNG\r\n\x1a\nTEST','binary').toString('base64')};
export function marketingSamplesFixture(base=fixture()){
 const f={...base,users:{...base.users}},t=ago();f.users.bd={id:'sample-bd',role:'达人BD',name:'负责BD'};f.users.other={id:'sample-other',role:'达人BD',name:'无关BD'};
 for(const u of [f.users.bd,f.users.other])f.sqlite.prepare('INSERT INTO users(id,email,name,role,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(u.id,u.id+'@example.test',u.name,u.role,t,t);
 const existingWarehouse=f.sqlite.prepare("SELECT id FROM warehouses WHERE site='印尼' AND channel='TikTok' AND active=1").get();f.warehouseId=existingWarehouse?.id||'sample-wh';if(!existingWarehouse)f.sqlite.prepare("INSERT INTO warehouses(id,site,channel,code,name,created_at,updated_at) VALUES('sample-wh','印尼','TikTok','SAMPLE','印尼TK样品仓',?,?)").run(t,t);
 f.sqlite.prepare("INSERT INTO creator_scopes(id,site,platform,shop,operator_id,bd_id,updated_at) VALUES('sample-scope','印尼','TikTok','TEST',?,?,?)").run(f.users.indonesia.id,f.users.bd.id,t);
 f.sqlite.prepare("INSERT INTO creator_profiles(id,scope_id,platform_id,name,kind,source_user_id,owner_bd_id,data_json,created_at,updated_at) VALUES('sample-creator','sample-scope','sample-creator','测试达人','video',?,?,'{}',?,?)").run(f.users.indonesia.id,f.users.bd.id,t,t);
 f.round=(id='sample-round',qty=4)=>{const terms={items:[{sku:'BAG-A',sampleQty:qty}],sampleQty:qty,videos:1,lives:0};f.sqlite.prepare("INSERT INTO creator_rounds(id,creator_id,round_no,status,terms_json,original_due_at,effective_due_at,author_id,approved_at,created_at,updated_at) VALUES(?,'sample-creator',?,'executing',?,?,?,?,?,?,?)").run(id,'BD-'+id,JSON.stringify(terms),now(),now(),f.users.bd.id,t,t,t);};f.round();
 f.call=(a,action,p={})=>mutate(f.db,a,{action,operationId:crypto.randomUUID(),...p});f.row=id=>f.sqlite.prepare('SELECT * FROM marketing_sample_orders WHERE id=?').get(id);
 f.change=(a,id,action,p={})=>f.call(a,action,{orderId:id,version:f.row(id).version,...p});
 f.create=(extra={})=>f.call(f.users.bd,'create',{roundId:'sample-round',signedOn:day(),agreementRef:'签署协议A',recipient:{name:'客户',phone:'+628120000',city:'Jakarta',address:'Test address'},...extra});
 f.approve=id=>f.change(f.users.supply,id,'review',{decision:'approve',logisticsUserId:f.users.supply.id,reason:'核对协议清单与库存'});
 f.assign=id=>f.change(f.users.supply,id,'assign',{warehouseId:f.warehouseId,warehouseUserId:f.users.supply2.id,reason:'派定本仓'});
 f.ship=(id,qty=4,extra={})=>f.change(f.users.supply2,id,'ship',{shippedAt:now(),carrier:'Lalamove',trackingNo:'LALA-1',items:[{itemId:f.sqlite.prepare('SELECT id FROM marketing_sample_items WHERE order_id=?').get(id).id,qty}],photos:[photo],...extra});
 f.shipment=id=>f.sqlite.prepare('SELECT * FROM marketing_sample_shipments WHERE order_id=? ORDER BY rowid DESC').get(id);
 f.cost=(id,kind='sample',extra={})=>{const s=f.shipment(id);return f.change(f.users.finance,id,'cost',{shipmentId:s.id,kind,revision:0,businessDate:day(),currency:'CNY',items:JSON.parse(s.items_json).map(i=>({itemId:i.itemId,unitCost:'2.50'})),amount:'3',sourceRef:s.id+'-'+kind,evidence:'实际费用发票',reason:'核对实际发生',...extra});};
 f.stock=()=>f.sqlite.prepare("SELECT qty,reserved_qty FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").get();return f;
}
