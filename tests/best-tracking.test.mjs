import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {queryBestTracking, trackingSnapshot, TrackingError} from '../lib/best-tracking-client.mjs';
import {manageBestTracking, readBestTracking, pollBestTracking} from '../lib/best-tracking.mjs';
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
