import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readFeishuCredentials} from '../server/feishu-config.mjs';

const fake={appId:'cli_TEST_ONLY',appSecret:'FAKE_PRIVATE_SECRET_793'};
function fixture(){const path=mkdtempSync(join(tmpdir(),'TEST-feishu-config-'));return {path,file:join(path,'fake-credentials.json'),close:()=>rmSync(path,{recursive:true,force:true})};}
const sanitized=(error,code)=>{assert.equal(error.code,code);assert.equal(String(error).includes(fake.appSecret),false);assert.equal(String(error).includes('/private/'),false);assert.equal('cause' in error,false);return true;};

test('credentials load from explicit private file or environment and return only App ID/Secret',()=>{
 const f=fixture();try{
  writeFileSync(f.file,JSON.stringify({...fake,unused:'discard'}),{mode:0o600});
  assert.deepEqual(readFeishuCredentials({LOONGJUMP_FEISHU_CREDENTIALS_FILE:f.file}),fake);
  assert.deepEqual(readFeishuCredentials({FEISHU_APP_ID:` ${fake.appId} `,FEISHU_APP_SECRET:` ${fake.appSecret} `}),fake);
 }finally{f.close();}
});

test('environment credentials are authoritative; partial environment cannot silently fall back to another application file',()=>{
 const f=fixture();try{
  writeFileSync(f.file,JSON.stringify(fake),{mode:0o600});
  assert.throws(()=>readFeishuCredentials({FEISHU_APP_ID:'cli_OTHER',LOONGJUMP_FEISHU_CREDENTIALS_FILE:f.file}),e=>sanitized(e,'credentials_incomplete'));
  assert.throws(()=>readFeishuCredentials({FEISHU_APP_SECRET:fake.appSecret,LOONGJUMP_FEISHU_CREDENTIALS_FILE:f.file}),e=>sanitized(e,'credentials_incomplete'));
  assert.deepEqual(readFeishuCredentials({FEISHU_APP_ID:fake.appId,FEISHU_APP_SECRET:fake.appSecret,LOONGJUMP_FEISHU_CREDENTIALS_FILE:'/not/read'}),fake);
 }finally{f.close();}
});

test('optional default file absence and empty credentials are unconfigured; explicit inaccessible files fail with safe errors',()=>{
 const f=fixture(),previous=process.cwd();try{
  process.chdir(f.path);assert.equal(readFeishuCredentials({}),null);
  mkdirSync('secrets');writeFileSync('secrets/feishu_credentials.json','{}',{mode:0o600});assert.equal(readFeishuCredentials({}),null);
  writeFileSync(f.file,JSON.stringify({appId:' ',appSecret:' '}));assert.equal(readFeishuCredentials({LOONGJUMP_FEISHU_CREDENTIALS_FILE:f.file}),null);
  assert.throws(()=>readFeishuCredentials({LOONGJUMP_FEISHU_CREDENTIALS_FILE:join(f.path,'missing',fake.appSecret)}),e=>sanitized(e,'credentials_unavailable'));
 }finally{process.chdir(previous);f.close();}
});

test('malformed JSON, directory paths and invalid/oversized fields never echo input or file contents',()=>{
 const f=fixture();try{
  writeFileSync(f.file,`invalid-json-${fake.appSecret}`);
  assert.throws(()=>readFeishuCredentials({LOONGJUMP_FEISHU_CREDENTIALS_FILE:f.file}),e=>sanitized(e,'credentials_unavailable'));
  assert.throws(()=>readFeishuCredentials({LOONGJUMP_FEISHU_CREDENTIALS_FILE:f.path}),e=>sanitized(e,'credentials_unavailable'));
  for(const input of [{appId:'bad-id',appSecret:fake.appSecret},{appId:fake.appId},{appId:fake.appId,appSecret:'x'.repeat(4097)},{appId:123,appSecret:fake.appSecret}]){
   writeFileSync(f.file,JSON.stringify(input));
   assert.throws(()=>readFeishuCredentials({LOONGJUMP_FEISHU_CREDENTIALS_FILE:f.file}),e=>sanitized(e,'credentials_incomplete'));
  }
 }finally{f.close();}
});
