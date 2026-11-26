import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import {wholesaleFollowup,domesticActions} from '../lib/distribution-workflow-view.mjs';
function compile(file){const url=new URL(file,import.meta.url),require=createRequire(url),m={exports:{}};const js=ts.transpileModule(readFileSync(url,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;new Function('require','module','exports',js)(n=>n.endsWith('.css')?{}:n==='./distribution-flow-summary'?compile('../app/distribution-flow-summary.tsx'):require(n),m,m.exports);return m.exports;}
const ui=compile('../app/distribution-order-progress.tsx');
const render=(Component,o,data={actor:{role:'财务'},users:[]},language='zh')=>renderToStaticMarkup(React.createElement(Component,{o,data,language,tr:(zh,id)=>language==='id'?id:zh}));
const order={status:'completed',approved_at:'2026-11-24',items:[{qty:5,shipped_qty:5,returned_qty:0}],workflow:{phase:'completed',mode:'credit',customerConfirmedAt:'2026-11-24',releaseValid:false,releaseInstruction:{no:'ID-TEST-OUT-01'},warehouseUserId:'w'},customerReceipt:{pending:0},outstanding:500000,refundDue:0,due_date:'2099-01-01',consignmentSales:[],returns:[]};
test('received credit remains unpaid; finished shipment no longer appears blocked for release',()=>{
 const html=render(ui.WholesaleProgress,order);assert.match(html,/已交付、待回款/);assert.match(html,/本单发货已完成/);assert.doesNotMatch(html,/尚不可凭单放货|实物与当前结算已完成/);
 const paid=render(ui.WholesaleProgress,{...order,outstanding:0});assert.match(paid,/实物与当前结算已完成/);
 const closed=render(ui.WholesaleProgress,{...order,status:'closed',workflow:{...order.workflow,phase:'closed'},items:[{qty:5,shipped_qty:0,cancelled_qty:5}],outstanding:0});assert.match(closed,/未实际发货/);assert.doesNotMatch(closed,/实物与当前结算已完成/);
 assert.match(render(ui.WholesaleProgress,order,undefined,'id'),/500.000/);
 assert.match(render(ui.WholesaleProgress,{...order,approved_at:null,workflow:{phase:'supply_review'},outstanding:500000}),/待确认结算约定/);
 assert.doesNotMatch(render(ui.WholesaleProgress,order,undefined,'id'),/[\u3400-\u9fff]/);
});
test('consignment unsold stock remains overdue at Jakarta midnight even without receivable',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-25T17:05:00Z')});
 const o={...order,due_date:'2026-11-25',workflow:{...order.workflow,mode:'consignment'},outstanding:0};
 assert.equal(wholesaleFollowup(o).overdue,true);assert.equal(wholesaleFollowup(o).settled,false);
 assert.match(render(ui.WholesaleProgress,o),/已逾期，待跟进/);
 const returned={...o,items:[{qty:5,shipped_qty:5,returned_qty:2}],consignmentSales:[{qty:4}],returns:[{consignment_sold_qty:1}]};assert.equal(wholesaleFollowup(returned).unsold,0);assert.equal(wholesaleFollowup(returned).overdue,false);
});
test('applicants do not receive self-approval shortcuts; factory progress does not infer money',()=>{
 const caps={approve:true,manage:true,execute:true,finance:false},o={status:'contract_pending',creator_id:'own',supply_user_id:'supply',items:[{qty:5}]};
 assert(!domesticActions(o,caps,{id:'own'}).includes('contractDecide'));assert(!domesticActions(o,caps,{id:'supply'}).includes('contractDecide'));assert(domesticActions(o,caps,{id:'other'}).includes('contractDecide'));
 const factory={status:'approved',fulfillment:{total:5,packed:5,shipped:5,received:5},canShip:false};
 const html=render(ui.DomesticProgress,factory,{actor:{role:'工厂'}});assert.doesNotMatch(html,/¥|待回款|当前待收已核销/);assert.match(html,/收款由财务核实/);
 assert.doesNotMatch(render(ui.DomesticProgress,factory,{actor:{role:'工厂'}},'id'),/[\u3400-\u9fff]/);
});
