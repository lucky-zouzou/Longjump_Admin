import test from 'node:test';
import assert from 'node:assert/strict';
import {workplaceFixture} from './workplace-fixture.mjs';
import {punch,mutateLeave,readAttendance} from '../lib/attendance.mjs';

const clockIn=new Date('2026-11-23T02:00:00Z');
const clockOut=new Date('2026-11-23T11:00:00Z');
const count=(f,table)=>f.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const leave=(f,portion='first',actor=f.users.indonesia)=>mutateLeave(f.db,actor,{
 action:'leaveCreate',date:'2026-11-23',portion,reason:'TEST transfer handover',operationId:crypto.randomUUID(),
});

async function oldOrganization(f){
 await f.config({action:'unit',id:'OLD',name:'TEST old organization',legalEntity:'TEST OLD ENTITY',site:'印尼',timezone:'Asia/Jakarta',department:'TEST old department',workplace:'TEST old office'});
 await f.config({action:'shift',id:'OLD-DAY',unitId:'OLD',name:'TEST old day',startMinute:540,endMinute:1080,weekdays:[1,2,3,4,5],graceIn:0,graceOut:0});
 await f.config({action:'profile',userId:'id-ops',unitId:'OLD',jobTitle:'TEST old job',managerId:'manager',shiftId:'OLD-DAY',version:1});
}
async function transferToId(f){
 await f.config({action:'profile',userId:'id-ops',unitId:'ID',jobTitle:'TEST new job',managerId:'boss',shiftId:'day',version:2});
}

test('账号站点变化而组织未同步时，不能继续向旧站点新建费用、请假或签到',async()=>{
 const f=await workplaceFixture();
 try{
  f.sqlite.prepare("UPDATE users SET site='马来西亚' WHERE id='id-ops'").run();
  const actor={...f.users.indonesia,site:'马来西亚'};
  await assert.rejects(f.expense({},actor));
  await assert.rejects(leave(f,'first',actor));
  await assert.rejects(punch(f.db,actor,{kind:'in'},clockIn));
  assert.equal(count(f,'workplace_requests'),0);
  assert.equal(count(f,'attendance_days'),0);
  assert.equal(count(f,'attendance_punches'),0);
 }finally{f.sqlite.close();}
});

test('调岗后新组织人事和主管只看本组织出勤，员工仍能看自己的旧组织历史',async()=>{
 const f=await workplaceFixture();
 try{
  await oldOrganization(f);
  await punch(f.db,f.users.indonesia,{kind:'in'},new Date('2026-11-20T02:00:00Z'));
  await punch(f.db,f.users.indonesia,{kind:'out'},new Date('2026-11-20T11:00:00Z'));
  await transferToId(f);
  for(const actor of [f.users.hr,f.users.boss]){
   const view=await readAttendance(f.db,actor,{month:'2026-11'},clockIn);
   assert.ok(view.days.some(d=>d.user_id==='id-ops'&&d.unit_id==='ID'));
   assert.ok(!view.days.some(d=>d.unit_id==='OLD'));
  }
  const own=await readAttendance(f.db,f.users.indonesia,{month:'2026-11'},clockIn);
  const old=own.days.find(d=>d.unit_id==='OLD'&&d.work_date==='2026-11-20');
  assert.equal(old.in,'2026-11-20T02:00:00.000Z');
  assert.equal(old.out,'2026-11-20T11:00:00.000Z');
 }finally{f.sqlite.close();}
});

test('调岗前请假的旧组织计划不能被用于向新组织写签到或另一半班请假',async()=>{
 const f=await workplaceFixture();
 try{
  await oldOrganization(f);
  const original=await leave(f);
  await transferToId(f);
  await assert.rejects(punch(f.db,f.users.indonesia,{kind:'in'},clockIn));
  await assert.rejects(leave(f,'second'));
  assert.equal(count(f,'workplace_requests'),1);
  assert.equal(count(f,'attendance_days'),0);
  const saved=f.sqlite.prepare('SELECT unit_id,data_json FROM workplace_requests WHERE id=?').get(original.id);
  assert.equal(saved.unit_id,'OLD');
  assert.equal(JSON.parse(saved.data_json).plan.unitId,'OLD');
 }finally{f.sqlite.close();}
});

test('已有旧组织班次可沿原行签退，不能借该历史计划向新组织补建请假',async()=>{
 const f=await workplaceFixture();
 try{
  await oldOrganization(f);
  await punch(f.db,f.users.indonesia,{kind:'in'},clockIn);
  const before=f.sqlite.prepare('SELECT * FROM attendance_days').get();
  await transferToId(f);
  await assert.rejects(leave(f,'second'));
  await punch(f.db,f.users.indonesia,{kind:'out'},clockOut);
  const after=f.sqlite.prepare('SELECT * FROM attendance_days').get();
  assert.equal(after.id,before.id);
  assert.equal(after.unit_id,'OLD');
  assert.equal(after.plan_json,before.plan_json);
  assert.equal(count(f,'attendance_days'),1);
  assert.equal(count(f,'attendance_punches'),2);
  assert.equal(count(f,'workplace_requests'),0);
 }finally{f.sqlite.close();}
});
