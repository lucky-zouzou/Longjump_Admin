import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync,readFileSync } from "node:fs";
import { allocateAverage,canWholesale,indonesiaDate,mutateWholesale,readWholesale,wholesaleTasks,wholesaleSalesSummary } from "../lib/wholesale.mjs";
import { countStatements,reversalStatements } from "../lib/inventory-guard.mjs";
import { loadWholesaleExportSnapshot } from "../lib/wholesale-export.mjs";
import { wholesaleExportSheets } from "../lib/wholesale-finance.mjs";

export function fixture(){
  const sqlite=new DatabaseSync(":memory:");sqlite.exec("PRAGMA foreign_keys=ON");
  for(const file of readdirSync(new URL("../drizzle/",import.meta.url)).filter(f=>f.endsWith(".sql")).sort())sqlite.exec(readFileSync(new URL(`../drizzle/${file}`,import.meta.url),"utf8"));
  class Statement{constructor(sql,args=[]){this.sql=sql;this.args=args;}bind(...args){return new Statement(this.sql,args);}async first(){return sqlite.prepare(this.sql).get(...this.args)??null;}async all(){return {results:sqlite.prepare(this.sql).all(...this.args),success:true,meta:{}};}async run(){const r=sqlite.prepare(this.sql).run(...this.args);return {success:true,meta:{changes:Number(r.changes)}};}}
  const db={prepare:sql=>new Statement(sql),batch:async statements=>{sqlite.exec("BEGIN IMMEDIATE");try{const result=[];for(const s of statements)result.push(await (/^\s*SELECT/i.test(s.sql)?s.all():s.run()));sqlite.exec("COMMIT");return result;}catch(error){sqlite.exec("ROLLBACK");throw error;}}};
  const users={sales:{id:"sales-1",role:"销售",name:"印尼销售甲",site:"印尼"},sales2:{id:"sales-2",role:"销售",name:"印尼销售乙",site:"印尼"},admin:{id:"admin-1",role:"管理员",name:"管理员"},supply:{id:"supply-1",role:"供应链",name:"供应链甲"},supply2:{id:"supply-2",role:"供应链",name:"供应链乙"},finance:{id:"finance-1",role:"财务",name:"财务"},malaysia:{id:"my-ops",role:"运营",name:"马来运营",site:"马来西亚",channel:"TikTok"},indonesia:{id:"id-ops",role:"运营",name:"印尼运营",site:"印尼",channel:"TikTok"}};
  for(const u of Object.values(users))sqlite.prepare("INSERT INTO users (id,email,name,role,site,channel,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(u.id,`${u.id}@example.test`,u.name,u.role,u.site??null,u.channel??null,"2026-01-01","2026-01-01");
  for(const sku of ["BAG-A","BAG-B"])sqlite.prepare("INSERT INTO sku_settings (sku,name,updated_at) VALUES (?,?,?)").run(sku,sku,"2026-01-01");
  const stock=(sku,a,b,site="印尼")=>{for(const [ch,n] of [["TikTok",a],["Shopee",b]])sqlite.prepare("INSERT INTO inventory_balances (site,channel,sku,qty,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(site,channel,sku) DO UPDATE SET qty=excluded.qty").run(site,ch,sku,n,"2026-01-01");};
  stock("BAG-A",10,10);stock("BAG-B",10,10);stock("BAG-A",77,88,"马来西亚");
  const call=(actor,action,payload={})=>mutateWholesale(db,actor,{action,...payload,operationId:crypto.randomUUID()});
  const orderRow=id=>sqlite.prepare("SELECT * FROM wholesale_orders WHERE id=?").get(id);
  const change=(actor,id,action,payload={})=>call(actor,action,{orderId:id,version:orderRow(id).version,...payload});
  const create=async({qty=5,terms="credit",who=users.sales,items,invoice=true,businessDate="2026-08-01"}={})=>{
    const c=await call(who,"customerCreate",{name:`测试客户-${crypto.randomUUID()}`,contact:"联系人",phone:"081200000",city:"Jakarta",address:"Test warehouse 1",salesUserId:who.id});
    return (await call(who,"orderCreate",{customerId:c.id,site:"印尼",businessDate,paymentTerms:terms,dueDate:"2027-01-01",invoiceRequired:invoice,items:items??[{sku:"BAG-A",qty,unitPrice:100000}]})).id;
  };
  const approve=id=>change(users.admin,id,"orderApprove",{supplyUserId:users.supply.id,stockBasisConfirmed:true,reason:"已核对客户账期和独立库存"});
  const ship=(id,qty,date=indonesiaDate(),extra={})=>change(users.supply,id,"orderShip",{items:[{itemId:sqlite.prepare("SELECT id FROM wholesale_order_items WHERE order_id=?").get(id).id,qty}],businessDate:date,carrier:"测试承运商",warehouse:"印尼仓",trackingNo:"TEST-TRACK",handoverConfirmed:true,...extra});
  return {sqlite,db,users,stock,call,change,orderRow,create,approve,ship};
}
