import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const release='a'.repeat(40),script=fileURLToPath(new URL('../scripts/activate-release.sh',import.meta.url));
function activate(overrides={}){
 const dir=mkdtempSync(join(tmpdir(),'lj-deploy-'));
 try{
  writeFileSync(join(dir,'docker'),`#!/bin/bash
printf '%s\\n' "$*" >> "$MOCK_LOG"
case "$1 $2" in
 'image inspect') printf 'LOONGJUMP_RELEASE=%s\\n' "$MOCK_RELEASE" ;;
 'compose config') printf '%s\\n' "$MOCK_IMAGE" ;;
 'compose ps') printf '%s\\n' "$MOCK_CONTAINER" ;;
 'inspect --format') printf 'sha256:previous-image\\n' ;;
 'tag '*|'compose up') exit 0 ;;
 *) echo 'Unexpected docker operation' >&2; exit 9 ;;
esac
`,{mode:0o755});
  const result=spawnSync('/bin/bash',[script,release,'2'],{encoding:'utf8',env:{...process.env,PATH:dir+':'+process.env.PATH,MOCK_LOG:join(dir,'calls'),MOCK_RELEASE:release,MOCK_IMAGE:'existing-project-app',MOCK_CONTAINER:'running-app',...overrides}});
  return {...result,calls:readFileSync(join(dir,'calls'),'utf8').trim().split('\n')};
 }finally{rmSync(dir,{recursive:true,force:true})}
}
test('发布保留旧镜像并仅切换已验证版本，使用现有 Compose 配置且禁止现场构建/拉取',()=>{
 const r=activate();assert.equal(r.status,0,r.stderr);
 assert.deepEqual(r.calls.slice(-3),[`tag sha256:previous-image loongjump-rollback:${release}-2`,`tag loongjump-release:${release} existing-project-app`,'compose up -d --no-build --pull never app']);
});
test('版本不匹配、应用镜像配置不明确或原容器缺失时不覆盖镜像、不重启',()=>{
 for(const invalid of [{MOCK_RELEASE:'old'},{MOCK_IMAGE:''},{MOCK_IMAGE:'one\ntwo'},{MOCK_IMAGE:'repo@sha256:fixed'},{MOCK_CONTAINER:''},{MOCK_CONTAINER:'one\ntwo'}]){
  const r=activate(invalid);assert.notEqual(r.status,0,JSON.stringify(invalid));assert.ok(!r.calls.some(s=>s.startsWith('tag ')||s.startsWith('compose up')),r.calls.join('\n'));
 }
});
