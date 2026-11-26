import test from 'node:test';
import assert from 'node:assert/strict';
import {workplaceFixture} from './workplace-fixture.mjs';
import {readAttendance,punch,mutateLeave} from '../lib/attendance.mjs';

const morning=new Date('2026-11-23T02:00:00Z');
const evening=new Date('2026-11-23T11:00:00Z');
const read=(f,actor=f.users.indonesia,at=morning)=>readAttendance(f.db,actor,{month:'2026-11'},at);
const apply=(f,actor=f.users.indonesia)=>mutateLeave(f.db,actor,{action:'leaveCreate',date:'2026-11-23',portion:'full',reason:'TEST handover only',operationId:crypto.randomUUID()});

test('未配置人员仍返回本人配置清单；管理员能看到未建档员工，普通员工不见其他人',async()=>{
 const f=await workplaceFixture(),r=await read(f,f.users.finance);
 assert.equal(r.profile,null);
 assert.deepEqual(r.readiness.issues,['unit','job','shift','manager']);
 assert.equal(r.readiness.canPunch,false);assert.equal(r.readiness.canLeave,false);
 assert.equal(r.configuration.setupProfiles.length,0);
 const admin=await read(f,f.users.admin);
 assert.ok(admin.configuration.setupProfiles.some(p=>p.userId===f.users.finance.id&&p.issues.includes('unit')));
 const own=await read(f);
 assert.deepEqual(own.configuration.setupProfiles.map(p=>p.userId),[f.users.indonesia.id]);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM attendance_punches').get().n,0);
});

test('缺少班次明确待配置，不能显示休息日或猜测可打卡',async()=>{
 const f=await workplaceFixture(),r=await read(f,f.users.malaysia);
 assert.equal(r.readiness.organizationReady,true);
 assert.deepEqual(r.readiness.issues,['shift']);assert.equal(r.readiness.canPunch,false);
 assert.deepEqual(r.days.map(d=>d.flags),[['configuration_missing']]);
 await assert.rejects(punch(f.db,f.users.malaysia,{kind:'in'},morning),/班次/);
 const sunday=await readAttendance(f.db,f.users.indonesia,{month:'2026-11'},new Date('2026-11-22T02:00:00Z'));
 assert.deepEqual(sunday.days[0].flags,['rest']);
});

test('主管停用会阻止请假投递，但不挡已有真实班次签到；不会自动授予审批权',async()=>{
 const f=await workplaceFixture();f.sqlite.prepare("UPDATE users SET active=0 WHERE id='manager'").run();
 const r=await read(f);
 assert.equal(r.readiness.canPunch,true);assert.equal(r.readiness.managerReady,false);assert.equal(r.readiness.canLeave,false);
 assert.ok(r.readiness.issues.includes('manager'));
 await assert.rejects(apply(f),/有效主管/);
 await punch(f.db,f.users.indonesia,{kind:'in'},morning);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM workplace_grants WHERE capability='manager'").get().n,0);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workplace_requests').get().n,0);
});

test('只使用有效授权组主管，不能投递给停用账号；人事缺项显示待复核路径',async()=>{
 const f=await workplaceFixture();f.sqlite.prepare("UPDATE users SET active=0 WHERE id='manager'").run();
 await f.config({action:'grant',userId:'boss',unitId:'ID',capability:'manager',enabled:true,reason:'TEST explicit authorization'});
 f.sqlite.prepare("DELETE FROM workplace_grants WHERE capability='hr'").run();
 let r=await read(f);assert.equal(r.readiness.canLeave,true);assert.deepEqual(r.readiness.warnings,['hr_review']);
 await apply(f);
 f.sqlite.prepare("UPDATE users SET active=0 WHERE id='boss'").run();
 r=await read(f);assert.equal(r.readiness.canLeave,false);
});

test('组织或站点不匹配和跨组织班次均提示实际缺项，不生成错误排班',async()=>{
 const f=await workplaceFixture();
 await f.config({action:'shift',id:'my-day',unitId:'MY',name:'TEST MY day',startMinute:540,endMinute:1080,weekdays:[1,2,3,4,5],graceIn:0,graceOut:0});
 f.sqlite.prepare("UPDATE workplace_profiles SET shift_id='my-day' WHERE user_id='id-ops'").run();
 let r=await read(f);assert.equal(r.readiness.canPunch,false);assert.ok(r.readiness.issues.includes('shift'));assert.deepEqual(r.days[0].flags,['configuration_missing']);
 await assert.rejects(punch(f.db,f.users.indonesia,{kind:'in'},morning),/组织不一致/);
 f.sqlite.prepare("UPDATE workplace_units SET active=0 WHERE id='ID'").run();
 r=await read(f);assert.equal(r.profile,null);assert.ok(r.readiness.issues.includes('unit'));
 f.sqlite.prepare("UPDATE workplace_units SET active=1 WHERE id='ID'").run();
 f.sqlite.prepare("UPDATE users SET site='泰国' WHERE id='id-ops'").run();
 r=await read(f);assert.equal(r.profile,null);assert.ok(r.readiness.issues.includes('site'));
});

test('已签到后的班次解绑不阻断按原快照签退；未签到或过期不提示可签退',async()=>{
 const f=await workplaceFixture();assert.equal((await read(f)).readiness.canPunchOut,false);
 await punch(f.db,f.users.indonesia,{kind:'in'},morning);
 await f.config({action:'profile',userId:'id-ops',unitId:'ID',jobTitle:'TEST job',managerId:'manager',shiftId:'',version:1});
 let r=await read(f,f.users.indonesia,evening);assert.equal(r.readiness.canPunch,false);assert.equal(r.readiness.canPunchOut,true);
 assert.equal((await read(f,f.users.indonesia,new Date('2026-11-24T00:00:00Z'))).readiness.canPunchOut,false);
 await punch(f.db,f.users.indonesia,{kind:'out'},evening);
 r=await read(f,f.users.indonesia,evening);assert.equal(r.readiness.canPunchOut,false);assert.equal(r.days[0].plan.shiftId,'day');assert.deepEqual(r.days[0].flags,[]);
});

test('补齐真实班次后可申请，主管审批和独立人事复核继续闭环',async()=>{
 const f=await workplaceFixture();
 await f.config({action:'profile',userId:'id-ops',unitId:'ID',jobTitle:'TEST job',managerId:'manager',version:1});
 assert.equal((await read(f)).readiness.canLeave,false);
 await f.config({action:'profile',userId:'id-ops',unitId:'ID',jobTitle:'TEST job',managerId:'manager',shiftId:'day',version:2});
 assert.equal((await read(f)).readiness.canLeave,true);
 const {id}=await apply(f);
 await mutateLeave(f.db,f.users.manager,{action:'managerApprove',id,version:1,reason:'TEST approved'});
 await mutateLeave(f.db,f.users.hr,{action:'hrApprove',id,version:2,reason:'TEST independently checked'});
 const r=await read(f);assert.equal(r.requests[0].status,'approved');assert.deepEqual(r.days[0].flags,['leave']);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workplace_events WHERE entity_id=?').get(id).n,3);
});
