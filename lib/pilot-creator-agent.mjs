import {financialRates} from './finance-periods.mjs';

const DAY = 86400000;
const parse = value => typeof value === 'string' ? JSON.parse(value || '{}') : value || {};
const rows = async (db, sql, args = []) => (await db.prepare(sql).bind(...args).all()).results || [];
const day = value => new Date(+new Date(value) + 7 * 3600000).toISOString().slice(0, 10);
const validDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const validInstant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const validUrl = value => { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; } };
const validCount = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const advanceDay = (value, count) => new Date(Date.parse(value + 'T00:00:00Z') + count * DAY).toISOString().slice(0, 10);

export function creatorPilotWeek(config = {}, now = new Date()) {
  const start = config.weekly?.start || config.weekFrom, end = config.weekly?.end || config.weekTo;
  if (start || end) {
    if (!validDay(start) || !validDay(end) || end < start || (Date.parse(end) - Date.parse(start)) / DAY > 6) throw new Error('达人周报须提供有效的七日内起止日期');
    return {start, end};
  }
  const today = day(now), weekday = new Date(today + 'T00:00:00Z').getUTCDay();
  const monday = advanceDay(today, -((weekday + 6) % 7));
  return {start: advanceDay(monday, -7), end: advanceDay(monday, -1)};
}

// This adapter deliberately reads a single creator_scopes primary key. Names,
// actor ids and country/channel alone are never treated as a store boundary.
// No recipient contact details, images, or credentials enter the agent context.
export async function loadCreatorPilotData(db, config, now = new Date()) {
  const scopeId = config?.creatorScopeId;
  if (!scopeId) return {scope: null, rounds: [], coverage: {complete: false, authoritative: false, reason: '尚未绑定唯一的印尼 TikTok 店铺'}};
  const scope = await db.prepare('SELECT id,site,platform,shop,operator_id,backup_id,bd_id,version FROM creator_scopes WHERE id=?').bind(scopeId).first();
  if (!scope || scope.site !== '印尼' || scope.platform !== 'TikTok' || config.shopId && config.shopId !== scope.id) return {scope: null, rounds: [], coverage: {complete: false, authoritative: false, reason: '试点店铺不存在或店铺范围不一致'}};
  const clock = await db.prepare("SELECT version FROM creator_clock WHERE id='global'").first();
  const selected = `SELECT r.id FROM creator_rounds r JOIN creator_profiles p ON p.id=r.creator_id WHERE p.scope_id=?`;
  const [rounds, orders, shipments, receipts, contents, observations, costs, users] = await Promise.all([
    rows(db, `SELECT r.id,r.round_no,r.status,r.terms_json,r.original_due_at,r.effective_due_at,r.approved_at,r.completed_at,r.version,r.test_archived_at,
      p.id creator_id,p.name creator_name,p.state creator_state,p.deleted_at,p.owner_bd_id
      FROM creator_rounds r JOIN creator_profiles p ON p.id=r.creator_id WHERE p.scope_id=?`, [scopeId]),
    rows(db, `SELECT id,order_no,round_id,scope_id,status,agreement_ref,signed_on,terms_json FROM marketing_sample_orders WHERE scope_id=?`, [scopeId]),
    rows(db, `SELECT s.id,s.order_id,s.shipment_no,s.business_date,s.shipped_at,s.items_json FROM marketing_sample_shipments s JOIN marketing_sample_orders o ON o.id=s.order_id WHERE o.scope_id=?`, [scopeId]),
    rows(db, `SELECT r.id,r.shipment_id,r.order_id,r.received_at,r.proof_ref FROM marketing_sample_receipts r JOIN marketing_sample_orders o ON o.id=r.order_id WHERE o.scope_id=?`, [scopeId]),
    rows(db, `SELECT id,round_id,kind,url,published_at,status,created_at FROM creator_contents WHERE round_id IN (${selected})`, [scopeId]),
    rows(db, `SELECT o.id,o.content_id,o.window_days,o.revision,o.observed_at,o.data_json,o.created_at FROM creator_observations o JOIN creator_contents c ON c.id=o.content_id WHERE c.round_id IN (${selected}) AND o.revision=(SELECT MAX(x.revision) FROM creator_observations x WHERE x.content_id=o.content_id AND x.window_days=o.window_days)`, [scopeId]),
    rows(db, `SELECT c.id,c.order_id,c.shipment_id,c.kind,c.revision,c.business_date,c.currency,c.amount_minor,c.source_ref,c.evidence FROM marketing_sample_costs c JOIN marketing_sample_orders o ON o.id=c.order_id WHERE o.scope_id=? AND c.revision=(SELECT MAX(x.revision) FROM marketing_sample_costs x WHERE x.shipment_id=c.shipment_id AND x.kind=c.kind)`, [scopeId]),
    rows(db, `SELECT u.id,COALESCE(b.display_name,u.name) name,u.role,u.active FROM users u LEFT JOIN creator_bd_names b ON b.user_id=u.id WHERE u.id=? OR u.id IN (SELECT owner_bd_id FROM creator_profiles WHERE scope_id=?)`, [scope.bd_id, scopeId])
  ]);
  const rateMap = {};
  for (const month of new Set(costs.map(c => c.business_date.slice(0, 7)))) rateMap[month] = await financialRates(db, month);
  const finalClock = await db.prepare("SELECT version FROM creator_clock WHERE id='global'").first();
  if ((clock?.version || 0) !== (finalClock?.version || 0)) throw new Error('达人履约依据正在更新，本轮巡检未覆盖旧待办，请重试');
  return {scope, rounds, orders, shipments, receipts, contents, observations, costs, users, rateMap, generatedAt: now.toISOString(),
    coverage: {complete: true, authoritative: true, creatorClock: finalClock?.version || 0, scopeId, shop: scope.shop}};
}

function sampleReceipt(orders, shipments, receipts, now) {
  const live = orders.filter(o => !['cancelled', 'rejected'].includes(o.status));
  const shipped = shipments.filter(s => live.some(o => o.id === s.order_id));
  const received = shipped.map(s => receipts.find(r => r.shipment_id === s.id && r.order_id === s.order_id && validInstant(r.received_at) && Date.parse(r.received_at) <= +now && Date.parse(r.received_at) >= Date.parse(s.shipped_at)));
  return {orders: live, shipments: shipped, receipts: received.filter(Boolean), complete: !!live.length && live.every(o => ['received', 'closed'].includes(o.status)) && !!shipped.length && received.every(Boolean)};
}

function costMetric(kind, data, week, now) {
  const orderIds = new Set((data.orders || []).map(o => o.id));
  const allShips = (data.shipments || []).filter(s => orderIds.has(s.order_id) && validInstant(s.shipped_at) && Date.parse(s.shipped_at) <= +now);
  const ships = allShips.filter(s => s.business_date >= week.start && s.business_date <= week.end);
  const latest = new Map();
  for (const c of data.costs || []) {
    if (c.kind !== kind || !orderIds.has(c.order_id) || !allShips.some(s => s.id === c.shipment_id && s.order_id === c.order_id)) continue;
    const old = latest.get(c.shipment_id);
    if (!old || c.revision > old.revision) latest.set(c.shipment_id, c);
  }
  const lines = [...latest.values()].filter(c => c.business_date >= week.start && c.business_date <= week.end && validCount(c.amount_minor)).map(c => {
    const rate = c.currency === 'CNY' ? {rate: 1, id: 'CNY-1'} : data.rateMap?.[c.business_date.slice(0, 7)]?.[c.currency];
    const rateValue = Number(rate?.rate);
    return {id: c.id, shipmentId: c.shipment_id, currency: c.currency, amountMinor: c.amount_minor, businessDate: c.business_date, source: c.source_ref, evidence: c.evidence,
      cnyMinor: Number.isFinite(rateValue) && rateValue > 0 ? Math.round(c.amount_minor * rateValue) : null, rate: Number.isFinite(rateValue) && rateValue > 0 ? rateValue : null, rateId: rate?.id || null};
  });
  const missingShipments = ships.filter(s => { const c = latest.get(s.id); return !c || !validCount(c.amount_minor) || c.business_date > week.end; });
  const currencies = {};
  for (const line of lines) currencies[line.currency] = (currencies[line.currency] || 0) + line.amountMinor;
  const known = lines.filter(l => l.cnyMinor != null);
  return {lines, currencies, knownCnyMinor: known.length ? known.reduce((n, l) => n + l.cnyMinor, 0) : null,
    missingRateCount: lines.length - known.length, pendingShipmentCount: missingShipments.length, pendingShipmentIds: missingShipments.map(s => s.id),
    shipmentCount: ships.length, method: '按财务核定费用业务日统计最新修订，原币分列；样品成本与运费分开。未核或缺汇率不作零，也不记销售收入。'};
}

// Read-only deterministic facts -> internal findings + an unsent Indonesian draft.
// Persistence, permissions, review audit and scheduling are owned by the caller.
export function evaluateCreatorPilot(data, config = {}, now = new Date()) {
  const week = creatorPilotWeek(config, now), findings = [];
  if (!data?.coverage?.complete || !data.coverage.authoritative || !data.scope || data.scope.id !== config.creatorScopeId || config.shopId && data.scope.id !== config.shopId || data.scope.site !== '印尼' || data.scope.platform !== 'TikTok') {
    return {findings, metrics: null, coverage: {...data?.coverage, complete: false, authoritative: false, reason: data?.coverage?.reason || '店铺依据尚未核对'}};
  }
  const today = day(now), reviewDate = advanceDay(today, 1), cohorts = [], linkedVideos = [];
  const allOrders = (data.orders || []).filter(o => o.scope_id === data.scope.id);
  for (const round of data.rounds || []) {
    const orders = allOrders.filter(o => o.round_id === round.id);
    if (!orders.length) continue; // Pilot follows actual sample orders, not every creator.
    const terms = parse(round.terms_json), receipt = sampleReceipt(orders, data.shipments || [], data.receipts || [], now);
    const owner = (data.users || []).find(u => u.id === (round.owner_bd_id || data.scope.bd_id) && u.active === 1 && u.role === '达人BD');
    const videos = (data.contents || []).filter(c => c.round_id === round.id && c.kind === 'video' && ['pending', 'accepted'].includes(c.status) && validUrl(c.url) && validInstant(c.published_at) && Date.parse(c.published_at) <= +now);
    const promised = Number(terms.videos), dueValid = validInstant(round.effective_due_at), dueAt = dueValid ? round.effective_due_at : null;
    const cancelled = ['cancelled', 'draft', 'pending'].includes(round.status) || round.test_archived_at || round.deleted_at || round.creator_state === 'paused' || !round.approved_at || !receipt.orders.length;
    const required = terms.sampleOnly !== true && validCount(promised) && promised > 0;
    const url = '/?page=marketing-samples&entity=' + encodeURIComponent(receipt.orders[0]?.id || orders[0].id);
    const evidence = [
      {label: '寄样单', value: orders.map(o => o.order_no).join('、'), source: 'marketing_sample_orders:' + orders.map(o => o.id).join(','), url},
      {label: '约定交片时间', value: dueAt || '尚未确认', source: 'creator_rounds:' + round.id + ':effective_due_at', at: dueAt},
      {label: '实际签收', value: receipt.complete ? receipt.receipts.map(r => r.received_at).join('、') : '全部实发批次尚未确认签收', source: 'marketing_sample_receipts:' + receipt.receipts.map(r => r.id).join(',')},
      {label: '已关联视频', value: videos.length, source: 'creator_contents:' + videos.map(v => v.id).join(',')}
    ];
    for (const v of videos) evidence.push({label: v.status === 'accepted' ? '已验收视频' : '已关联、待验收视频', value: v.url, url: v.url, source: 'creator_contents:' + v.id, at: v.published_at});
    let state = 'clear', impact = '尚未达到催拍条件。', title = '跟进达人交片';
    if (cancelled) impact = '合作已暂停、终止或不在执行范围，停止催拍。';
    else if (!required) impact = '本合作未约定视频交付，不生成视频催拍。';
    else if (videos.length) impact = '视频已关联，停止催拍；内容验收仍由原履约流程处理。';
    else if (!receipt.complete) impact = '寄样单尚未全部签收，先由原物流流程核对，不催拍。';
    else if (!dueValid) { state = 'unknown'; title = '核对约定交片日期'; impact = '交片日期缺失或无效，无法判定逾期；BD 核对协议后再巡检。'; }
    else if (!owner) { state = 'unknown'; title = '核对达人履约负责人'; impact = '没有有效的负责 BD 账号，先补齐责任人，暂不生成对外催拍草稿。'; }
    else if (Date.parse(dueAt) < +now) { state = 'active'; title = '跟进逾期未交片'; impact = '样品已签收且约定交片时间已过，仍无关联视频；请 BD 核实履约并确认催拍草稿。'; }
    else impact = '尚未到约定交片时间，无需催拍。';
    const finding = {key: 'creator:' + round.id, kind: 'creator_delivery', title, state, evidence, impact,
      ownerId: owner?.id || null, ownerName: owner?.name || '待指定 BD', ownerRole: '达人BD', reviewDate,
      priority: state === 'active' ? 'high' : 'medium', roundId: round.id, sampleOrderIds: orders.map(o=>o.id), creatorId: round.creator_id, dueAt, shopId: data.scope.id,
      sourceUrl: url, closedReason: state === 'clear' ? videos.length ? 'video_linked' : cancelled ? 'cooperation_inactive' : !required ? 'no_video_obligation' : !receipt.complete ? 'receipt_pending' : 'not_due' : null};
    if (state === 'active') {
      const formattedDue = new Intl.DateTimeFormat('id-ID', {timeZone: 'Asia/Jakarta', dateStyle: 'long', timeStyle: 'short'}).format(new Date(dueAt));
      finding.draft = {language: 'id', text: `Halo Kak ${String(round.creator_name || '').replace(/[\r\n]/g, ' ').slice(0, 100)}, semoga kabarnya baik! Sampel untuk kerja sama ${round.round_no} sudah tercatat diterima. Sesuai kesepakatan, jadwal pengiriman video adalah ${formattedDue} WIB. Kami belum menemukan tautan videonya di catatan kami. Kalau sudah tayang, boleh kirim tautannya? Jika ada kendala, kabari kami agar bisa dibicarakan bersama. Terima kasih, Kak!`, reviewRequired: true};
    }
    findings.push(finding);
    const asOfEnd = Math.min(+now, Date.parse(week.end + 'T23:59:59.999+07:00'));
    if (!cancelled && required && receipt.complete && receipt.receipts.every(r => Date.parse(r.received_at) <= asOfEnd) && dueValid && day(dueAt) >= week.start && day(dueAt) <= week.end && Date.parse(dueAt) <= +now) {
      const byCutoff = videos.filter(c => Date.parse(c.created_at) <= asOfEnd);
      cohorts.push({roundId: round.id, dueAt, promised, linked: byCutoff.length, accepted: byCutoff.filter(c => c.status === 'accepted').length});
      linkedVideos.push(...byCutoff);
    }
  }
  const rate = (numerator, denominator, method) => ({numerator, denominator, value: denominator ? numerator / denominator : null, method});
  const orderLines = [];
  for (const content of new Map(linkedVideos.map(v => [v.id, v])).values()) {
    const latest = new Map();
    for (const observation of data.observations || []) {
      if (observation.content_id !== content.id || ![7, 30].includes(observation.window_days)) continue;
      const previous = latest.get(observation.window_days);
      if (!previous || observation.revision > previous.revision) latest.set(observation.window_days, observation);
    }
    const available = [...latest.values()].filter(o => validInstant(o.observed_at) && Date.parse(o.observed_at) <= +now && Date.parse(o.observed_at) >= Date.parse(content.published_at) + o.window_days * DAY).sort((a, b) => b.window_days - a.window_days);
    const selected = available[0], values = selected ? parse(selected.data_json) : {};
    orderLines.push({contentId: content.id, url: content.url, orders: validCount(values.orders) ? values.orders : null, windowDays: selected?.window_days || null, publishedAt: content.published_at, observedAt: selected?.observed_at || null,
      source: selected ? 'creator_observations:' + selected.id : 'creator_contents:' + content.id, evidence: values.evidence || '', basis: '运营/BD 录入的单视频归因观察，非财务核验利润'});
  }
  const knownOrderLines = orderLines.filter(l => l.orders != null);
  const weeklyLines = knownOrderLines.filter(l => day(l.publishedAt) >= week.start && day(l.observedAt) <= week.end);
  const scopedData = {...data, orders: allOrders};
  return {findings, coverage: {...data.coverage, sampleOrders: allOrders.length, trackedRounds: findings.length, unknownCount: findings.filter(f => f.state === 'unknown').length},
    metrics: {week, dueRounds: cohorts, deliveryRate: rate(cohorts.filter(r => r.linked >= r.promised).length, cohorts.length, '本周到期且实际签收的约定视频合作轮次为分母；周末前已关联足量视频为交片，非验收。'),
      acceptedDeliveryRate: rate(cohorts.filter(r => r.accepted >= r.promised).length, cohorts.length, '同一到期轮次分母，按当前已验收足量视频计算，验收状态可能晚于周末。'),
      orders: {knownTotal: knownOrderLines.length ? knownOrderLines.reduce((n, l) => n + l.orders, 0) : null, missingVideos: orderLines.length - knownOrderLines.length, lines: orderLines,
        method: '本周到期轮次关联视频，各视频取最新最长成熟观察窗口的累计归因订单；不叠加 7/30 天窗口，不等于本周销量。'},
      weeklyOrders: {knownTotal: weeklyLines.length ? weeklyLines.reduce((n, l) => n + l.orders, 0) : null, includedVideos: weeklyLines.length, excludedVideos: orderLines.length - weeklyLines.length, method: '仅统计发布时间到取数时间整个区间均在本周的观察，跨周累计不拆分。'},
      sampleCosts: costMetric('sample', scopedData, week, now), freightCosts: costMetric('freight', scopedData, week, now)}};
}
