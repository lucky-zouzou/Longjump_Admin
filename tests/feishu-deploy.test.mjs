import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,statSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFeishuCredentials} from '../server/feishu-config.mjs';

const script=fileURLToPath(new URL('../scripts/configure-feishu-credentials.py',import.meta.url));
const fake={appId:'cli_TEST_ONLY_793',appSecret:'FAKE_TEST_ONLY_SECRET_793'};
const run=(cwd,input)=>spawnSync('python3',[script],{cwd,input,encoding:'utf8'});

test('deployment installs only validated credentials atomically and application can read mounted-format file',()=>{
 const dir=mkdtempSync(join(tmpdir(),'TEST-feishu-deploy-'));
 try{
  const result=run(dir,JSON.stringify({...fake,unused:'not stored'}));
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');assert.equal(result.stderr,'');
  const path=join(dir,'secrets/feishu/credentials.json');
  assert.deepEqual(readFeishuCredentials({LOONGJUMP_FEISHU_CREDENTIALS_FILE:path}),fake);
  assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),fake);
  assert.equal(statSync(join(dir,'secrets/feishu')).mode&0o777,0o700);
  assert.equal(statSync(path).mode&0o777,0o444);
  const updated={...fake,appSecret:'FAKE_REPLACEMENT_SECRET_793'};
  assert.equal(run(dir,JSON.stringify(updated)).status,0);
  assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),updated);
  for(const bad of ['{'+fake.appSecret,JSON.stringify({appId:fake.appId}),JSON.stringify({...fake,appId:'bad'}),JSON.stringify({...fake,appSecret:'x'.repeat(4097)}),JSON.stringify({...fake,appSecret:'line\nbreak'}),JSON.stringify({...fake,appSecret:123})]){
   const failure=run(dir,bad);assert.notEqual(failure.status,0);assert.equal(failure.stdout,'');
   assert.ok(!failure.stderr.includes(fake.appSecret));assert.ok(!failure.stderr.includes('Traceback'));
   assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),updated);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('deployment refuses symlinked credential directories or files without changing the destination',()=>{
 for(const at of ['parent','directory','file']){
  const dir=mkdtempSync(join(tmpdir(),'TEST-feishu-link-'));
  try{
   const outside=join(dir,'other');mkdirSync(outside);writeFileSync(join(outside,'sentinel'),'unchanged');
   if(at==='parent')symlinkSync(outside,join(dir,'secrets'));
   else {mkdirSync(join(dir,'secrets'));if(at==='directory')symlinkSync(outside,join(dir,'secrets/feishu'));
    else {mkdirSync(join(dir,'secrets/feishu'));symlinkSync(join(outside,'sentinel'),join(dir,'secrets/feishu/credentials.json'));}}
   const result=run(dir,JSON.stringify(fake));assert.notEqual(result.status,0);assert.equal(readFileSync(join(outside,'sentinel'),'utf8'),'unchanged');
  }finally{rmSync(dir,{recursive:true,force:true});}
 }
});
