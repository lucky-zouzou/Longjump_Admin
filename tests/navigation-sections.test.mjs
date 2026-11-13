import test from 'node:test';
import assert from 'node:assert/strict';
import {NAV_GROUPS} from '../lib/workspace-model.mjs';
import {navigationForRole} from '../lib/permissions.mjs';

test('原版三组菜单覆盖管理员入口且保留销售与达人协作',()=>{
  assert.deepEqual(NAV_GROUPS.map(group=>group.label),['日常工作','供应与履约','产品与系统']);
  const keys=NAV_GROUPS.flatMap(group=>group.keys);
  assert.equal(new Set(keys).size,keys.length);
  for(const key of navigationForRole('管理员'))assert.ok(keys.includes(key),key);
  assert.equal(NAV_GROUPS[0].keys.indexOf('creators'),NAV_GROUPS[0].keys.indexOf('sales')+1);
});

test('分销独立于线下入口，运营和财务按角色可访问',()=>{
 const keys=NAV_GROUPS.flatMap(g=>g.keys);assert(keys.includes('distribution'));assert(keys.includes('wholesale'));
 for(const role of ['管理员','财务','运营','销售'])assert(navigationForRole(role).includes('distribution'));
 for(const role of ['工厂','海运','达人BD'])assert(!navigationForRole(role).includes('distribution'));
});
