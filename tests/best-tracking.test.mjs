import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {queryBestTracking, trackingSnapshot, TrackingError} from '../lib/best-tracking-client.mjs';
import {manageBestTracking, readBestTracking, pollBestTracking, previewBestTracking} from '../lib/best-tracking.mjs';
import {transportFixture} from './transport-fixture.mjs';

const config = {BEST_PARTNER_ID:'TEST-ID', BEST_API_SECRET:'test-signature'};
const no = 'TEST-12345';
const trace = {Desc:'已到港',StateType:'Arrived',Date:'2026-11-01T12:00:00+08:00',Estimate:false};
const item = {No:no,StatusName:'运输中',ReceiverCountryCode:'ID',Address:{Receiver:'private-name'},SignedPictures:['private-url'],
  Groups:[{Traces:[trace,trace,{...trace,Desc:'预计派送',Estimate:true},{...trace,Desc:'待确认',Estimate:null}]}]};
const response = (...items) => ({success:true,data:{Items:items}});
const snapshot = trackingSnapshot(response(item),no);

test('百世查询使用固定生产地址、签名原始字节，仅接收匹配单号，预计与未知节点独立',async()=>{
  const safe = await queryBestTracking(config, no.toLowerCase(), async(url,init)=>{
    assert.equal(url,'https://stargate.800best.com/star-gate/bestApi/trackingQuery');
    assert.equal(init.redirect,'error');
    assert.equal(init.body,JSON.stringify({nos:[no]}));
    assert.equal(init.headers.partnerId,config.BEST_PARTNER_ID);
    assert.equal(init.headers.sign,createHash('md5').update(init.body+config.BEST_API_SECRET).digest('hex'));
    return Response.json(response(item,{...item,No:'OTHER'}));
  });
  assert.deepEqual(safe.groups[0].events.map(e=>e.kind),['actual','estimate','unknown']);
  assert.equal(safe.groups[0].events[0].at,'2026-11-01T04:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(safe),/private-name|private-url/);
  assert.throws(()=>trackingSnapshot(response(),no),{status:404});
  assert.throws(()=>trackingSnapshot(response(item,item),no),{status:502});
  await assert.rejects(queryBestTracking({},no),{status:503});
  await assert.rejects(queryBestTracking(config,'https://example.test'),{status:400});
});

async function prepare(t) {
  const f=await transportFixture();
  t.after(()=>f.sqlite.close());
  assert.equal((await f.createTransport()).status,200);
  f.sqlite.prepare("UPDATE transport_batches SET carrier_name='百世集团'").run();
  const leg=f.sqlite.prepare('SELECT * FROM transport_legs').get();
  const action=(actor,params,lookup=async()=>snapshot)=>manageBestTracking(f.db,config,actor,{legId:leg.id,...params},lookup);
  return {...f,leg,action};
}

test('关联必须核对国家和角色，重复提交一条关联，运营只读本站渠道，不改变业务库存',async t=>{
  const f=await prepare(t), {admin,indonesia,malaysia}=f.users;
  const balance=()=>f.sqlite.prepare('SELECT * FROM inventory_balances ORDER BY site,channel,sku').all();
  const before=balance();
  await assert.rejects(f.action(admin,{action:'link',waybill:no},async()=>({...snapshot,country:'PH'})),{status:409});
  await assert.rejects(f.action(indonesia,{action:'link',waybill:no}),{status:403});
  await assert.rejects(readBestTracking(f.db,malaysia,f.leg.id),{status:404});
  await assert.rejects(readBestTracking(f.db,{...f.sea,id:'other'},f.leg.id),{status:404});
  const saved=await f.action(f.sea,{action:'link',waybill:no});
  assert.equal(saved.rows.length,1);
  const duplicate=await f.action(admin,{action:'link',waybill:no},()=>assert.fail('duplicate queried'));
  assert.equal(saved.rows[0].id,duplicate.rows[0].id);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM audit_logs WHERE action='关联百世运单'").get().n,1);
  const ops=await readBestTracking(f.db,indonesia,f.leg.id);
  assert.equal(ops.canManage,false);assert.equal(ops.rows[0].snapshot.status,'运输中');
  assert.deepEqual(balance(),before);
  assert.equal(f.sqlite.prepare('SELECT stage FROM transport_legs').get().stage,f.leg.stage);
});

test('同步超时保留最后有效快照，恢复后清除错误，解除后旧响应不能覆盖新关联',async t=>{
  const f=await prepare(t), admin=f.users.admin;
  const linked=await f.action(admin,{action:'link',waybill:no}),id=linked.rows[0].id;
  const age=()=>f.sqlite.prepare("UPDATE best_transport_tracking SET last_attempt_at='2000-01-01T00:00:00.000Z'").run();
  await f.action(admin,{action:'refresh',id},()=>assert.fail('fresh binding queried'));age();
  await pollBestTracking(f.db,config,async()=>{throw new TrackingError(502,'百世暂不可用');});
  const cached=(await readBestTracking(f.db,admin,f.leg.id)).rows[0];
  assert.equal(cached.updatedAt,linked.rows[0].updatedAt);assert.equal(cached.error,'百世暂不可用');age();
  await pollBestTracking(f.db,config,async()=>({...snapshot,status:'到港'}));
  const updated=(await readBestTracking(f.db,admin,f.leg.id)).rows[0];
  assert.equal(updated.error,'');assert.equal(updated.snapshot.status,'到港');age();
  let resume,started;
  const ready=new Promise(r=>{started=r;});
  const pending=f.action(admin,{action:'refresh',id},async()=>{started();await new Promise(r=>{resume=r;});return {...snapshot,status:'旧结果'};});
  await ready;
  await f.action(admin,{action:'unlink',id});
  const relink=await f.action(admin,{action:'link',waybill:no});
  resume();await pending;
  const latest=(await readBestTracking(f.db,admin,f.leg.id)).rows[0];
  assert.notEqual(latest.id,id);assert.equal(latest.id,relink.rows[0].id);assert.equal(latest.snapshot.status,snapshot.status);
});

test('管理员和供应链可凭单号只读核验，其他岗位不能调用独立查询', async () => {
  for (const role of ['管理员','供应链']) {
    const result=await previewBestTracking(config,{role},no.toLowerCase(),async (received,waybill) => {
      assert.equal(received,config); assert.equal(waybill,no); return snapshot;
    });
    assert.deepEqual(result,{waybill:no,snapshot});
  }
  for (const role of ['运营','海运','工厂']) {
    await assert.rejects(previewBestTracking(config,{role},no,()=>assert.fail('未授权查询')),{status:403});
  }
  await assert.rejects(previewBestTracking(config,{role:'管理员'},'?',()=>assert.fail('未验证编号')),{status:400});
});

const registered='BSPHSTEST000001';
const transitDate='2026-06-05T12:00:00Z';
const arrived={at:transitDate,state:'DestinationArrived',kind:'actual',description:'抵达目的港'};
const dispatched={...arrived,state:'Delivering',at:'2026-06-07T12:00:00Z',description:'开始派送'};
const signed={...dispatched,state:'Signed',at:'2026-06-08T12:00:00Z',description:'承运商已签收'};
const track=(events,country='ID')=>({country,status:'运输中',groups:[{events}]});
const registeredLeg=(f,refs,stage='sea_freight')=>f.sqlite.prepare("UPDATE transport_legs SET evidence_json=?,stage=?,stage_owner='海运',etd='2026-06-01' WHERE id=?")
  .run(JSON.stringify(refs.map(reference=>({stage:'booking',reference}))),stage,f.leg.id);
const legState=f=>f.sqlite.prepare('SELECT * FROM transport_legs WHERE id=?').get(f.leg.id);

test('已登记交接凭证自动识别；实际派送推进仅一次，预计签收独立显示，同步失败或旧轨迹不倒退',async t=>{
 const f=await prepare(t);registeredLeg(f,[registered.toLowerCase()]);
 const balances=f.sqlite.prepare('SELECT * FROM inventory_balances').all();
 const poll=(events)=>pollBestTracking(f.db,config,async(_,num)=>{assert.equal(num,registered);return track(events);});
 await poll([arrived,dispatched,{...signed,kind:'estimate'}]);
 const first=legState(f);
 assert.equal(first.stage,'last_mile_delivery');assert.equal(first.ata,'2026-06-05');assert.equal(first.version,2);
 assert.equal((await readBestTracking(f.db,f.users.admin,f.leg.id)).rows[0].source,'auto');
 assert.equal(JSON.parse(first.evidence_json).at(-1).source,'bestTracking');
 assert.equal(JSON.parse(first.evidence_json).at(-1).nodes[0].state,'Delivering');
 await poll([]);assert.equal(legState(f).version,2);
 f.sqlite.prepare("UPDATE best_transport_tracking SET last_attempt_at='2000-01-01'").run();
 await poll([arrived]);assert.equal(legState(f).stage,'last_mile_delivery');
 f.sqlite.prepare("UPDATE best_transport_tracking SET last_attempt_at='2000-01-01'").run();
 await poll([arrived,signed]);assert.equal(legState(f).stage,'awaiting_receipt');assert.equal(legState(f).stage_owner,'供应链');
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM inventory_balances').all(),balances);
 assert.equal(f.sqlite.prepare('SELECT count(*) n FROM transport_receipts').get().n,0);
 assert.equal(f.sqlite.prepare("SELECT count(*) n FROM audit_logs WHERE action='自动推进百世运输节点'").get().n,2);
});

test('唯一主批提单自动匹配；订舱不推进；解除后后台不重建，查无此单或国家错误只提示',async t=>{
 const f=await prepare(t);
 f.sqlite.prepare("UPDATE transport_batches SET bill_no=?").run(registered);
 await pollBestTracking(f.db,config,async()=>track([arrived],'PH'));
 let view=await readBestTracking(f.db,f.users.admin,f.leg.id);
 assert.equal(view.rows.length,0);assert.match(view.pending[0].reason,/收货国家/);
 f.sqlite.prepare("UPDATE best_tracking_matches SET attempted_at=''").run();
 await pollBestTracking(f.db,config,async()=>track([arrived,signed]));
 assert.equal(legState(f).stage,'booking');
 view=await readBestTracking(f.db,f.users.admin,f.leg.id);
 assert.equal(view.rows.length,1);
 await f.action(f.users.admin,{action:'unlink',id:view.rows[0].id});
 await pollBestTracking(f.db,config,()=>assert.fail('已解除不能重连'));
 const removed=await readBestTracking(f.db,f.users.admin,f.leg.id);
 assert.equal(removed.rows.length,0);assert.equal(removed.pending[0].reason,'已人工解除');
});

test('多票及多物流分组按最慢实际进展；未核对票、预计、无时间和未来实际节点均不能放行',async t=>{
 const f=await prepare(t),other='BSOTHER0002';registeredLeg(f,[registered,other]);
 const actual=[arrived,dispatched,{...signed,kind:'estimate'}];
 await pollBestTracking(f.db,config,async(_,n)=>{
   if(n===other)throw new TrackingError(404,'无运单');
   return track(actual);
 });
 assert.equal(legState(f).stage,'sea_freight');
 f.sqlite.prepare("UPDATE best_tracking_matches SET attempted_at=''").run();
 await pollBestTracking(f.db,config,async()=>({country:'ID',groups:[{events:actual},{events:[{...signed,kind:'unknown'},{...signed,at:null},{...signed,at:'2099-01-01T00:00:00Z'},arrived]}]}));
 assert.equal(legState(f).stage,'port_arrived');
});

test('主批同国多渠道不能推测分批；明确同票分批各自同步，跨主批重复单号必须核对',async t=>{
 const f=await prepare(t);
 f.sqlite.prepare('UPDATE transport_batches SET bill_no=?').run(registered);
 const copy={...legState(f),id:'second-leg',leg_no:'OTHER-LEG',channel:'Shopee'};
 function insert(table,r){f.sqlite.prepare('INSERT INTO '+table+'('+Object.keys(r).join(',')+') VALUES('+Object.keys(r).map(()=>'?').join(',')+')').run(...Object.values(r));}
 insert('transport_legs',copy);
 await pollBestTracking(f.db,config,()=>assert.fail('同国两腿应待确认'));
 assert.match((await readBestTracking(f.db,f.users.admin,f.leg.id)).pending[0].reason,/多个分批/);
 registeredLeg(f,[registered]);await pollBestTracking(f.db,config,async()=>track([arrived]));
 assert.equal(f.sqlite.prepare('SELECT count(*) n FROM best_transport_tracking').get().n,1);
 f.sqlite.prepare('UPDATE transport_legs SET evidence_json=? WHERE id=?').run(JSON.stringify([{stage:'booking',reference:registered}]),copy.id);
 await pollBestTracking(f.db,config,async()=>track([arrived]));
 assert.equal(f.sqlite.prepare('SELECT count(*) n FROM best_transport_tracking').get().n,2);
 const master={...f.sqlite.prepare('SELECT * FROM transport_batches').get(),id:'second-batch',batch_no:'SECOND'};
 insert('transport_batches',master);insert('transport_legs',{...copy,id:'third-leg',leg_no:'THIRD',batch_id:master.id});
 f.sqlite.prepare("UPDATE best_transport_tracking SET last_attempt_at='2000-01-01'").run();
 await pollBestTracking(f.db,config,async()=>track([arrived,signed]));
 assert.equal(legState(f).stage,'port_arrived');
 assert.equal((await readBestTracking(f.db,f.users.admin,'third-leg')).rows.length,0);
});

test('并发手工变更分批凭证时，过期的百世查询响应不能落错分批',async t=>{
 const f=await prepare(t);registeredLeg(f,[registered]);
 await pollBestTracking(f.db,config,async()=>{registeredLeg(f,[]);return track([arrived]);});
 assert.equal(f.sqlite.prepare('SELECT count(*) n FROM best_transport_tracking').get().n,0);
 assert.equal(legState(f).stage,'sea_freight');
});

test('控制塔按可见分批返回最新实际节点，查询结果只定位已登记单号',async t=>{
 const f=await prepare(t);registeredLeg(f,[registered]);
 await pollBestTracking(f.db,config,async()=>track([arrived,{...signed,kind:'estimate'}]));
 const {cardSummaries,waybillLocations}=await import('../lib/best-tracking-auto.mjs');
 const cards=await cardSummaries(f.db,[f.leg.id]);assert.equal(cards.get(f.leg.id)[0].description,arrived.description);
 assert.equal((await cardSummaries(f.db,[])).size,0);
 assert.equal((await waybillLocations(f.db,registered,'ID'))[0].status,'已关联');
 assert.deepEqual(await waybillLocations(f.db,'BSNOTREGISTERED','ID'),[]);
});

test('历史旧票、到港日缺失及更新的未知异常节点保留轨迹，等待人工核实',async t=>{
 const f=await prepare(t);registeredLeg(f,[registered]);
 await pollBestTracking(f.db,config,async()=>track([{...signed,at:'2025-01-01T00:00:00Z'},dispatched]));
 assert.equal(legState(f).stage,'sea_freight');
 f.sqlite.prepare("UPDATE best_transport_tracking SET last_attempt_at='2000-01-01'").run();
 await pollBestTracking(f.db,config,async()=>track([arrived,dispatched,{...signed,state:'Exception'}]));
 assert.equal(legState(f).stage,'sea_freight');
});
