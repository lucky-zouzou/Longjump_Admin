import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
function compile(file,extra='',overrides={}){const url=new URL(file,import.meta.url),require=createRequire(url),m={exports:{}};const js=ts.transpileModule(readFileSync(url,'utf8')+extra,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;new Function('require','module','exports',js)(n=>n.endsWith('.css')?{}:overrides[n]??(['./distribution-order-progress','./distribution-flow-summary','./marketing-sample-preparation','./marketing-sample-mcn','./marketing-sample-items-import','./table-import','./sku-label'].includes(n)?compile('../app/'+n.slice(2)+'.tsx','',overrides):require(n)),m,m.exports);return m.exports;}
const locale=compile('../app/wholesale-language.tsx'),ui=compile('../app/marketing-samples.tsx','\nexport {SampleCreate,SampleDetail,SampleAction};',{'./wholesale-language':locale,'./workspace-hooks':{useDirtyGuard:()=>()=>true}});
const render=(Component,props,language='id')=>renderToStaticMarkup(React.createElement(locale.WholesaleLanguageContext.Provider,{value:{language,setLanguage:()=>{}}},React.createElement(Component,props)));
const actor={id:'bd',role:'达人BD',name:'Sari'},o={id:'s1',version:1,order_no:'ID-ABC123',roundNo:'BD-R1',creatorName:'Sari',shop:'Jakarta',status:'assigned',agreement_ref:'AGREEMENT-1',signed_on:'2026-11-24',recipient:{name:'Sari',phone:'0812',city:'Jakarta',address:'Jalan Mawar 1'},items:[{id:'i1',sku:'BAG-A',qty:4,shipped_qty:0,released_qty:0}],shipments:[],capabilities:{review:true,assign:true,ship:true,cancel:true,cost:true},events:[]};
const data={actor,serverTime:'2026-11-24T01:00:00Z',canFinance:true,staff:[{id:'supply',name:'Budi'},{id:'wh',name:'Rani'}],warehouses:[{id:'wh1',name:'Jakarta TikTok'}],rounds:[{id:'r1',round_no:'BD-R1',creatorName:'Sari',terms:{items:[{sku:'BAG-A',sampleQty:4}]}}]};
const shipment={id:'s2',costKind:'sample',items:[{itemId:'i1',sku:'BAG-A',qty:4}],costs:[]};
test('actual sample forms and action states render Indonesian without Chinese system copy',()=>{
 const common={o,data,busy:false,act:async()=>true,close:()=>{}};
 for(const mode of ['review','assign','ship','receipt','cancel','cost']){const html=render(ui.SampleAction,{...common,mode,target:shipment});assert.doesNotMatch(html,/[\u3400-\u9fff]/,mode);assert.match(html,/Simpan/);}
 assert.doesNotMatch(render(ui.SampleAction,{...common,mode:'cost',target:{...shipment,costKind:'freight'}}),/[\u3400-\u9fff]/);
 assert.doesNotMatch(render(ui.SampleCreate,common),/[\u3400-\u9fff]/);assert.doesNotMatch(render(ui.SampleDetail,common),/[\u3400-\u9fff]/);
 assert.match(render(ui.SampleDetail,common,'zh'),/实际收件人/);
});
test('sample UI only offers finance cost controls and assigned actions supplied by the server',()=>{
 const hidden={...o,capabilities:{},shipments:[{...shipment,shipment_no:'ID-ABC123-S-001',business_date:'2026-11-24',carrier:'Lalamove',tracking_no:'LALA-1',warehouse_name:'Jakarta',files:[],receipt:null}]};
 const html=render(ui.SampleDetail,{o:hidden,data:{...data,canFinance:false},busy:false,act:async()=>true});assert.doesNotMatch(html,/Verifikasi biaya sampel|Verifikasi ongkos kirim|Tugaskan gudang|Konfirmasi penerimaan/);assert.match(html,/Menunggu konfirmasi BD/);
});

test('empty sample entry offers scoped next steps in Chinese and Indonesian, with no hidden submit form',()=>{
 const application={scopeCount:1,profiles:[{creatorId:'c1',creatorName:'TEST CREATOR',shop:'TEST SHOP'}],pending:[{key:'request:q1',requestId:'q1',creatorId:'c1',creatorName:'TEST CREATOR',shop:'TEST SHOP',reason:'confirm'}],blocked:[{key:'round:r1',roundId:'r1',creatorId:'c1',creatorName:'TEST CREATOR',shop:'TEST SHOP',reason:'dispatched'}]};
 const props={data:{...data,rounds:[],application},busy:false,act:async()=>true,close:()=>{}};
 const zh=render(ui.SampleCreate,props,'zh');assert.match(zh,/新建达人档案/);assert.match(zh,/去确认合作条件/);assert.match(zh,/历史已寄出/);assert.match(zh,/sample-request%3Aq1/);assert.doesNotMatch(zh,/<form/);
 const id=render(ui.SampleCreate,props);assert.doesNotMatch(id,/[\u3400-\u9fff]/);assert.match(id,/Konfirmasi ketentuan/);
 const unassigned=render(ui.SampleCreate,{...props,data:{...props.data,application:{scopeCount:0,profiles:[],pending:[],blocked:[]}}},'zh');assert.match(unassigned,/店铺分工/);assert.doesNotMatch(unassigned,/href=.*sample%3Anew/);
});
test('a round link preselects the correct application and explains an unavailable round',()=>{
 const props={data,busy:false,act:async()=>true,close:()=>{},initialRound:'r1'};
 assert.match(render(ui.SampleCreate,props,'zh'),/<option value="r1" selected=""/);
 assert.match(render(ui.SampleCreate,{...props,initialRound:'not-allowed'},'zh'),/这轮合作暂不能新增申请/);
});

const mcnUi=compile('../app/marketing-sample-mcn.tsx','',{'./wholesale-language':locale,'./workspace-hooks':{useDirtyGuard:()=>()=>true}});
test('MCN entry requires an institution instead of a creator and translates its complete form',()=>{
 const props={data:{...data,mcnScopes:[{id:'shop1',shop:'TEST SHOP'}],skus:[{sku:'SKU-A',name:'TEST'}]},busy:false,act:async()=>true,close:()=>{}};
 const zh=render(mcnUi.default,props,'zh');assert.match(zh,/MCN 机构名称/);assert.match(zh,/本次合作编号/);assert.match(zh,/机构交付方式/);assert.match(zh,/提交 MCN 寄样申请/);assert.doesNotMatch(zh,/选择合作轮次|选择我负责的达人/);
 assert.doesNotMatch(render(mcnUi.default,props),/[\u3400-\u9fff]/);
 const noScope=render(mcnUi.default,{...props,data:{mcnScopes:[]}},'zh');assert.match(noScope,/店铺分工/);assert.doesNotMatch(noScope,/<form/);
 const order={...o,party_type:'mcn',mcn:{name:'TEST MCN',cooperationRef:'TEST-REF'},content:{requirement:'TEST',dueDate:'2026-12-01'},workKinds:['content'],terms:{},contentStatus:'executing',capabilities:{mcnContent:true}};
 const detail=render(ui.SampleDetail,{...props,o:order});assert.doesNotMatch(detail,/[\u3400-\u9fff]|creators&amp;entity/);assert.match(detail,/Catat penyerahan agensi/);
 assert.doesNotMatch(render(ui.SampleAction,{...props,o:order,mode:'mcnContent',target:null}),/[\u3400-\u9fff]/);
});

const allocationUi=compile('../app/marketing-sample-allocation.tsx','',{'./wholesale-language':locale});
test('finance allocation shows evidence, unknown costs, read-only admin/closed states and bilingual edit form',()=>{
 const value={month:'2026-11',revision:1,cutoff:'2026-11-27',throughDate:'2026-11-27',status:'partial',pendingCostCount:1,issues:[],rows:[{scopeId:'s1',shop:'TEST SHOP',operatorName:'TEST OPS',revenueMinor:30000,revenueCnyMinor:30000,currency:'CNY',share:1,sampleCnyMinor:500,freightCnyMinor:null,totalCnyMinor:null,evidence:'TEST REPORT'}],lines:[]},props={summary:{allocations:{months:[value]}},month:'2026-11',actor:{id:'f1',role:'财务'},closed:false,onSaved:async()=>{}};
 const zh=render(allocationUi.default,props,'zh');assert.match(zh,/核对店铺月销售额/);assert.match(zh,/待核/);assert.match(zh,/TEST REPORT/);assert.doesNotMatch(render(allocationUi.default,{...props,actor:{role:'管理员'}},'zh'),/核对店铺月销售额/);assert.doesNotMatch(render(allocationUi.default,{...props,closed:true},'zh'),/核对店铺月销售额/);assert.doesNotMatch(render(allocationUi.default,props),/[\u3400-\u9fff]/);assert.doesNotMatch(render(allocationUi.RevenueBasisEditor,{value,onSaved:async()=>{},close:()=>{}}),/[\u3400-\u9fff]/);
});
