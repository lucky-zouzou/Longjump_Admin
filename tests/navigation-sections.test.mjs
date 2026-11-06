import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {NAV_GROUPS,PARTNER_LINKS,workspaceShortcuts} from '../lib/workspace-model.mjs';
import {navigationForRole} from '../lib/permissions.mjs';

test('四个分区覆盖管理员的菜单；分销查询只使用公开页面及客户自己的凭证',()=>{
  assert.deepEqual(NAV_GROUPS.map(group=>group.label),['运营工作','外部查询与分销','财务管理','内部管理']);
  const keys=NAV_GROUPS.flatMap(group=>group.keys);
  assert.equal(new Set(keys).size,keys.length);
  for(const key of navigationForRole('管理员').filter(key=>key!=='after-sales'))assert.ok(keys.includes(key),key);
  assert.deepEqual(NAV_GROUPS[1].keys,PARTNER_LINKS.map(link=>link.key));
  assert.deepEqual(PARTNER_LINKS.map(link=>link.href),['/distributor','/distributor/apply']);
  assert.equal(NAV_GROUPS[0].keys.indexOf('creators'),NAV_GROUPS[0].keys.indexOf('sales')+1);
  assert.deepEqual(workspaceShortcuts('运营','印尼'),PARTNER_LINKS);
  assert.deepEqual(workspaceShortcuts('运营','泰国'),[]);
  assert.deepEqual(workspaceShortcuts('工厂'),[]);
  assert.deepEqual(workspaceShortcuts('财务').map(x=>[x.page,x.view]),[['wholesale','finance']]);
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
