import test from 'node:test';
import assert from 'node:assert/strict';
import {costFixture,seedSale,importRows,review,orderPayload} from './cost-fixture.mjs';
import {readCostProfit,mutateCost} from '../lib/cost-profit.mjs';
import {loadForecast} from '../lib/forecast.ts';

test('成本首屏分页不改变全量贡献与缺口总数，结算候选按当天站点渠道读取',async t=>{
 const f=costFixture();t.after(()=>f.sqlite.close());
 const {ids}=await importRows(f);await review(f,ids[0]);seedSale(f);await mutateCost(f.db,f.users.finance,orderPayload());
 for(let i=0;i<105;i++)seedSale(f,{id:'gap-'+String(i).padStart(3,'0'),qty:2,sku:'GAP-'+i,businessDate:i<60?'2026-10-20':'2026-10-21'});
 seedSale(f,{id:'other-site',site:'马来西亚',qty:7});
 const full=await readCostProfit(f.db,f.users.admin),compact=await readCostProfit(f.db,f.users.admin,{compact:'1'});
 for(const k of ['totals','unified','orders','skuRows','tickets'])assert.deepEqual(compact[k],full[k]);
 assert.equal(compact.uncoveredSummary.qty,full.uncovered.reduce((sum,r)=>sum+r.uncoveredQty,0));assert.equal(compact.uncoveredSummary.count,106);assert.equal(compact.uncovered.length,50);
 assert.deepEqual(compact.sales,[]);assert.deepEqual(compact.matchCandidates,[]);
 const pages=[compact];for(const gapPage of ['1','2'])pages.push(await readCostProfit(f.db,f.users.admin,{compact:'1',gapPage}));
 assert.deepEqual(pages.flatMap(p=>p.uncovered.map(r=>r.id)).sort(),full.uncovered.map(r=>r.id).sort());
 const selection={compact:'1',sources:'1',sourceSite:'印尼',sourceChannel:'TikTok',sourceDate:'2026-10-20'};
 const scope=await readCostProfit(f.db,f.users.admin,selection);
 assert.equal(scope.sales.length,61);assert.ok(scope.matchCandidates.every(s=>s.business_date==='2026-10-20'&&s.site==='印尼'&&s.channel==='TikTok'));
 assert.deepEqual(scope.sales,full.sales.filter(s=>s.site==='印尼'&&s.channel==='TikTok'&&s.business_date==='2026-10-20'));
 const op=await readCostProfit(f.db,f.users.indonesia,{...selection,sourceSite:'马来西亚'});assert.deepEqual(op.sales,[]);assert.deepEqual(op.matchCandidates,[]);
 const filtered=await readCostProfit(f.db,f.users.admin,{compact:'1',sku:'MISSING'});assert.equal(filtered.uncoveredSummary.count,0);
 await assert.rejects(readCostProfit(f.db,f.users.admin,{compact:'1',gapPage:'-1'}));
 await assert.rejects(readCostProfit(f.db,f.users.admin,{...selection,sourceDate:'2026-02-30'}));
});

test('预测日报覆盖批量检查保留同日多批次、已冲销、零量和站点隔离规则',async t=>{
 const f=costFixture();t.after(()=>f.sqlite.close());
 f.sqlite.exec('DROP TRIGGER sales_summary_overlap_insert; DROP TRIGGER sales_summary_overlap_update'); // Existing legacy overlaps must stay incomplete.
 const insert=f.sqlite.prepare("INSERT INTO sales_imports(id,import_key,business_date,site,channel,row_count,total_qty,actor_id,created_at,report_kind) VALUES(?,?,?,'印尼','TikTok',1,2,?,?,'complete')");
 for(let n=1;n<=7;n++){const day='2026-10-'+(20+n),id='day'+n;insert.run(id,id,day,f.users.indonesia.id,day);seedSale(f,{id,qty:2,businessDate:day});}
 seedSale(f,{id:'overlap-a',qty:2,businessDate:'2026-10-22'});seedSale(f,{id:'overlap-b',qty:2,sku:'BAG-B',businessDate:'2026-10-22'});
 seedSale(f,{id:'zero',qty:0,businessDate:'2026-10-23'});seedSale(f,{id:'reversed',qty:2,businessDate:'2026-10-24'});f.sqlite.exec("UPDATE sales_records SET reversed_at='2026-10-25' WHERE id='reversed'");
 seedSale(f,{id:'other',qty:2,businessDate:'2026-10-25',site:'马来西亚'});
 const all=await loadForecast(f.db,f.users.admin,'2026-10-28'),own=await loadForecast(f.db,f.users.indonesia,'2026-10-28');
 const row=all.suggestions.find(r=>r.site==='印尼'&&r.channel==='TikTok'&&r.sku==='BAG-A');
 assert.deepEqual(own.suggestions.find(r=>r.sku==='BAG-A'),row);assert.equal(row.dataDays,6);
 assert.equal(row.dailySeries.find(d=>d.date==='2026-10-22').complete,false);
 for(const day of ['2026-10-23','2026-10-24','2026-10-25'])assert.equal(row.dailySeries.find(d=>d.date===day).complete,true);
});
