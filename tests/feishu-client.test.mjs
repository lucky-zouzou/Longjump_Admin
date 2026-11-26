import test from 'node:test';
import assert from 'node:assert/strict';
import {createFeishuClient, FeishuClientError, FEISHU_ATTENDANCE_SCOPE} from '../lib/feishu-client.mjs';

const NOW = Date.parse('2026-11-24T08:00:00Z');
const credentials = {appId: 'cli_test', appSecret: 'only-a-fake-test-secret'};
const window = {externalUserId: 'employee-1', idType: 'employee_id', timezone: 'Asia/Shanghai', from: '2026-11-18', to: '2026-11-24'};
const tokenBody = (extra = {}) => ({code: 0, access_token: 'test-token', token_type: 'Bearer', expires_in: 7200, scope: FEISHU_ATTENDANCE_SCOPE, ...extra});
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json', ...headers}});
const punch = (extra = {}) => ({record_id: 'punch-1', user_id: 'employee-1', check_time: String(Date.parse('2026-11-23T01:00:00Z') / 1000), ...extra});
const leave = (extra = {}) => ({idempotent_id: 'leave-1', approval_id: 'approval-1', start_time: '2026-11-23 09:00:00', end_time: '2026-11-23 18:00:00', ...extra});
const approval = (extra = {}) => ({user_id: 'employee-1', date: '20261123', time_zone: 'Asia/Shanghai', leaves: [leave()], ...extra});

function fixture({flows = [], approved = [], revoked = [], token = tokenBody(), handle, options = {}} = {}) {
  const calls = [], sleeps = [];
  const client = createFeishuClient(credentials, {
    now: () => NOW, sleep: async ms => { sleeps.push(ms); }, ...options,
    fetchImpl: async (url, init) => {
      const call = {url, init, body: JSON.parse(init.body)};
      calls.push(call);
      const custom = await handle?.(call, calls);
      if (custom) return custom;
      if (url.includes('accounts.feishu.cn')) return json(token);
      if (url.includes('user_flows')) return json({code: 0, data: {user_flow_results: flows}});
      return json({code: 0, data: {user_approvals: call.body.status === 2 ? approved : revoked}});
    },
  });
  return {client, calls, sleeps};
}

async function rejects(promise, code) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof FeishuClientError);
    assert.equal(error.code, `feishu_${code}`);
    assert.equal(String(error).includes(credentials.appSecret), false);
    assert.equal(String(error).includes('test-token'), false);
    return true;
  });
}

test('token uses new OAuth endpoint, caches concurrent requests, and reports exported scope without leaking token', async () => {
  const {client, calls} = fixture();
  const [a, b] = await Promise.all([client.testConnection(), client.testConnection()]);
  assert.deepEqual(a, {authenticated: true, attendanceScope: 'confirmed', grantedScopes: [FEISHU_ATTENDANCE_SCOPE]});
  assert.deepEqual(b, a);
  await client.readWindow(window);
  assert.equal(calls.filter(c => c.url.includes('/token')).length, 1);
  assert.equal(calls[0].url, 'https://accounts.feishu.cn/oauth/v3/token');
  assert.deepEqual(calls[0].body, {grant_type: 'client_credentials', client_id: 'cli_test', client_secret: credentials.appSecret});
  assert.equal(calls.every(c => c.init.redirect === 'error' && c.init.cache === 'no-store'), true);
});

test('absent token scope is unverified, explicitly missing scope is missing, not a permission success', async () => {
  for (const [scope, attendanceScope] of [[undefined, 'unverified'], ['', 'missing'], ['contact:user.base:readonly', 'missing']]) {
    const result = await fixture({token: tokenBody({scope})}).client.testConnection();
    assert.equal(result.authenticated, true);
    assert.equal(result.attendanceScope, attendanceScope);
  }
});

test('token honors actual expires_in and refreshes before expiry', async () => {
  let clock = NOW;
  const {client, calls} = fixture({token: tokenBody({expires_in: 10}), options: {now: () => clock}});
  await client.testConnection(); clock += 8000;
  await client.testConnection();
  assert.equal(calls.length, 1);
  clock += 1000;
  await client.testConnection();
  assert.equal(calls.length, 2);
});

test('single seven-day window queries local midnight [from,to+1) and both leave statuses', async () => {
  const {client, calls} = fixture();
  assert.deepEqual(await client.readWindow(window), {attendance: [], leave: []});
  assert.equal(calls.length, 4);
  assert.equal(new URL(calls[1].url).searchParams.get('include_terminated_user'), 'false');
  assert.deepEqual(calls[1].body, {user_ids: ['employee-1'], check_time_from: String(Date.parse('2026-11-17T16:00:00Z') / 1000), check_time_to: String(Date.parse('2026-11-24T16:00:00Z') / 1000)});
  assert.deepEqual(calls.slice(2).map(c => c.body), [2, 4].map(status => ({user_ids: ['employee-1'], check_date_from: 20261118, check_date_to: 20261124, check_date_type: 'PeriodTime', status})));
});

test('punches are plain recorded facts; leave only stores minimal timestamps and approved/revoked status', async () => {
  const {client} = fixture({
    flows: [punch({check_result: 'Late', location_name: 'private home', longitude: 99, comment: 'medical', creator_id: 'manager', create_time: '123'})],
    approved: [approval({leaves: [leave({reason: 'private medical reason', interval: 32400, unit: 1, i18n_names: {zh: '病假'}})]})],
    revoked: [approval({leaves: [leave({idempotent_id: 'leave-2', approval_id: 'approval-2'})]})],
  });
  const result = await client.readWindow(window);
  assert.equal(result.attendance[0].status, 'recorded');
  assert.deepEqual(Object.keys(result.attendance[0]).sort(), ['sourceId', 'externalUserId', 'workDate', 'status', 'punchedAt'].sort());
  assert.equal(result.attendance[0].workDate, '2026-11-23');
  assert.equal(result.attendance[0].punchedAt, '2026-11-23T01:00:00.000Z');
  assert.deepEqual(result.leave.map(r => r.status), ['approved', 'revoked']);
  assert.equal(result.leave[0].startAt, '2026-11-23T01:00:00.000Z');
  assert.equal(result.leave[0].endAt, '2026-11-23T10:00:00.000Z');
  assert.deepEqual(Object.keys(result.leave[0]).sort(), ['sourceId', 'externalUserId', 'workDate', 'status', 'startAt', 'endAt'].sort());
  assert.equal(/private|medical|Late|manager|duration|病假|interval|unit/.test(JSON.stringify(result)), false);
});

test('empty upstream time_zone means UTC, never silently inherits the local workplace timezone', async () => {
  for (const time_zone of ['', undefined]) {
    const result = await fixture({approved: [approval({time_zone})]}).client.readWindow(window);
    assert.equal(result.leave[0].startAt, '2026-11-23T09:00:00.000Z');
  }
});

test('night-shift leave retains its upstream effect workday even when the interval starts next morning', async () => {
  const {client} = fixture({approved: [approval({date: '20261122', leaves: [leave({start_time: '2026-11-23 01:00:00', end_time: '2026-11-23 03:00:00'})]})]});
  const result = await client.readLeaveWindow({...window, from: '2026-11-22', to: '2026-11-22'});
  assert.equal(result[0].workDate, '2026-11-22');
  assert.equal(result[0].startAt, '2026-11-22T17:00:00.000Z');
  assert.equal(result[0].endAt, '2026-11-22T19:00:00.000Z');
});

test('readLeaveWindow reads future approved leave for thirty dates, with both status queries and no punch request', async () => {
  const {client, calls} = fixture({approved: [approval({date: '20261220', leaves: [leave({start_time: '2026-12-20 09:00:00', end_time: '2026-12-20 18:00:00'})]})]});
  const result = await client.readLeaveWindow({...window, from: '2026-11-24', to: '2026-12-23'});
  assert.equal(result[0].workDate, '2026-12-20');
  assert.equal(calls.length, 3);
  assert.equal(calls.slice(1).every(c => c.url.includes('user_approvals') && c.body.check_date_to === 20261223), true);
});

test('source IDs are stable across windows and independent of approval status', async () => {
  const a = await fixture({flows: [punch()], approved: [approval()]}).client.readWindow(window);
  const b = await fixture({flows: [punch()], revoked: [approval()]}).client.readWindow({...window, from: '2026-11-23'});
  assert.equal(a.attendance[0].sourceId, b.attendance[0].sourceId);
  assert.equal(a.leave[0].sourceId, b.leave[0].sourceId);
  assert.equal(a.leave[0].weakIdentity, undefined);
});

test('each affected workDate gets its own stable identity, not leave type uniq_id', async () => {
  const period = leave({uniq_id: 'same-leave-type', start_time: '2026-11-22 09:00:00', end_time: '2026-11-24 18:00:00'});
  const result = await fixture({approved: [approval({date: '20261122', leaves: [period]}), approval({date: '20261123', leaves: [period]})]}).client.readWindow(window);
  assert.equal(result.leave.length, 2);
  assert.notEqual(result.leave[0].sourceId, result.leave[1].sourceId);
  const fallback = await fixture({approved: [approval({leaves: [leave({idempotent_id: undefined, approval_id: 'native-approval'})]})]}).client.readWindow(window);
  assert.equal(fallback.leave[0].weakIdentity, undefined);
});

test('absent IDs get stable weak identity; duplicate weak identities fail instead of silently losing records', async () => {
  const noId = punch({record_id: undefined});
  const noLeaveId = leave({idempotent_id: undefined, approval_id: undefined, uniq_id: 'not-an-instance-id'});
  const a = await fixture({flows: [noId], approved: [approval({leaves: [noLeaveId]})]}).client.readWindow(window);
  const b = await fixture({flows: [noId], approved: [approval({leaves: [noLeaveId]})]}).client.readWindow(window);
  assert.deepEqual(a, b);
  assert.equal(a.attendance[0].weakIdentity, true);
  assert.equal(a.leave[0].weakIdentity, true);
  await rejects(fixture({flows: [noId, noId]}).client.readWindow(window), 'conflict');
  await rejects(fixture({approved: [approval({leaves: [noLeaveId, noLeaveId]})]}).client.readWindow(window), 'conflict');
});

test('identical strong-ID retries dedupe, but changed times or concurrent approved/revoked identities fail', async () => {
  const deduped = await fixture({flows: [punch(), punch()], approved: [approval(), approval()]}).client.readWindow(window);
  assert.equal(deduped.attendance.length, 1); assert.equal(deduped.leave.length, 1);
  await rejects(fixture({flows: [punch(), punch({check_time: String(Number(punch().check_time) + 60)})]}).client.readWindow(window), 'conflict');
  await rejects(fixture({approved: [approval()], revoked: [approval()]}).client.readWindow(window), 'conflict');
  await rejects(fixture({approved: [approval({leaves: [leave(), leave({approval_id: 'unrelated-approval'})]})]}).client.readWindow(window), 'conflict');
});

test('unknown users in either endpoint fail the whole window', async () => {
  await rejects(fixture({flows: [punch({user_id: 'different'})]}).client.readWindow(window), 'identity');
  await rejects(fixture({approved: [approval({user_id: 'different'})]}).client.readWindow(window), 'identity');
});

test('missing arrays, invalid/unauthorized users and pagination markers are never treated as an empty window', async () => {
  for (const data of [{}, {user_flow_results: null}, {user_flow_results: [] , has_more: true}, {user_flow_results: [], page_token: 'next'}, {user_flow_results: [], invalid_user_ids: ['employee-1']}, {user_flow_results: [], unauthorized_user_ids: ['employee-1']}, {user_flow_results: [], invalid_user_list: ['employee-1']}]) {
    const {client} = fixture({handle: call => call.url.includes('user_flows') && json({code: 0, data})});
    await assert.rejects(client.readWindow(window), FeishuClientError);
  }
  await rejects(fixture({handle: call => call.url.includes('user_approvals') && json({code: 0, data: {}})}).client.readWindow(window), 'invalid_response');
});

test('out-of-window facts, malformed punch seconds and malformed leave times fail the complete window', async () => {
  for (const check_time of ['NaN', '1.5', '2026-11-23', String(Date.parse('2026-11-24T16:00:00Z') / 1000)]) {
    await rejects(fixture({flows: [punch({check_time})]}).client.readWindow(window), 'invalid_response');
  }
  for (const extra of [{date: '20261125'}, {date: '20261301'}, {leaves: 'bad'}, {leaves: [leave({start_time: '2026-11-31 09:00:00'})]}, {leaves: [leave({start_time: '2026-11-23 19:00:00'})]}]) {
    await rejects(fixture({approved: [approval(extra)]}).client.readWindow(window), 'invalid_response');
  }
});

test('DST ambiguous and nonexistent naive leave times are rejected rather than guessed', async () => {
  for (const [date, from, to, start_time, end_time] of [
    ['20261101', '2026-11-01', '2026-11-02', '2026-11-01 01:30:00', '2026-11-01 03:30:00'],
    ['20260308', '2026-03-08', '2026-03-09', '2026-03-08 02:30:00', '2026-03-08 04:30:00'],
  ]) {
    const {client} = fixture({approved: [approval({date, time_zone: 'America/New_York', leaves: [leave({start_time, end_time})]})]});
    await rejects(client.readWindow({...window, timezone: 'America/New_York', from, to}), 'ambiguous_time');
  }
});

test('local midnight request boundaries preserve the actual 25-hour fall-back day', async () => {
  const {client, calls} = fixture();
  await client.readWindow({...window, timezone: 'America/New_York', from: '2026-11-01', to: '2026-11-01'});
  assert.equal(Number(calls[1].body.check_time_to) - Number(calls[1].body.check_time_from), 25 * 3600);
});

test('invalid configuration and invalid identity/date/range reject before any network request', async () => {
  assert.throws(() => createFeishuClient({appId: 'cli', appSecret: ''}), FeishuClientError);
  const {client, calls} = fixture();
  for (const change of [{externalUserId: ''}, {idType: 'open_id'}, {from: '2026-02-30'}, {from: '2026-11-25', to: '2026-11-24'}, {from: '2026-11-17'}, {timezone: 'not-a-time-zone'}, {timezone: '+08:00'}, {from: '2026-11-26', to: '2026-11-26'}]) {
    await rejects(client.readWindow({...window, ...change}), 'input');
  }
  await rejects(client.readLeaveWindow({...window, from: '2026-11-24', to: '2026-12-24'}), 'input');
  assert.equal(calls.length, 0);
});

test('employee_no is preserved and encoded in all endpoint requests', async () => {
  const {client, calls} = fixture();
  await client.readWindow({...window, idType: 'employee_no', externalUserId: 'EMP-001'});
  for (const call of calls.slice(1)) {
    assert.equal(new URL(call.url).searchParams.get('employee_type'), 'employee_no');
    assert.deepEqual(call.body.user_ids, ['EMP-001']);
  }
});

test('transient 429/5xx retry with a bounded Retry-After, while ordinary errors do not retry', async () => {
  let count = 0;
  const transient = fixture({handle: call => {
    if (!call.url.includes('user_flows')) return;
    count++;
    if (count === 1) return json({msg: credentials.appSecret}, 429, {'Retry-After': '500'});
    if (count === 2) return json({msg: credentials.appSecret}, 503);
  }});
  await transient.client.readWindow(window);
  assert.equal(count, 3); assert.deepEqual(transient.sleeps, [2000, 500]);
  count = 0;
  const failed = fixture({handle: call => { if (call.url.includes('user_flows')) { count++; return json({msg: credentials.appSecret}, 400); } }});
  await rejects(failed.client.readWindow(window), 'upstream');
  assert.equal(count, 1);
});

test('token expiry refreshes once on HTTP 401 or documented invalid tenant token code', async () => {
  for (const response of [() => json({}, 401), () => json({code: 99991663, msg: 'expired'})]) {
    let count = 0;
    const {client, calls} = fixture({handle: call => { if (call.url.includes('user_flows') && ++count === 1) return response(); }});
    await client.readWindow(window);
    assert.equal(calls.filter(c => c.url.includes('/token')).length, 2);
    assert.equal(count, 2);
  }
  const {client, calls} = fixture({handle: call => call.url.includes('user_flows') && json({code: 99991663, msg: credentials.appSecret})});
  await rejects(client.readWindow(window), 'authentication');
  assert.equal(calls.filter(c => c.url.includes('user_flows')).length, 2);
});

test('scope and employee visibility errors fail without refreshing or consuming a partial successful leave response', async () => {
  for (const code of [1220004, 1220005, 99991672, 99991676]) {
    const {client, calls} = fixture({approved: [approval()], handle: call => call.body.status === 4 && json({code, msg: credentials.appSecret})});
    await rejects(client.readWindow(window), 'permission');
    assert.equal(calls.filter(c => c.url.includes('/token')).length, 1);
  }
});

test('redirects, malformed bodies, oversized bodies, thrown errors and timeout fail safely without secrets', async () => {
  await rejects(fixture({handle: () => new Response(null, {status: 302, headers: {Location: 'https://example.invalid'}})}).client.testConnection(), 'redirect');
  await rejects(fixture({handle: () => new Response(credentials.appSecret)}).client.testConnection(), 'invalid_response');
  await rejects(fixture({options: {maxResponseBytes: 20}}).client.testConnection(), 'invalid_response');
  await rejects(fixture({handle: () => { throw new Error(credentials.appSecret); }}).client.testConnection(), 'upstream');
  await rejects(fixture({options: {timeoutMs: 5}, handle: () => new Promise(() => {})}).client.testConnection(), 'timeout');
});

test('malformed or legacy token response cannot be mistaken for successful authentication', async () => {
  for (const token of [{code: 0, tenant_access_token: 'legacy', expire: 7200}, tokenBody({expires_in: 0}), tokenBody({token_type: 42}), tokenBody({access_token: ''})]) {
    await rejects(fixture({token}).client.testConnection(), 'invalid_response');
  }
  await rejects(fixture({token: {code: 20063, msg: credentials.appSecret}}).client.testConnection(), 'authentication');
});
