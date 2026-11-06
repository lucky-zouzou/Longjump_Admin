import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {NAV_GROUPS} from '../lib/workspace-model.mjs';
import {navigationForRole} from '../lib/permissions.mjs';

test('原版三组菜单覆盖管理员入口且保留销售与达人协作',()=>{
  assert.deepEqual(NAV_GROUPS.map(group=>group.label),['日常工作','供应与履约','产品与系统']);
  const keys=NAV_GROUPS.flatMap(group=>group.keys);
  assert.equal(new Set(keys).size,keys.length);
  for(const key of navigationForRole('管理员'))assert.ok(keys.includes(key),key);
  assert.equal(NAV_GROUPS[0].keys.indexOf('creators'),NAV_GROUPS[0].keys.indexOf('sales')+1);
});

test('公共分销入口只接受同域专属链接；粘贴链接时无需向服务器传递令牌',()=>{
  const listeners={},location={origin:'https://example.test',hash:'',replace(hash){this.hash=hash;},reload(){this.reloaded=true;}};
  const elements={};
  const document={getElementById(id){return elements[id]??={addEventListener(event,fn){listeners[id+event]=fn;},setCustomValidity(message){this.message=message;},reportValidity(){}};}};
  runInNewContext(readFileSync(new URL('../public/distributor-assets/ordering.js',import.meta.url),'utf8'),{document,location,URL});
  assert.equal(elements['portal-access'].hidden,false);
  const token='a'.repeat(64);
  const submit=url=>{elements['private-link'].value=url;listeners['open-private-linksubmit']({preventDefault(){}});};
  for(const url of ['https://wrong.test/distributor#'+token,location.origin+'/api/distributor#'+token,location.origin+'/distributor?token='+token,location.origin+'/distributor#bad']){
    submit(url);assert.equal(location.hash,'');assert.ok(elements['private-link'].message);
  }
  submit(location.origin+'/distributor#'+token);assert.equal(location.hash,'#'+token);assert.equal(location.reloaded,true);
});
