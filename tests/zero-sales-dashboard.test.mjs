import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {fixture} from './fixtures.mjs';
import {localDay,shiftDay,zeroSalesSites,evaluateZeroSales} from '../lib/promotion-model.mjs';
import {readPromotions,zeroSales,mutatePromotion,refreshPromotions,promotionRecord} from '../lib/promotions.mjs';
import {matchesZeroSales,summarizeZeroSales} from '../lib/zero-sales-dashboard.mjs';
const now=new Date('2026-10-20T16:30:00Z'); // +8 sites have crossed midnight; +7 sites have not.
const cutoff=site=>shiftDay(localDay(now,site),-1);
const dates=(site,n=7)=>Array.from({length:n},(_,i)=>shiftDay(cutoff(site),-i));
function reports(f,site,channel,ds=dates(site)){for(const d of ds){const id=crypto.randomUUID();f.sqlite.prepare('INSERT INTO sales_imports(id,import_key,business_date,site,channel,row_count,total_qty,actor_id,created_at,report_kind) VALUES(?,?,?,?,?,0,0,?,?,?)').run(id,id,d,site,channel,f.users.admin.id,now.toISOString(),'complete');}}
function sale(f,site,channel,date,qty){f.sqlite.prepare('INSERT INTO sales_records(id,import_id,business_date,site,channel,sku,qty,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),'external',date,site,channel,'BAG-A',qty,f.users.admin.id,now.toISOString());}
const scope=(site,channel='TikTok')=>({site,channel,start:dates(site)[6],cutoff:cutoff(site),coverage:7,missing:[],owners:[]});
const alert=(p={})=>({site:'印尼',channel:'TikTok',sku:'A',available:10,recent:0,coverage:7,status:'open',zeroDays:7,owners:[],...p});
test('五站当地完整自然日窗口不同，今日销售不污染昨天窗口',async()=>{
 assert.equal(localDay(now,'菲律宾'),'2026-10-21');assert.equal(localDay(now,'印尼'),'2026-10-20');
 const f=fixture();for(const site of zeroSalesSites){f.stock('BAG-A',100,100,site);reports(f,site,'TikTok');sale(f,site,'TikTok','2026-10-20',5);}
 const data=await readPromotions(f.db,f.users.admin,now);assert.equal(data.dashboard.sites.length,5);assert.equal(data.dashboard.channels.length,10);
 for(const c of data.dashboard.channels){assert.ok(Array.isArray(c.missingDates));assert.equal(c.missingDates.length,7-c.coverage);assert.equal(typeof c.missing,'number');}
 for(const r of data.alerts.filter(r=>r.sku==='BAG-A'&&r.channel==='TikTok')){assert.equal(r.cutoff,cutoff(r.site));assert.equal(r.coverage,7);assert.equal(r.recent,['马来西亚','菲律宾'].includes(r.site)?5:0);}
 assert.equal(data.dashboard.total.zero,4); // ID includes the second in-stock BAG-B.
 f.sqlite.close();
});
test('相同SKU跨站渠道分别统计、全局商品去重；扣预留且排除缺货',()=>{
 const scopes=[scope('印尼'),scope('印尼','Shopee'),scope('马来西亚')];
 const rows=[alert(),alert({channel:'Shopee',available:20}),alert({site:'马来西亚',available:30,sku:'B'}),alert({sku:'C',available:0}),alert({site:'泰国',available:999})];
 const d=summarizeZeroSales(rows,scopes);assert.equal(d.total.zero,3);assert.equal(d.total.uniqueSkus,2);assert.equal(d.total.zeroUnits,60);assert.equal(d.sites[0].zero,2);assert.equal(d.top[0].site,'马来西亚');assert.equal(d.total.zeroRate,1);
});
test('缺报不算零销量；已售出不能被退货抵消；分母只含完整日报',()=>{
 const rows=[alert(),alert({sku:'B',coverage:6,status:'observe',zeroDays:0}),alert({sku:'C',recent:2,status:'closed'}),alert({sku:'D',status:'observe',zeroDays:0})],d=summarizeZeroSales(rows,[scope('印尼')]);
 assert.equal(d.total.zero,2);assert.equal(d.total.confirmed,1);assert.equal(d.total.availability,1);assert.equal(d.total.missing,1);assert.equal(d.total.zeroRate,2/3);assert.equal(d.total.assessed,3);
 assert.equal(matchesZeroSales(rows[1],'reported_zero'),false);assert.equal(matchesZeroSales(rows[1],'missing'),true);assert.equal(matchesZeroSales(rows[3],'availability'),true);assert.equal(matchesZeroSales(rows[2],'selling'),true);
 const unknown=summarizeZeroSales([rows[1]],[scope('印尼')]);assert.equal(unknown.total.zeroRate,null);assert.equal(unknown.total.assessed,0);
});
test('分层互斥、30天封顶展示；排行以库存排序并保留作用域',()=>{
 const r=Array.from({length:12},(_,i)=>alert({sku:'SKU'+i,zeroDays:[7,13,14,29,30][i%5],available:i+1})),d=summarizeZeroSales(r,[scope('印尼')]);
 assert.equal(d.total.tiers.reduce((n,t)=>n+t.count,0),12);assert.equal(d.top.length,10);assert.equal(d.top[0].available,12);assert.equal(d.top.at(-1).available,3);
});
test('五站运营仅看本站渠道，管理员财务供应链及主管汇总；工厂不扩权',async()=>{
 const f=fixture();for(const site of zeroSalesSites){f.stock('BAG-A',50,50,site);reports(f,site,'TikTok');const a={...f.users.malaysia,site};const d=await readPromotions(f.db,a,now);assert.ok(d.alerts.every(r=>r.site===site&&r.channel==='TikTok'));assert.equal(d.dashboard.sites.length,1);assert.equal(d.dashboard.channels.length,1);assert.equal(d.canApply,site==='印尼');assert.equal(d.canVerify,true);}
 for(const a of [f.users.admin,f.users.finance,f.users.supply,{id:'lead',role:'运营主管'}])assert.equal((await readPromotions(f.db,a,now)).dashboard.sites.length,5);
 for(const a of [{role:'工厂'},{role:'海运'},{role:'销售'},{role:'运营',site:'美国',channel:'TikTok'}])await assert.rejects(readPromotions(f.db,a,now),e=>e.status===403);
 f.sqlite.close();
});
test('全站核验使用所属时区、仅修改本人站点；非印尼不能创建IDR优惠',async()=>{
 const f=fixture(),p={action:'verify',sku:'BAG-A',listedSince:'2026-10-01',availableSince:'2026-10-01',confirmed:true,note:'核对当地库存与在售',reference:'平台库存记录'};
 await mutatePromotion(f.db,f.users.malaysia,p,now);assert.equal(f.sqlite.prepare("SELECT verified_through FROM promotion_availability WHERE site='马来西亚'").get().verified_through,'2026-10-20');assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM promotion_availability WHERE site='印尼'").get().n,0);
 await mutatePromotion(f.db,f.users.malaysia,{action:'measure',sku:'BAG-A',note:'本地链接与主图优化'},now);const d=await readPromotions(f.db,f.users.indonesia,now);assert.equal(d.measures.length,0);
 await assert.rejects(mutatePromotion(f.db,f.users.malaysia,{action:'create'},now),/仅印尼/);await assert.rejects(mutatePromotion(f.db,{id:'lead',role:'运营主管'},p,now),/仅本站/);f.sqlite.close();
});
test('主管只读看板不能获取印尼优惠、费用或附件；供应链继续金额隔离',async()=>{
 const f=fixture();f.sqlite.prepare("INSERT INTO promotions(id,site,channel,sku,owner_id,owner_name,status,data_json,created_at,updated_at) VALUES('p','印尼','TikTok','BAG-A',?,'运营','approved',?,'x','x')").run(f.users.indonesia.id,JSON.stringify({price:12345,costs:{ad:100},start:'2026-10-20',end:'2026-10-30',qty:5}));
 const lead={id:'lead',role:'运营主管'},d=await readPromotions(f.db,lead,now);assert.deepEqual(d.records,[]);assert.deepEqual(d.files,[]);assert.deepEqual(d.measures,[]);await assert.rejects(promotionRecord(f.db,lead,'p'),e=>e.status===404);
 const supply=await readPromotions(f.db,f.users.supply,now);assert.ok(!JSON.stringify(supply).includes('12345'));assert.equal(supply.records[0].data.qty,5);f.sqlite.close();
});
test('观察记录按站点时区新增，不能倒填历史；低库存事实持续保留',async()=>{
 const f=fixture();for(const site of zeroSalesSites)f.stock('BAG-A',10,10,site);
 f.sqlite.exec('DELETE FROM promotion_stock_days');await refreshPromotions(f.db,now);
 for(const site of zeroSalesSites){const r=f.sqlite.prepare('SELECT * FROM promotion_stock_days WHERE site=? AND sku=? AND channel=?').get(site,'BAG-A','TikTok');assert.equal(r.day,localDay(now,site));assert.equal(r.first_at,now.toISOString());}
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM promotion_stock_days WHERE day<?').get('2026-10-20').n,0);
 f.sqlite.prepare("UPDATE promotion_stock_days SET min_available=0 WHERE site='马来西亚'").run();await refreshPromotions(f.db,now);assert.equal(f.sqlite.prepare("SELECT min_available FROM promotion_stock_days WHERE site='马来西亚'").get().min_available,0);f.sqlite.close();
});
test('当地凌晨可售观察阈值使用相同时区，晚观察不当全天有货',()=>{
 const r={stock:{site:'菲律宾',channel:'TikTok',sku:'A',qty:10,reserved_qty:2},sales:[],completeDates:dates('菲律宾'),availability:{listed_since:'2026-01-01',available_since:'2026-01-01',verified_through:'2026-10-19'},observations:[{day:'2026-10-20',min_available:2,first_at:'2026-10-19T16:01:00Z'}]};
 assert.equal(evaluateZeroSales(r,now).status,'open');r.observations[0].first_at='2026-10-19T16:30:00Z';assert.equal(evaluateZeroSales(r,now).status,'observe');
});
test('0023升级保留既有证据，五站库存触发器从迁移日起观察且不改库存',()=>{
 const db=new DatabaseSync(':memory:');for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')&&!f.startsWith('0023')).sort())db.exec(readFileSync('drizzle/'+f,'utf8'));
 db.exec("INSERT INTO promotion_stock_days VALUES('印尼','TikTok','A','2026-09-01',3,'old','old')");db.exec(readFileSync('drizzle/0023_five_site_zero_sales.sql','utf8'));
 assert.equal(db.prepare('SELECT first_at FROM promotion_stock_days').get().first_at,'old');
 for(const site of zeroSalesSites){db.prepare("INSERT INTO inventory_balances(site,channel,sku,qty,reserved_qty,updated_at) VALUES(?,'TikTok','A',10,2,'x')").run(site);db.prepare("UPDATE inventory_balances SET qty=1,reserved_qty=0 WHERE site=?").run(site);db.prepare("UPDATE inventory_balances SET qty=20 WHERE site=?").run(site);const r=db.prepare("SELECT * FROM promotion_stock_days WHERE site=? AND day<>'2026-09-01'").get(site);assert.equal(r.day,localDay(new Date(),site));assert.equal(r.min_available,1);assert.equal(db.prepare('SELECT qty FROM inventory_balances WHERE site=?').get(site).qty,20);}
 db.close();
});
