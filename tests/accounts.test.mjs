import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {accountSchema,verifyPassword} from '../server/accounts.mjs';
import {createCompanyAccount} from '../server/create-account.mjs';

function setup(t){
  const f=fixture();accountSchema(f.sqlite);t.after(()=>f.sqlite.close());
  const input={name:'新运营',email:' New.Ops@Example.Test ',role:'运营',site:'印尼',channel:'Shopee',responsibilityUnit:'印尼团队',password:`test-only-${crypto.randomUUID()}`};
  return {...f,input,create:(changes={},actor=f.users.admin)=>createCompanyAccount(f.sqlite,actor,{...input,...changes})};
}

test('新增用户：保存岗位范围、密码哈希和不含密码的审计',t=>{
  const f=setup(t),{userId}=f.create();
  const user=f.sqlite.prepare('SELECT * FROM users WHERE id=?').get(userId);
  assert.equal(user.name,'新运营');assert.equal(user.email,'new.ops@example.test');assert.equal(user.active,1);
  assert.equal(user.site,'印尼');assert.equal(user.channel,'Shopee');assert.equal(user.responsibility_unit,'印尼团队');
  const account=f.sqlite.prepare('SELECT * FROM local_accounts WHERE user_id=?').get(userId);
  assert.equal(account.email,user.email);assert.ok(verifyPassword(f.input.password,account.password_hash));
  assert.ok(!account.password_hash.includes(f.input.password));
  const audit=f.sqlite.prepare('SELECT * FROM audit_logs WHERE entity_id=?').get(userId);
  assert.equal(audit.actor_id,f.users.admin.id);assert.equal(audit.action,'新增用户');
  assert.ok(!audit.detail_json.includes(f.input.password));assert.ok(!audit.detail_json.includes('password'));
});

test('新增用户：重复邮箱不覆盖账号、密码或权限，包括旧大写邮箱',t=>{
  const f=setup(t),{userId}=f.create();
  const before=f.sqlite.prepare('SELECT * FROM local_accounts WHERE user_id=?').get(userId);
  assert.throws(()=>f.create({email:'NEW.OPS@EXAMPLE.TEST',role:'管理员',password:'different-password-123'}),{status:409});
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM local_accounts WHERE user_id=?').get(userId),before);
  assert.equal(f.sqlite.prepare('SELECT role FROM users WHERE id=?').get(userId).role,'运营');
  f.sqlite.prepare('UPDATE users SET email=? WHERE id=?').run('LEGACY@EXAMPLE.TEST',f.users.finance.id);
  assert.throws(()=>f.create({email:'legacy@example.test'}),{status:409});
});

test('新增用户：所有岗位可创建，销售固定印尼线下分销，全局岗位清除站点',t=>{
  const f=setup(t);
  for(const [i,role] of ['管理员','销售','运营','运营主管','新品开发','财务','供应链','工厂','海运'].entries()){
    const {userId}=f.create({email:`role-${i}@example.test`,role,active:false});
    const user=f.sqlite.prepare('SELECT * FROM users WHERE id=?').get(userId);
    assert.equal(user.role,role);assert.equal(user.active,0);
    assert.equal(user.site,['销售','运营'].includes(role)?'印尼':null);
    assert.equal(user.channel,role==='销售'?'线下分销':role==='运营'?'Shopee':null);
  }
});

test('新增用户：校验必填项、长度、邮箱、角色、密码及运营范围',t=>{
  const f=setup(t);
  for(const changes of [
    {name:' '},{name:'x'.repeat(121)},{name:[]},{email:'bad@email'},{email:'x@y@z.test'},
    {email:'x'.repeat(255)+'@example.test'},{role:'超级管理员'},
    {password:'short'},{password:'x'.repeat(257)},{password:null},
    {site:''},{site:'invalid'},{channel:''},{channel:'线下分销'},
    {responsibilityUnit:'x'.repeat(121)},{active:'false'},
  ])assert.throws(()=>f.create(changes),{status:400},JSON.stringify({...changes,password:'[omitted]'}));
  for(const input of [null,[],true,'bad'])assert.throws(()=>createCompanyAccount(f.sqlite,f.users.admin,input),{status:400});
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) total FROM local_accounts').get().total,0);
});

test('新增用户：普通账号、伪造管理员及停用管理员被拒绝',t=>{
  const f=setup(t);
  for(const actor of Object.values(f.users).filter(actor=>actor.id!==f.users.admin.id))assert.throws(()=>f.create({},actor),{status:403});
  assert.throws(()=>f.create({},{...f.users.sales,role:'管理员'}),{status:403});
  assert.throws(()=>f.create({},{id:'missing',role:'管理员'}),{status:403});
  f.sqlite.prepare('UPDATE users SET active=0 WHERE id=?').run(f.users.admin.id);
  assert.throws(()=>f.create(),{status:403});
});

test('新增用户：备份期间阻止创建，审计失败时账号和密码全部回滚',t=>{
  const f=setup(t);
  f.sqlite.prepare("INSERT INTO system_maintenance (id,mode,actor_id,expires_at,updated_at) VALUES ('global','backup','test',?,?)").run(new Date(Date.now()+60000).toISOString(),new Date().toISOString());
  assert.throws(()=>f.create(),{status:409});
  f.sqlite.exec("UPDATE system_maintenance SET mode='normal' WHERE id='global'; CREATE TRIGGER reject_account_audit BEFORE INSERT ON audit_logs WHEN NEW.action='新增用户' BEGIN SELECT RAISE(ABORT,'test audit failure'); END");
  assert.throws(()=>f.create(),/test audit failure/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) total FROM users WHERE email=?').get('new.ops@example.test').total,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) total FROM local_accounts').get().total,0);
});
