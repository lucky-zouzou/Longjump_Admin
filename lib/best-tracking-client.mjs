import {createHash} from 'node:crypto';

export class TrackingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function normalizeWaybill(value) {
  const no = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{4,49}$/.test(no)) throw new TrackingError(400, '请输入有效的百世运单号');
  return no;
}

const short = (value, max = 100) => typeof value === 'string' ? value.trim().slice(0, max) : '';

function readGroup(group) {
  const events = new Map();
  for (const trace of group.Traces ?? []) {
    const timestamp = short(trace.Date);
    const at = /(?:Z|[+-]\d\d:\d\d)$/i.test(timestamp) && Number.isFinite(Date.parse(timestamp))
      ? new Date(timestamp).toISOString() : null;
    const kind = trace.Estimate === true ? 'estimate' : trace.Estimate === false ? 'actual' : 'unknown';
    const event = {at, kind, state:short(trace.StateType), description:short(trace.Desc || trace.EnDesc, 600)};
    events.set(JSON.stringify(event), event);
  }
  return {events:[...events.values()].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))};
}

export function trackingSnapshot(body, no) {
  if (body?.success !== true || !Array.isArray(body.data?.Items))
    throw new TrackingError(502, '百世未返回有效轨迹，请检查接口授权后重试');
  const matches = body.data.Items.filter(item => short(item?.No).toUpperCase() === no);
  if (!matches.length) throw new TrackingError(404, '百世未返回该运单，请核对运单号及所属客户账号');
  if (matches.length !== 1) throw new TrackingError(502, '百世返回多条相同运单，请核对后重试');
  const item = matches[0];
  return {
    country:short(item.ReceiverCountryCode, 8).toUpperCase(),
    status:short(item.StatusName || item.StatusCode),
    groups:(item.Groups ?? []).map(readGroup),
  };
}

export async function queryBestTracking(config, value, fetcher = fetch) {
  const no = normalizeWaybill(value);
  if (!config?.BEST_PARTNER_ID || !config?.BEST_API_SECRET)
    throw new TrackingError(503, '百世接口凭据尚未在服务器配置，请联系管理员');
  const body = JSON.stringify({nos:[no]});
  const sign = createHash('md5').update(body).update(config.BEST_API_SECRET).digest('hex');
  try {
    const response = await fetcher('https://stargate.800best.com/star-gate/bestApi/trackingQuery', {
      method:'POST', redirect:'error', signal:AbortSignal.timeout(12000),
      headers:{'Content-Type':'application/json',partnerId:config.BEST_PARTNER_ID,sign}, body,
    });
    if (!response.ok) throw new TrackingError(502, '百世查询失败，请稍后重试或核对接口授权');
    return trackingSnapshot(await response.json(), no);
  } catch (error) {
    if (error instanceof TrackingError) throw error;
    throw new TrackingError(502, '暂时无法读取百世轨迹，请稍后重试');
  }
}
