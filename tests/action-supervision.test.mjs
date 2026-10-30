import test from 'node:test';
import assert from 'node:assert/strict';
import {actionOverdue} from '../lib/business-action-supervision.mjs';
import {businessActionTasks} from '../lib/business-actions.mjs';
import {systemFixture} from './system-fixture.mjs';

const now=new Date('2026-10-28T12:00:00Z');
const base={status:'open',owner_id:null,due_at:'2026-10-27T00:00:00Z',review_at:'2026-10-27T12:00:00Z',snapshot:{condition:'verify'}};
test('证据缺失且未分配不能制造执行逾期；明确分工及复查承诺仍受监督',()=>{
 assert.equal(actionOverdue(base,now),false);
 assert.equal(actionOverdue({...base,snapshot:{condition:'clear'}},now),false);
 assert.equal(actionOverdue({...base,snapshot:{condition:'active'}},now),true);
 assert.equal(actionOverdue({...base,owner_id:'operator'},now),true);
 assert.equal(actionOverdue({...base,status:'in_progress'},now),true);
 assert.equal(actionOverdue({...base,status:'review_pending',snapshot:{condition:'clear'}},now),true);
 assert.equal(actionOverdue({...base,status:'review_pending',review_at:'2026-10-29T00:00:00Z'},now),false);
 assert.equal(actionOverdue({...base,status:'resolved',owner_id:'operator'},now),false);
});
test('总览待办与行动页共用到期口径，待核实保留但不错误标红',async()=>{
 const f=systemFixture();try{
  f.sqlite.prepare("INSERT INTO business_actions(id,site,channel,sku,kind,status,snapshot_json,opened_at,updated_at,due_at,review_at) VALUES('TEST-VERIFY','印尼','TikTok','BAG-A','loss','open',?,'2026-10-26','2026-10-26',?,?)").run(JSON.stringify(base.snapshot),base.due_at,base.review_at);
  let tasks=await businessActionTasks(f.db,f.users.admin,now);assert.equal(tasks.length,1);assert.equal(tasks[0].level,'amber');assert.match(tasks[0].detail,/1条证据待核实/);assert.doesNotMatch(tasks[0].detail,/已到期/);
  f.sqlite.prepare("UPDATE business_actions SET owner_id=?").run(f.users.indonesia.id);
  tasks=await businessActionTasks(f.db,f.users.indonesia,now);assert.equal(tasks[0].level,'red');assert.match(tasks[0].detail,/1条已到期/);
 }finally{f.sqlite.close();}
});
