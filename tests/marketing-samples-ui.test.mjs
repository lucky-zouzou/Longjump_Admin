import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
function compile(file,extra='',overrides={}){const url=new URL(file,import.meta.url),require=createRequire(url),m={exports:{}};const js=ts.transpileModule(readFileSync(url,'utf8')+extra,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;new Function('require','module','exports',js)(n=>n.endsWith('.css')?{}:overrides[n]??require(n),m,m.exports);return m.exports;}
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
