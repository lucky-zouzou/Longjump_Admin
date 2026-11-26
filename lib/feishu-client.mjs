import {createHash} from 'node:crypto';

// Official API contracts: user_flow/query, user_approval/query and
// authentication-management/access-token/tenant_access_token on open.feishu.cn.
// This client only reads valid punch facts and approved/revoked attendance leave.
export const FEISHU_ATTENDANCE_SCOPE = 'attendance:task:readonly';
const TOKEN_URL = 'https://accounts.feishu.cn/oauth/v3/token';
const API_URL = 'https://open.feishu.cn/open-apis/attendance/v1/';
const DAY = 86400000;
const messages = {
  configuration: '飞书应用凭据尚未正确配置',
  input: '飞书同步范围、员工编号或时区无效',
  authentication: '飞书身份验证失败，请核对应用凭据和启用状态',
  permission: '飞书考勤读取权限或员工可见范围不足',
  upstream: '飞书暂时无法响应，请稍后重试',
  timeout: '飞书读取超时，本次窗口未完成',
  redirect: '飞书接口返回了不允许的重定向',
  invalid_response: '飞书返回的数据不完整或格式异常，本次窗口未完成',
  identity: '飞书返回的员工编号与映射不一致，本次窗口未完成',
  incomplete: '飞书返回了未完整读取的范围，本次窗口未完成',
  ambiguous_time: '飞书时间存在夏令时歧义或不存在的本地时刻，请核对后重试',
  conflict: '飞书来源编号重复或状态不一致，请核对后重试',
};

export class FeishuClientError extends Error {
  constructor(code, status = 502) {
    super(messages[code] || messages.upstream);
    this.name = 'FeishuClientError';
    this.code = `feishu_${code}`;
    this.status = status;
  }
}
const fail = (code, status) => { throw new FeishuClientError(code, status); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nonempty = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

function day(value, code = 'input') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(code, code === 'input' ? 400 : 502);
  const instant = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 10) !== value || value < '1000-01-01') fail(code, code === 'input' ? 400 : 502);
  return value;
}

function formatter(timezone, code = 'input') {
  if (typeof timezone !== 'string' || !timezone || timezone.length > 100 || /^[+-]/.test(timezone)) fail(code, code === 'input' ? 400 : 502);
  try {
    return new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});
  } catch { fail(code, code === 'input' ? 400 : 502); }
}

function localParts(timestamp, fmt) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(timestamp)).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

// Resolve naive attendance-group time without silently choosing either side of
// a DST fold or shifting a nonexistent time forward. Offsets are round-tripped.
function zonedTime(value, fmt) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) fail('invalid_response');
  day(value.slice(0, 10), 'invalid_response');
  const base = Date.parse(`${value.replace(' ', 'T')}Z`);
  if (!Number.isFinite(base) || new Date(base).toISOString().slice(0, 19).replace('T', ' ') !== value) fail('invalid_response');
  const offsets = new Set();
  for (let delta = -36; delta <= 36; delta += 6) {
    const probe = base + delta * 3600000;
    offsets.add(Date.parse(`${localParts(probe, fmt).replace(' ', 'T')}Z`) - probe);
  }
  const matches = [...offsets].map(offset => base - offset).filter(candidate => localParts(candidate, fmt) === value);
  if (matches.length !== 1) fail('ambiguous_time');
  return new Date(matches[0]).toISOString();
}

function incomplete(value) {
  if (!object(value)) return;
  // Neither selected endpoint is paginated. Never turn a partial response into
  // an authoritative empty window, including future additions to the contract.
  for (const [rawKey, item] of Object.entries(value)) {
    const key = rawKey.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
    if (key === 'has_more' && item !== false && item !== 0 && item != null) fail('incomplete');
    if (['page_token', 'next_page_token'].includes(key) && item) fail('incomplete');
    if (/^(invalid|unauthorized|unknown|not_found|failed)_user(s|_ids|_list|_id_list)?$/.test(key) && item != null && (!Array.isArray(item) || item.length)) fail('incomplete');
  }
}

function list(body, key) {
  incomplete(body);
  if (!object(body.data)) fail('invalid_response');
  incomplete(body.data);
  const rows = body.data[key];
  if (!Array.isArray(rows) || rows.length > 10000) fail('invalid_response');
  return rows;
}

function assertUser(row, userId) {
  if (!object(row)) fail('invalid_response');
  incomplete(row);
  if (row.user_id !== userId) fail('identity');
}

function source(kind, value, workDate, fallback) {
  if (value != null && value !== '') {
    if (!nonempty(value, 500)) fail('invalid_response');
    // Keep source identity independent of status and query window. Hashing also
    // bounds IDs without truncating distinct upstream identities into one.
    return {sourceId: `${kind}:${hash([value, workDate || ''])}`};
  }
  return {sourceId: `${kind}:weak:${hash(fallback)}`, weakIdentity: true};
}

function appendUnique(map, row) {
  const existing = map.get(row.sourceId);
  if (existing) {
    if (row.weakIdentity || existing.weakIdentity || JSON.stringify(existing) !== JSON.stringify(row)) fail('conflict');
    return;
  }
  if (map.size >= 10000) fail('incomplete');
  map.set(row.sourceId, row);
}

export function createFeishuClient({appId, appSecret} = {}, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
  maxRetries = 2,
  now = () => Date.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  maxResponseBytes = 4 * 1024 * 1024,
} = {}) {
  if (!nonempty(appId, 160) || !nonempty(appSecret, 4096)) fail('configuration', 503);
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof sleep !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 2 || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 8 * 1024 * 1024) fail('configuration', 503);
  let cachedToken = null;
  let tokenPending = null;

  async function fetchOnce(url, headers, body) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new FeishuClientError('timeout')); }, timeoutMs);
    });
    try {
      return await Promise.race([timeout, (async () => {
        const response = await fetchImpl(url, {method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'error', cache: 'no-store'});
        if (!response || !Number.isInteger(response.status)) fail('invalid_response');
        if (response.redirected || response.status >= 300 && response.status < 400) fail('redirect');
        const retryAfter = response.headers?.get?.('retry-after');
        if (response.status < 200 || response.status >= 300) {
          // No upstream error message or body is retained or included in errors.
          if (response.body?.cancel) await response.body.cancel();
          return {status: response.status, retryAfter};
        }
        const size = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(size) && size > maxResponseBytes) fail('invalid_response');
        if (!response.body?.getReader) fail('invalid_response');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = '', received = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            received += part.value.byteLength;
            if (received > maxResponseBytes) { await reader.cancel(); fail('invalid_response'); }
            text += decoder.decode(part.value, {stream: true});
          }
          text += decoder.decode();
        } finally { reader.releaseLock(); }
        let parsed;
        try { parsed = JSON.parse(text); } catch { fail('invalid_response'); }
        if (!object(parsed)) fail('invalid_response');
        return {status: response.status, body: parsed};
      })()]);
    } catch (error) {
      if (error instanceof FeishuClientError) throw error;
      // Fetch implementations can include request credentials in thrown errors.
      throw new FeishuClientError(controller.signal.aborted ? 'timeout' : 'upstream');
    } finally { clearTimeout(timer); }
  }

  async function request(url, headers, body) {
    for (let attempt = 0; ; attempt++) {
      const response = await fetchOnce(url, headers, body);
      if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
        const seconds = Number(response.retryAfter);
        const delay = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 2000) : 250 * 2 ** attempt;
        await sleep(delay);
        continue;
      }
      return response;
    }
  }

  async function token() {
    if (cachedToken && cachedToken.expiresAt > now()) return cachedToken;
    if (tokenPending) return tokenPending;
    tokenPending = (async () => {
      const startedAt = now();
      const response = await request(TOKEN_URL, {'Content-Type': 'application/json; charset=utf-8'}, {grant_type: 'client_credentials', client_id: appId, client_secret: appSecret});
      if (response.status === 429 || response.status >= 500) fail('upstream');
      if (response.status !== 200 || response.body.code !== 0) fail('authentication', 502);
      const data = response.body;
      if (!nonempty(data.access_token, 16384) || !Number.isInteger(data.expires_in) || data.expires_in <= 0 || data.expires_in > 86400 || typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer' || data.scope != null && typeof data.scope !== 'string') fail('invalid_response');
      const scopes = typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : null;
      cachedToken = {value: data.access_token, expiresAt: startedAt + data.expires_in * 1000 - Math.min(60000, data.expires_in * 100), scopes};
      return cachedToken;
    })();
    try { return await tokenPending; } finally { tokenPending = null; }
  }

  async function query(path, idType, body) {
    let credential = await token();
    for (let refresh = 0; ; refresh++) {
      const url = `${API_URL}${path}?employee_type=${encodeURIComponent(idType)}${path.startsWith('user_flows') ? '&include_terminated_user=false' : ''}`;
      const response = await request(url, {'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${credential.value}`}, body);
      const code = response.body?.code;
      if (response.status === 401 || [99991663, 99991665].includes(code)) {
        if (refresh >= 1) fail('authentication');
        if (cachedToken?.value === credential.value) cachedToken = null;
        credential = await token();
        continue;
      }
      if (response.status === 403 || [1220004, 1220005, 99991672, 99991676, 99991679].includes(code)) fail('permission');
      if (response.status < 200 || response.status >= 300) fail('upstream');
      if (code !== 0) fail('invalid_response');
      return response.body;
    }
  }

  function validateWindow({externalUserId, idType = 'employee_id', timezone = 'UTC', from, to} = {}, maxDays = 7) {
    if (!nonempty(externalUserId, 160) || !['employee_id', 'employee_no'].includes(idType)) fail('input', 400);
    day(from); day(to);
    if (from > to || Date.parse(to) - Date.parse(from) > (maxDays - 1) * DAY) fail('input', 400);
    const fmt = formatter(timezone);
    // The approval endpoint rejects a start date later than today + 1. Its
    // calendar has no timezone parameter; UTC + 1 is the conservative boundary.
    if (from > new Date(now() + DAY).toISOString().slice(0, 10)) fail('input', 400);
    return {externalUserId, idType, timezone, from, to, fmt};
  }

  async function readLeaveWindow(options) {
    const {externalUserId, idType, from, to} = validateWindow(options, 30);
    const leave = new Map(), identities = new Map();
    for (const [status, normalizedStatus] of [[2, 'approved'], [4, 'revoked']]) {
      const approvals = await query('user_approvals/query', idType, {user_ids: [externalUserId], check_date_from: Number(from.replaceAll('-', '')), check_date_to: Number(to.replaceAll('-', '')), check_date_type: 'PeriodTime', status});
      for (const row of list(approvals, 'user_approvals')) {
        assertUser(row, externalUserId);
        if (typeof row.date !== 'string' || !/^\d{8}$/.test(row.date)) fail('invalid_response');
        const workDate = day(`${row.date.slice(0, 4)}-${row.date.slice(4, 6)}-${row.date.slice(6, 8)}`, 'invalid_response');
        if (workDate < from || workDate > to) fail('invalid_response');
        // SDK UserApproval.time_zone: absent/empty means zero timezone (UTC),
        // not the employee's local workplace timezone.
        const sourceFmt = formatter(row.time_zone == null || row.time_zone === '' ? 'UTC' : row.time_zone, 'invalid_response');
        if (row.leaves != null && !Array.isArray(row.leaves) || row.leaves?.length > 10000) fail('invalid_response');
        for (const item of row.leaves || []) {
          if (!object(item)) fail('invalid_response');
          incomplete(item);
          const startAt = zonedTime(item.start_time, sourceFmt), endAt = zonedTime(item.end_time, sourceFmt);
          if (startAt >= endAt) fail('invalid_response');
          // date is the upstream approval-effect workday. A night shift may
          // assign next-morning leave to the previous workday; do not recalculate
          // that ownership from the interval's calendar dates.
          for (const id of [item.idempotent_id, item.approval_id]) if (id != null && id !== '' && !nonempty(id, 500)) fail('invalid_response');
          const identity = item.idempotent_id || item.approval_id;
          const identityKind = item.idempotent_id ? 'leave-idempotent' : item.approval_id ? 'leave-approval' : 'leave';
          const record = {...source(identityKind, identity, workDate, [externalUserId, workDate, startAt, endAt]), externalUserId, workDate, status: normalizedStatus, startAt, endAt};
          const signature = JSON.stringify([item.idempotent_id || '', item.approval_id || '']);
          if (identities.has(record.sourceId) && identities.get(record.sourceId) !== signature) fail('conflict');
          identities.set(record.sourceId, signature);
          appendUnique(leave, record);
        }
      }
    }
    return [...leave.values()];
  }

  return {
    async testConnection() {
      const credential = await token();
      return {
        authenticated: true,
        attendanceScope: credential.scopes === null ? 'unverified' : credential.scopes.includes(FEISHU_ATTENDANCE_SCOPE) ? 'confirmed' : 'missing',
        grantedScopes: credential.scopes || [],
      };
    },
    readLeaveWindow,
    async readWindow(options) {
      const {externalUserId, idType, from, to, fmt} = validateWindow(options);
      const until = new Date(Date.parse(`${to}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
      const start = Date.parse(zonedTime(`${from} 00:00:00`, fmt));
      const end = Date.parse(zonedTime(`${until} 00:00:00`, fmt));
      const flows = await query('user_flows/query', idType, {user_ids: [externalUserId], check_time_from: String(start / 1000), check_time_to: String(end / 1000)});
      const attendance = new Map();
      for (const row of list(flows, 'user_flow_results')) {
        assertUser(row, externalUserId);
        if (typeof row.check_time !== 'string' || !/^\d{1,12}$/.test(row.check_time)) fail('invalid_response');
        const stamp = Number(row.check_time) * 1000;
        if (!Number.isSafeInteger(stamp) || stamp < start || stamp >= end) fail('invalid_response');
        const punchedAt = new Date(stamp).toISOString(), workDate = localParts(stamp, fmt).slice(0, 10);
        appendUnique(attendance, {...source('flow', row.record_id, '', [externalUserId, punchedAt]), externalUserId, workDate, status: 'recorded', punchedAt});
      }
      const leave = await readLeaveWindow(options);
      return {attendance: [...attendance.values()], leave};
    },
  };
}
