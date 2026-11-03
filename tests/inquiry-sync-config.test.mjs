import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,symlinkSync,statSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../scripts/configure-inquiry-sync.py',import.meta.url));
function fixture(fn){const root=mkdtempSync(join(tmpdir(),'lj-inquiry-config-'));try{fn(root,()=>spawnSync('python3',[script,root],{encoding:'utf8'}));}finally{rmSync(root,{recursive:true,force:true});}}
test('服务器询盘密钥独立生成、仅属主可读，重复发布不轮换且不输出密钥',()=>fixture((root,run)=>{
 const a=run();assert.equal(a.status,0,a.stderr);const path=join(root,'secrets/inquiry-sync.env'),value=readFileSync(path,'utf8'),secret=value.split('\n')[0].split('=')[1];
 assert.match(secret,/^[A-Za-z0-9_-]{64}$/);assert.equal(statSync(path).mode&0o777,0o600);assert.ok(!a.stdout.includes(secret));
 const b=run();assert.equal(b.status,0,b.stderr);assert.equal(readFileSync(path,'utf8'),value);assert.ok(!b.stdout.includes(secret));
}));
test('已有无效配置不静默改写或重置',()=>fixture((root,run)=>{
 mkdirSync(join(root,'secrets'));const path=join(root,'secrets/inquiry-sync.env');writeFileSync(path,'invalid-existing-config');
 const r=run();assert.notEqual(r.status,0);assert.equal(readFileSync(path,'utf8'),'invalid-existing-config');assert.equal(existsSync(join(root,'compose.inquiry-sync.yaml')),false);
}));
test('拒绝覆盖其他 Compose 扩展或跟随密钥符号链接',()=>fixture((root,run)=>{
 const overlay=join(root,'compose.inquiry-sync.yaml');writeFileSync(overlay,'services: {other: {}}');assert.notEqual(run().status,0);assert.equal(readFileSync(overlay,'utf8'),'services: {other: {}}');
 rmSync(overlay);const other=join(root,'other');mkdirSync(other);rmSync(join(root,'secrets'),{recursive:true});symlinkSync(other,join(root,'secrets'));assert.notEqual(run().status,0);assert.equal(existsSync(join(other,'inquiry-sync.env')),false);
}));
