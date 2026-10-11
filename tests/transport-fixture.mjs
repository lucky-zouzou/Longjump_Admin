import {systemFixture,svc,seedMonthly} from './system-fixture.mjs';
export async function transportFixture(){
 const f=systemFixture(),id=seedMonthly(f),day=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
 await svc.decideApproval(f.users.admin,{approvalId:id,version:1,decision:'approve',comment:'测试运输业务流程'});
 const order=f.sqlite.prepare('SELECT * FROM series_production_orders').get(),item=f.sqlite.prepare('SELECT * FROM series_production_order_items').get();
 f.sqlite.prepare("UPDATE series_production_orders SET status='completed',total_produced_qty=10,qc_status='passed' WHERE id=?").run(order.id);
 f.sqlite.prepare('UPDATE series_production_order_items SET produced_qty=10 WHERE id=?').run(item.id);
 f.sea={id:'sea-1',name:'海运甲',role:'海运'};
 f.sqlite.prepare('INSERT INTO users(id,email,name,role,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(f.sea.id,'sea@example.test',f.sea.name,f.sea.role,day,day);
 f.sqlite.prepare("INSERT INTO business_partners(id,type,code,name,assigned_user_id,created_at,updated_at) VALUES('carrier-1','carrier','TEST-CARRIER','测试承运商',?,?,?)").run(f.sea.id,day,day);
 f.sqlite.prepare("INSERT INTO warehouses(id,site,channel,code,name,created_at,updated_at) VALUES('warehouse-1','印尼','TikTok','W1','测试目的仓',?,?)").run(day,day);
 f.post=async(actor,action,payload={})=>{svc.setActor(actor);const response=await svc.POST(new Request('http://localhost/api/system',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...payload})}));const result=await response.json();return {status:response.status,...result};};
 f.read=async actor=>{svc.setActor(actor);return (await svc.GET(new Request('http://localhost/api/system'))).json();};
 f.createTransport=()=>f.post(f.users.supply,'createTransportBatch',{batchNo:'LOCAL-TRANSPORT',carrierName:'测试承运商',items:[{productionOrderItemId:item.id,shippedQty:10,allocations:[{site:'印尼',channel:'TikTok',warehouseId:'warehouse-1',qty:10}]}]});
 return f;
}
