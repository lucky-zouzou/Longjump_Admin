import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as XLSX from "xlsx";
import { translateWholesale,wholesaleMoney,wholesalePreferenceKey,wholesaleLanguage } from "../lib/wholesale-i18n.mjs";
import { WHOLESALE_ID } from "../lib/wholesale-id.mjs";
import { wholesaleExportSheets,toWholesaleWorkbook,orderFinancials,monthlyReconciliation } from "../lib/wholesale-finance.mjs";

const order=()=>({id:"o1",order_no:"ID-WH-0001",business_date:"2026-08-01",customer_id:"c1",customer:{code:"001",name:"Toko Jakarta",contact:"Sari",phone:"081200000",city:"Jakarta",address:"Jl. Mawar 1"},sales_user_id:"sales1",creator_id:"sales1",sales_name:"Tommy",supply_user_id:"supply1",supply_name:"Budi",status:"partial",total_qty:5,total_amount:500000,payment_terms:"credit",invoice_required:1,invoiceStatus:"待开票",paymentStatus:"部分回款",outstanding:400000,paid:100000,invoiced:0,refundDue:0,files:[],items:[{id:"i1",sku:"BAG-01",name:"Tote",qty:5,unit_price:100000,shipped_qty:2,returned_qty:0,allocations:[{id:"a1",channel:"TikTok",qty:3,shipped_qty:2,released_qty:0,returned_qty:0}]}],shipments:[{id:"s1",shipment_no:"S001",business_date:"2026-08-31",warehouse:"Jakarta",carrier:"Courier",tracking_no:"0001",proofs:[],items:[{order_item_id:"i1",qty:2,amount:200000,allocations_json:"[]"}]}],entries:[{id:"e1",kind:"receipt",business_date:"2026-09-02",amount:100000,reference:"000bank",actor_id:"f1",actor_name:"Sari",note:"Payment confirmed"}],returns:[]});

test("语言切换只改变显示格式，保留IDR值及动态SKU；偏好按账号隔离",()=>{
  assert.equal(wholesaleMoney("zh",1250000),"IDR 1,250,000");assert.equal(wholesaleMoney("id",1250000),"IDR 1.250.000");
  assert.equal(translateWholesale("id","库存不足：需要7件，两个平台合计可用3件"),"Stok tidak cukup: diperlukan 7 unit, total tersedia di kedua platform 3 unit");
  assert.equal(translateWholesale("id","款式A发货超过剩余订单量"),"Jumlah pengiriman SKU 款式A melebihi sisa pesanan");
  assert.equal(translateWholesale("id","{0} · 剩余 {1} 件",["款式A",3]),"款式A · Tersisa 3 unit");
  assert.notEqual(wholesalePreferenceKey("sales1"),wholesalePreferenceKey("sales2"));assert.equal(wholesaleLanguage("id"),"id");assert.equal(wholesaleLanguage("unknown"),"zh");
});

test("中印尼Excel所有数值逐格一致，客户姓名SKU备注不被词典改写",()=>{
  const o=order();o.customer.name="财务";o.items[0].name="待退款";o.note="已回款";o.entries[0].note="回款";
  const snapshot={actor:{name:"管理员",role:"财务"},orders:[o]},before=JSON.stringify(snapshot),opts={mode:"all",month:"2026-08",asOfDate:"2026-09-12",exportedAt:"2026-09-12T00:00:00Z"};
  const zh=wholesaleExportSheets(snapshot,opts),id=wholesaleExportSheets(snapshot,{...opts,language:"id"});assert.equal(id.length,7);assert.equal(JSON.stringify(snapshot),before);
  for(let s=0;s<zh.length;s++){assert.equal(id[s].rows.length,zh[s].rows.length);assert.ok(id[s].name.length<=31);assert.ok(!/[\u3400-\u9fff]/.test(id[s].headers.join("")));for(let r=0;r<zh[s].rows.length;r++)for(let c=0;c<zh[s].rows[r].length;c++)if(typeof zh[s].rows[r][c]==="number")assert.equal(id[s].rows[r][c],zh[s].rows[r][c]);}
  const at=header=>id[0].rows[0][zh[0].headers.indexOf(header)];assert.equal(at("客户名称"),"财务");assert.equal(at("电话或WhatsApp"),"081200000");assert.equal(at("备注"),"已回款");assert.equal(at("当前履约状态"),"Dikirim sebagian");assert.equal(at("当前合同回款状态"),"Dibayar sebagian");
  assert.equal(id[6].rows.find((r,index)=>zh[6].rows[index][0]==="导出人员")[1],"管理员");
  const book=XLSX.read(XLSX.write(toWholesaleWorkbook(XLSX,id,"id"),{type:"buffer",bookType:"xlsx"}),{type:"buffer"});assert.equal(book.SheetNames[0],"Semua Pesanan");assert.equal(book.SheetNames.length,7);
  const monthly=wholesaleExportSheets(snapshot,{...opts,mode:"month",language:"id"});assert.equal(monthly[0].name,"Rekonsiliasi Bulanan");assert.equal(monthly[0].rows[0][zh[1].headers.indexOf("期末应收IDR")],200000);
});

// Render the actual TSX components with the real locale context, without a browser or server.
function compileComponent(file,extra="",overrides={}){
  const url=new URL(file,import.meta.url),require=createRequire(url),module={exports:{}};
  const source=readFileSync(url,"utf8")+extra;
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  new Function("require","module","exports",compiled)(name=>overrides[name]??(name==="./wholesale-management-ui"?compileComponent("../app/wholesale-management-ui.tsx","",overrides):require(name)),module,module.exports);
  return module.exports;
}
test("所有线下表单和对账组件使用印尼语渲染，选项值保持业务编码",()=>{
  const locale=compileComponent("../app/wholesale-language.tsx"),ui=compileComponent("../app/wholesale.tsx","\nexport {CustomerForm,CreateOrder,OrderDetail,ShipmentForm,FinanceForm,ReturnForm,FinanceReconciliation,Dashboard};",{"./wholesale-language":locale});
  const o=order();o.financial=orderFinancials(o);const data={actor:{id:"admin1",role:"管理员"},customers:[{...o.customer,id:"c1",sales_user_id:"sales1"}],users:[{id:"supply1",role:"供应链",name:"Budi"}],skus:[{sku:"BAG-01",name:"Tote"}],stock:[]};
  const common={data,order:o,busy:false,mutate:async()=>true,done:()=>{},close:()=>{},newCustomer:()=>{},refresh:async()=>{},notice:()=>{}},report=monthlyReconciliation([o],"2026-08","2026-09-12");
  const render=(Component,props,language="id")=>renderToStaticMarkup(React.createElement(locale.WholesaleLanguageContext.Provider,{value:{language,setLanguage:()=>{}}},React.createElement(Component,props)));
  for(const name of ["CustomerForm","CreateOrder","OrderDetail","ShipmentForm","FinanceForm","ReturnForm"]){const html=render(ui[name],common);assert.ok(!/[\u3400-\u9fff]/.test(html),`${name} still contains Chinese UI text`);}
  assert.ok(!/[\u3400-\u9fff]/.test(render(ui.FinanceReconciliation,{report,exporting:false,download:()=>{}})));
  const form=render(ui.CreateOrder,common);assert.ok(form.includes('value="prepaid"'));assert.ok(form.includes('value="credit"'));assert.ok(form.includes('value="false"'));assert.ok(form.includes("Bayar sebelum pengiriman"));assert.ok(render(ui.CreateOrder,common,"zh").includes("先款后货"));
});

test("所有显式界面翻译键都有印尼语文案",()=>{
  for(const file of ["../app/wholesale.tsx","../app/control-tower.tsx","../app/wholesale-management-ui.tsx"]){const source=ts.createSourceFile(file,readFileSync(new URL(file,import.meta.url),"utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    const walk=node=>{if(ts.isCallExpression(node)&&["t","shellT"].includes(node.expression.getText(source))&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0]))assert.ok(Object.hasOwn(WHOLESALE_ID,node.arguments[0].text),node.arguments[0].text);ts.forEachChild(node,walk);};walk(source);
  }
});
