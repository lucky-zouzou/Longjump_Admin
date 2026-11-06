import { assertWritable, atomicBatch, guardStatement } from './atomic.mjs';
import { normalizedSku, normalizeProfile, profileMissing, profileMeasurements, profileFail, profileFields } from './product-information-model.mjs';
export const profileHash = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))).map(n => n.toString(16).padStart(2, '0')).join('');
const list = async (db, sql, values = []) => (await db.prepare(sql).bind(...values).all()).results;
const json = text => JSON.parse(text || '{}');
export async function profileAccess(db, actor, write = false) {
    if (!actor || !['管理员', '供应链', '财务'].includes(actor.role) || write && !['管理员', '供应链'].includes(actor.role))
        profileFail('商品资料由管理员、供应链维护，财务可查看', 403);
    const live = await db.prepare('SELECT role,active FROM users WHERE id=?').bind(actor.id).first();
    if (!live || live.active !== 1 || live.role !== actor.role)
        profileFail('账号权限已变化，请重新登录', 403);
    return { canWrite: ['管理员', '供应链'].includes(actor.role) };
}
export async function readProductInformation(db, actor, sku) {
    const access = await profileAccess(db, actor);
    if (sku) {
        const profile = await db.prepare('SELECT * FROM product_profiles WHERE sku=?').bind(sku).first();
        const history = await list(db, 'SELECT * FROM product_profile_history WHERE sku=? ORDER BY version DESC LIMIT 100', [sku]);
        const costs = await list(db, 'SELECT site,purchase,freight,total,basis,effective_date,version FROM product_cost_versions WHERE sku=? ORDER BY effective_date DESC,version DESC', [sku]);
        const files = await list(db, 'SELECT id,name,size,created_at,actor_name FROM product_profile_files WHERE sku=? ORDER BY created_at DESC', [sku]);
        return { ...access, profile: profile ? { ...profile, data: json(profile.data_json), source: json(profile.source_json), references: JSON.parse(profile.cost_references_json) } : null, history: history.map(h => ({ ...h, data: json(h.data_json), source: json(h.source_json) })), costs, files };
    }
    const rows = await list(db, `SELECT s.sku,s.name,s.product_series,s.supplier_name,s.factory_name,s.carton_qty,s.unit_volume_cbm,
    p.version,p.data_json,p.updated_at,p.actor_name,
    (SELECT id FROM product_profile_files f WHERE f.sku=s.sku ORDER BY created_at DESC LIMIT 1) image_id
    FROM sku_settings s LEFT JOIN product_profiles p ON p.sku=s.sku ORDER BY s.sku`);
    return { ...access, rows: rows.map(row => {
            const data = json(row.data_json);
            return { ...row, data_json: undefined, data, missing: profileMissing(data), measurements: profileMeasurements(data) };
        }) };
}
function sourceInfo(payload, row) {
    const name = String(payload.fileName || '手动维护').trim();
    if (name.length > 240)
        profileFail('文件名过长');
    const sources = row.sources ?? [];
    if (!Array.isArray(sources) || sources.length > 10)
        profileFail('资料来源格式无效');
    return { fileName: name, sources: sources.map(s => ({ sheet: String(s.sheet || '').slice(0, 100), row: Number(s.row) || null })), units: { dimensions: 'cm', weight: 'kg', volume: 'm3', cost: 'CNY/件' } };
}
function costReferences(row, source, previous) {
    if (row.references == null)
        return previous;
    if (!Array.isArray(row.references) || row.references.length > 30)
        profileFail('成本参考行过多');
    const additions = row.references.map(ref => {
        if (!['印尼', '马来西亚', '泰国', '越南', '菲律宾'].includes(ref.site))
            profileFail('成本参考站点无效');
        const out = { site: ref.site, currency: 'CNY', state: 'pending', fileName: source.fileName, sheet: String(ref.source?.sheet || '').slice(0, 100), row: Number(ref.source?.row) || null };
        for (const key of ['purchase', 'freight', 'total']) {
            const value = ref[key];
            if (value == null || value === '')
                out[key] = null;
            else if (!['number', 'string'].includes(typeof value) || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1e8)
                profileFail('成本参考须为非负数字，未知请留空');
            else
                out[key] = Number(value);
        }
        return out;
    });
    // Re-imported source lines replace their pending reference. Prior values remain in revision history.
    const key = ref => [ref.fileName, ref.sheet, ref.row, ref.site].join('|');
    const combined = new Map(previous.map(ref => [key(ref), ref]));
    for (const ref of additions)
        combined.set(key(ref), ref);
    if (combined.size > 100)
        profileFail('该SKU成本参考过多，请财务整理后继续');
    return [...combined.values()];
}
export async function previewProductInformation(db, actor, payload) {
    await profileAccess(db, actor, true);
    if (payload.unitsConfirmed !== true)
        profileFail('请确认尺寸cm、重量kg、体积m³、成本CNY/件');
    if (!Array.isArray(payload.rows) || !payload.rows.length || payload.rows.length > 1000)
        profileFail('单次预览支持1至1000个SKU');
    if (payload.rows.some(row => !row || typeof row !== 'object' || Array.isArray(row)))
        profileFail('商品资料行格式无效');
    if (!['fill', 'replace'].includes(payload.mode))
        profileFail('请选择补充空缺或替换已填字段');
    const catalog = await list(db, 'SELECT * FROM sku_settings');
    const profiles = new Map((await list(db, 'SELECT * FROM product_profiles')).map(p => [p.sku, p]));
    const matches = new Map();
    for (const item of catalog) {
        const key = normalizedSku(item.sku);
        matches.set(key, [...(matches.get(key) || []), item]);
    }
    const results = [], seen = new Set();
    for (const row of payload.rows) {
        const key = normalizedSku(row.sku), matching = matches.get(key) || [];
        const result = { inputSku: key, sku: key, changes: [], warnings: Array.isArray(row.warnings) ? row.warnings.map(w => String(w).slice(0, 300)).slice(0, 30) : [] };
        try {
            if (!key || seen.has(key))
                profileFail('空SKU或同批重复SKU');
            seen.add(key);
            if (matching.length !== 1)
                profileFail(matching.length ? '系统SKU大小写存在歧义，请核对主数据' : '系统暂无此SKU，请先建档后重新匹配');
            const setting = matching[0], current = profiles.get(setting.sku), previous = json(current?.data_json);
            const incoming = normalizeProfile(row.data), merged = { ...previous };
            result.sku = setting.sku;
            for (const [field, value] of Object.entries(incoming)) {
                if (payload.mode === 'replace' || previous[field] == null || previous[field] === '')
                    merged[field] = value;
                else if (previous[field] !== value)
                    result.warnings.push(`${profileFields[field]}已有值，保留系统资料`);
            }
            const clearFields = row.clearFields ?? [];
            if (!Array.isArray(clearFields) || clearFields.some(key => !Object.hasOwn(profileFields, key)) || clearFields.length && payload.mode !== 'replace')
                profileFail('清除字段无效，请重新预览');
            for (const field of clearFields)
                delete merged[field];
            const data = normalizeProfile(merged), source = sourceInfo(payload, row);
            const references = costReferences(row, source, JSON.parse(current?.cost_references_json || '[]'));
            for (const field of Object.keys(profileFields))
                if (previous[field] !== data[field])
                    result.changes.push({ field: profileFields[field], before: previous[field] ?? null, after: data[field] ?? null });
            if (data.sourceName && data.sourceName !== setting.name)
                result.warnings.push('表内名称与系统商品名称有差异，系统商品名称需在主数据另行核对');
            const measurements = profileMeasurements(data);
            result.warnings.push(...measurements.warnings);
            const planning = { cartonQty: setting.carton_qty, unitVolumeCbm: setting.unit_volume_cbm };
            if (payload.syncPlanning === true && !measurements.warnings.length) {
                if (data.cartonQty)
                    planning.cartonQty = data.cartonQty;
                if (data.unitVolumeCbm)
                    planning.unitVolumeCbm = data.unitVolumeCbm;
                if (clearFields.includes('cartonQty'))
                    planning.cartonQty = 1;
                if (clearFields.includes('unitVolumeCbm'))
                    planning.unitVolumeCbm = 0;
            }
            for (const [field, before] of [['cartonQty', setting.carton_qty], ['unitVolumeCbm', setting.unit_volume_cbm]])
                if (planning[field] !== before)
                    result.changes.push({ field: '供应参数 · ' + profileFields[field], before, after: planning[field] });
            const changed = result.changes.length || JSON.stringify(references) !== (current?.cost_references_json || '[]');
            Object.assign(result, { status: changed ? 'ready' : 'unchanged', data, references, source, planning, version: current?.version || 0, setting: { updatedAt: setting.updated_at, cartonQty: setting.carton_qty, unitVolumeCbm: setting.unit_volume_cbm } });
            result.token = await profileHash(result);
        }
        catch (error) {
            result.status = 'issue';
            result.error = error.message;
        }
        results.push(result);
    }
    return { rows: results, ready: results.filter(r => r.status === 'ready').length, issues: results.filter(r => r.status === 'issue').length, unchanged: results.filter(r => r.status === 'unchanged').length };
}
export async function saveProductInformation(db, actor, payload) {
    await assertWritable(db);
    if (!Array.isArray(payload.rows) || payload.rows.length > 50)
        profileFail('每批保存最多50个SKU');
    if (typeof payload.reason !== 'string' || !payload.reason.trim() || payload.reason.length > 1000)
        profileFail('请填写资料维护依据（最多1000字）');
    const preview = await previewProductInformation(db, actor, payload);
    if (preview.issues)
        profileFail('本批存在未匹配或无效资料，请先处理', 409);
    const ready = preview.rows.filter(r => r.status === 'ready');
    if (!ready.length)
        return { ok: true, saved: 0, unchanged: preview.unchanged };
    for (const row of ready)
        if (payload.expected?.[row.sku] !== row.token)
            profileFail(`${row.sku}资料或预览内容已变化，请重新预览`, 409);
    const stamp = new Date().toISOString(), statements = [guardStatement(db, actor, 'product-profile.save', 'EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role=?) AND NOT EXISTS(SELECT 1 FROM system_maintenance WHERE id=\'global\' AND mode<>\'normal\' AND expires_at>?)', [actor.id, actor.role, stamp])];
    for (const row of ready) {
        const data = JSON.stringify(row.data), source = JSON.stringify(row.source), references = JSON.stringify(row.references), version = row.version + 1;
        statements.push(guardStatement(db, actor, 'product-profile.version', 'COALESCE((SELECT version FROM product_profiles WHERE sku=?),0)=? AND EXISTS(SELECT 1 FROM sku_settings WHERE sku=? AND updated_at=? AND carton_qty=? AND unit_volume_cbm=?)', [row.sku, row.version, row.sku, row.setting.updatedAt, row.setting.cartonQty, row.setting.unitVolumeCbm]));
        statements.push(db.prepare('INSERT INTO product_profiles(sku,version,data_json,source_json,cost_references_json,actor_id,actor_name,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(sku) DO UPDATE SET version=excluded.version,data_json=excluded.data_json,source_json=excluded.source_json,cost_references_json=excluded.cost_references_json,actor_id=excluded.actor_id,actor_name=excluded.actor_name,updated_at=excluded.updated_at').bind(row.sku, version, data, source, references, actor.id, actor.name, stamp));
        statements.push(db.prepare('INSERT INTO product_profile_history(id,sku,version,data_json,source_json,cost_references_json,reason,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(), row.sku, version, data, source, references, payload.reason.trim(), actor.id, actor.name, stamp));
        if (row.planning.cartonQty !== row.setting.cartonQty || row.planning.unitVolumeCbm !== row.setting.unitVolumeCbm)
            statements.push(db.prepare('UPDATE sku_settings SET carton_qty=?,unit_volume_cbm=?,updated_at=? WHERE sku=?').bind(row.planning.cartonQty, row.planning.unitVolumeCbm, stamp, row.sku));
        statements.push(db.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(), '维护商品资料', 'product_profile', row.sku, JSON.stringify({ version, changes: row.changes, source: row.source, costReferenceState: 'pending', reason: payload.reason }), actor.id, actor.name, stamp));
    }
    await atomicBatch(db, statements);
    return { ok: true, saved: ready.length, unchanged: preview.unchanged };
}
