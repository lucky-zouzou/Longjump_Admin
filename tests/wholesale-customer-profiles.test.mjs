import test from "node:test";
import assert from "node:assert/strict";
import {fixture} from "./fixtures.mjs";
import {indonesiaDate,readWholesale} from "../lib/wholesale.mjs";
import {monthlyReconciliation} from "../lib/wholesale-finance.mjs";
import {customerProfiles,portfolioTotals} from "../lib/wholesale-customer-profiles.mjs";

const customers=["a","b","c"].map(id=>({id,created_at:"2026-01-01"}));
const day=(date,qty)=>({business_date:date,qty,amount:100*qty});
const shipment=(date,qty)=>({business_date:date,items:[day(date,qty)]});
const order=(id,customer_id,sale_type,events)=>({id,customer_id,sale_type,business_date:"2026-09-01",outstanding:0,shipments:[],entries:[],returns:[],consignmentSales:[],...events});
function profile(orders,cutoff="2026-11-06",list=customers) {
  const finance=monthlyReconciliation(orders,cutoff.slice(0,7),cutoff);
  return customerProfiles(list,orders,finance);
}
test("客户贡献按业务日期：跨月退货、寄售未售退回和结算冲正均与月对账一致",()=>{
  const orders=[
    order("1","a","cash",{shipments:[shipment("2026-10-25",4)],returns:[day("2026-11-03",1)],entries:[{...day("2026-11-03",2),kind:"receipt"},{...day("2026-11-05",1),kind:"refund"}]}),
    order("2","b","consignment",{shipments:[shipment("2026-10-28",15)],consignmentSales:[day("2026-11-02",5),day("2026-11-03",-1),day("2026-11-30",4)],returns:[{...day("2026-11-04",3),consignment_sold_qty:1}]}),
    order("3","b","clearance_cash",{shipments:[shipment("2026-11-01",1)]}),
    order("4","c","consignment",{shipments:[shipment("2026-10-01",5)]}),
  ];
  const {rows:[a,b,c],totalSales}=profile(orders);
  assert.equal(totalSales,300);
  assert.deepEqual([a.netSales,a.netSoldQty,a.netReceipts,a.segment,a.lastSale],[-100,-1,100,"first","2026-10-25"]);
  assert.deepEqual([b.netSales,b.netSoldQty,b.segment,b.lastSale],[400,4,"repeat","2026-11-02"]);
  assert.deepEqual([c.netSales,c.netSoldQty,c.segment,c.lastSale],[0,0,"prospect",""]);
  assert.equal(portfolioTotals([a,b,c]).netSoldQty,3);
  assert.equal(profile(orders,"2026-10-31").totalSales,400);
});
test("已全部冲正的成交不构成复购，期后建档单独标记",()=>{
  const orders=[order("1","a","consignment",{consignmentSales:[day("2026-11-03",2),day("2026-11-05",-2)]})];
  const {rows,totalSales}=profile(orders,"2026-11-06",[customers[0],{id:"d",created_at:"2026-11-06T17:30:00Z"}]);
  assert.equal(totalSales,0); assert.equal(rows[0].segment,"prospect"); assert.equal(rows[1].segment,"later");
});
test("地区可由负责销售维护，老表单保存不抹除地区，交接改变画像归属但保留订单原销售",async()=>{
  const f=fixture(),month=indonesiaDate().slice(0,7);
  const a=await f.create(),c=f.orderRow(a).customer_id;
  let customer=f.sqlite.prepare("SELECT * FROM wholesale_customers WHERE id=?").get(c);
  const update={customerId:c,name:customer.name,contact:customer.contact,phone:customer.phone,city:customer.city,address:customer.address,reason:"核实销售片区"};
  await f.call(f.users.sales,"customerUpdate",{...update,version:1,region:"Jawa Barat"});
  await f.call(f.users.sales,"customerUpdate",{...update,version:2});
  await assert.rejects(f.call(f.users.sales2,"customerUpdate",{...update,version:3,region:"Bali"}),{status:403});
  await f.call(f.users.admin,"customerTransfer",{customerId:c,version:3,salesUserId:f.users.sales2.id,reason:"客户重新分配"});
  for(const user of [f.users.admin,f.users.finance,f.users.sales2]){
    const d=await readWholesale(f.db,user,month);
    const {rows}=customerProfiles(d.customers,d.orders,d.finance);
    assert.equal(rows.length,1);
    assert.equal(rows[0].customer.region,"Jawa Barat");
    assert.equal(rows[0].customer.owner_name,f.users.sales2.name);
    assert.equal(d.orders[0].sales_user_id,f.users.sales.id);
  }
  const previous=await readWholesale(f.db,f.users.sales,month);
  assert.equal(customerProfiles(previous.customers,previous.orders,previous.finance).rows.length,0);
});
