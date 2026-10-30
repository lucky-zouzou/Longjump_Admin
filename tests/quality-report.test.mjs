import test from 'node:test';
import assert from 'node:assert/strict';
import {qualityMonthlyReport} from '../lib/quality-report.mjs';
test('月度追偿按已定责工厂及币种汇总，未知和草稿不计入，证据保持原记录关联',()=>{
 const row=(id,currency,qty,status='confirmed')=>({id,record_kind:'after_sale',status,business_date:'2026-10-01',data:{qty,currency,reason:'商品质量问题',factory:'线索厂',responsibility:'工厂',liableName:'实际责任厂',refundCents:900,claimCents:1000,payments:[{amountCents:200}]}});
 const report=qualityMonthlyReport([row('1','CNY',2),row('2','IDR',5),row('3','CNY',30,'draft'),{...row('4','CNY',1),data:{qty:1,currency:'CNY',reason:'标签错误',factory:'线索厂',payments:[]}}],[{id:'file',record_id:'1',name:'proof.png'},{id:'hidden',record_id:'3'}],'https://example.com');
 const claims=report.sheets.find(s=>s.name==='工厂追偿汇总').rows;assert.equal(claims.length,3);assert.deepEqual(claims[1],['实际责任厂','CNY',1,2,10,2,8]);
 assert.equal(report.ranking[0].qty,7);assert.equal(report.sheets.find(s=>s.name==='证据索引').rows.length,2);assert.equal(report.sheets.find(s=>s.name==='全部追溯明细').rows.length,4);
});
