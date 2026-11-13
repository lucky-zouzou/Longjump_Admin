/* eslint-disable @next/next/no-img-element -- Authenticated original product images are served by the local API. */
'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { profileFields, profileNumericFields, profileMeasurements } from '../lib/product-information-model.mjs';
import { useDirtyGuard } from './workspace-hooks';
import './product-information.css';
// Imported spreadsheet rows and revision snapshots share named, validated fields.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
type Workbook = {
    rows: Row[];
    fileName: string;
    skippedSheets: string[];
    imagePaths: Map<string, string>;
    image: (id: string) => Promise<File | null>;
};
async function api(payload?: Row, sku?: string) {
    const response = await fetch('/api/product-information' + (sku ? '?sku=' + encodeURIComponent(sku) : ''), payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok)
        throw Error(data.error || '资料读取失败');
    return data;
}
async function upload(sku: string, file: File) {
    const form = new FormData();
    form.append('sku', sku);
    form.append('file', file);
    const response = await fetch('/api/product-information/files', { method: 'POST', body: form });
    const result = await response.json();
    if (!response.ok)
        throw Error(result.error || '图片上传失败');
    window.dispatchEvent(new Event('product-images-changed'));
    return result;
}
const display = (value: unknown) => value == null || value === '' ? '待补录' : typeof value === 'number' ? value.toLocaleString('zh-CN', { maximumFractionDigits: 8 }) : String(value);
const money = (value: unknown) => value == null ? '待核实' : Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 4 });
export default function ProductInformation() {
    const [catalog, setCatalog] = useState<Row | null>(null), [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
    const [query, setQuery] = useState(''), [missingOnly, setMissingOnly] = useState(false), [page, setPage] = useState(0);
    const [workbook, setWorkbook] = useState<Workbook | null>(null), [preview, setPreview] = useState<Row | null>(null), [units, setUnits] = useState(false), [mode, setMode] = useState('fill'), [syncPlanning, setSyncPlanning] = useState(true), [ack, setAck] = useState(false);
    const [selected, setSelected] = useState<Row | null>(null), [detail, setDetail] = useState<Row | null>(null), [form, setForm] = useState<Row>({}), [reason, setReason] = useState(''), [editing, setEditing] = useState(false), [manualPreview, setManualPreview] = useState<Row | null>(null), [quantity, setQuantity] = useState('');
    const [importPending, setImportPending] = useState(false);
    const detailPanel = useRef<HTMLElement | null>(null);
    const lock = useRef(false), selection = useRef(0);
    const leave = useDirtyGuard(editing || importPending || busy);
    useEffect(() => {
        if (detail)
            detailPanel.current?.scrollIntoView({ block: 'start' });
    }, [detail]);
    const load = useCallback(async () => {
        setCatalog(await api());
    }, []);
    useEffect(() => {
        let cancelled = false;
        api().then(value => {
            if (!cancelled)
                setCatalog(value);
        }).catch(e => {
            if (!cancelled)
                setError(e.message);
        });
        return () => {
            cancelled = true;
        };
    }, []);
    async function run(task: () => Promise<void>) {
        if (lock.current)
            return;
        lock.current = true;
        setBusy(true);
        setError('');
        setMessage('');
        try {
            await task();
        }
        catch (e) {
            setError((e as Error).message);
        }
        finally {
            lock.current = false;
            setBusy(false);
        }
    }
    const settings = { mode, unitsConfirmed: units, syncPlanning };
    function invalidate() {
        setPreview(null);
        setManualPreview(null);
        setAck(false);
    }
    async function open(row: Row) {
        if (editing && !leave())
            return;
        const ticket = ++selection.current;
        setSelected(row);
        setDetail(null);
        setEditing(false);
        setManualPreview(null);
        setQuantity('');
        try {
            const value = await api(undefined, row.sku);
            if (ticket === selection.current) {
                setDetail(value);
                setForm(value.profile?.data || {});
            }
        }
        catch (e) {
            setError((e as Error).message);
        }
    }
    async function importFile(file: File) {
        await run(async () => {
            setWorkbook(null);
            setImportPending(false);
            invalidate();
            const { readProductWorkbook } = await import('../lib/product-information-workbook.mjs');
            const parsed = await readProductWorkbook(file);
            setWorkbook(parsed);
            setImportPending(true);
            setMessage(`已读取 ${parsed.rows.length} 个SKU。请预览匹配结果。`);
        });
    }
    async function commit() {
        if (!workbook || !preview || !ack)
            return;
        await run(async () => {
            const valid = preview.rows.filter((row: Row) => row.status !== 'issue');
            let saved = 0, images = 0;
            const failures: string[] = [];
            for (let offset = 0; offset < valid.length; offset += 50) {
                const batch = valid.slice(offset, offset + 50), keys = new Set(batch.map((r: Row) => r.inputSku));
                const result = await api({ ...settings, action: 'save', fileName: workbook.fileName, reason: '按商品信息表匹配资料，成本待财务核定', rows: workbook.rows.filter(r => keys.has(r.sku)), expected: Object.fromEntries(batch.map((r: Row) => [r.sku, r.token])) });
                saved += result.saved;
                setMessage(`资料处理 ${Math.min(offset + 50, valid.length)} / ${valid.length}，新增修订 ${saved}`);
            }
            for (const row of valid) {
                const source = workbook.rows.find(r => r.sku === row.inputSku);
                for (const id of source?.imageIds || []) {
                    try {
                        const file = await workbook.image(id);
                        if (!file) {
                            failures.push(row.sku + ' 图片引用未找到');
                            continue;
                        }
                        await upload(row.sku, file);
                        images++;
                        setMessage(`商品资料已保存，图片核对 ${images} 张`);
                    }
                    catch (e) {
                        failures.push(row.sku + ' ' + (e as Error).message);
                    }
                }
            }
            await load();
            setPreview(await api({ ...settings, action: 'preview', fileName: workbook.fileName, rows: workbook.rows }));
            setMessage(`本次保存 ${saved} 个SKU资料，图片核对 ${images} 张。${preview.issues ? preview.issues + '个SKU需先处理匹配问题。' : ''}${failures.length ? '图片待重试 ' + failures.length + ' 项。再次执行可继续核对。' : ''}`);
            setImportPending(failures.length > 0 || preview.issues > 0);
            if (failures.length)
                setError(failures.slice(0, 12).join('；'));
        });
    }
    const rows = (catalog?.rows || []).filter((row: Row) => (!missingOnly || row.missing.length || !row.image_id) && [row.sku, row.name, row.product_series, row.supplier_name].some(v => String(v || '').toLowerCase().includes(query.toLowerCase())));
    const shown = rows.slice(page * 40, (page + 1) * 40), measurements = profileMeasurements(form), unitsLabel = '尺寸 cm · 重量 kg · 体积 m³ · 表内成本 CNY/件';
    const manualPayload = () => ({ action: 'preview', mode: 'replace', unitsConfirmed: units, syncPlanning, fileName: '供应链手动维护', reason, rows: [{ sku: selected?.sku, data: form, clearFields: Object.keys(detail?.profile?.data || {}).filter(key => form[key] === '' || form[key] == null) }] });
    return <section className="product-info" aria-label="商品资料">
    <header className="pi-heading">
    <div>
    <h2>商品资料</h2>
    <p>按 SKU 查看图片、材质、尺寸、重量、体积和装箱数。供应链可直接补录。</p>
    </div>
    <button className="btn" disabled={busy} onClick={() => void run(load)}>刷新</button>
    </header>
    {error && <p className="notice warn" role="alert">{error}</p>}{message && <p className="notice info" role="status">{message}</p>}
    {!catalog ? <p>正在读取商品资料…</p> : <>
    <p className="pi-effective">商品资料保存后立即生效，无需财务或管理员再次审批。空缺字段显示“待补录”，不影响已填写信息的使用。</p>
    <div className="pi-summary">
        <span>系统SKU <b>{catalog.rows.length}</b>
        </span>
        <span>已建资料 <b>{catalog.rows.filter((r: Row) => r.version).length}</b>
        </span>
        <span>规格待补齐 <b>{catalog.rows.filter((r: Row) => r.missing.length).length}</b>
        </span>
        <span>图片待补充 <b>{catalog.rows.filter((r: Row) => !r.image_id).length}</b>
        </span>
        </div>
    {catalog.canWrite && <details className="pi-import">
            <summary>从商品信息表匹配导入</summary>
            <p>使用带“商品编码SKU”表头的工作表，自动匹配图片与规格。保存成功的资料立即可见；空白不会覆盖已有资料。表内成本另存为参考，不影响商品资料生效。</p>
      <div className="pi-controls">
            <label>选择原始商品表<input type="file" accept=".xlsx" disabled={busy} onChange={e => {
                    const file = e.target.files?.[0];
                    if (file)
                        void importFile(file);
                    e.target.value = '';
                }}/>
            </label>
            <label>资料处理方式<select value={mode} disabled={busy} onChange={e => {
                setMode(e.target.value);
                invalidate();
            }}>
            <option value="fill">补充空缺，已有资料逐项提示差异</option>
            <option value="replace">按预览替换表中已填写的字段</option>
            </select>
            </label>
            </div>
      <label className="pi-check">
            <input type="checkbox" checked={units} disabled={busy} onChange={e => {
                setUnits(e.target.checked);
                invalidate();
            }}/>已核对单位，{unitsLabel}</label>
      <label className="pi-check">
            <input type="checkbox" checked={syncPlanning} disabled={busy} onChange={e => {
                setSyncPlanning(e.target.checked);
                invalidate();
            }}/>同时将已核对的装箱数量、单件体积用于供应参数与备货测算</label>
      {workbook && <>
                <p>{workbook.fileName} · {workbook.rows.length}个SKU · {workbook.imagePaths.size}个图片引用{workbook.skippedSheets.length > 0 && <> · 无SKU表头的工作表已跳过 {workbook.skippedSheets.join('、')}</>}</p>
                <button className="btn" disabled={busy || !units} onClick={() => void run(async () => {
                    setPreview(await api({ ...settings, action: 'preview', fileName: workbook.fileName, rows: workbook.rows }));
                    setAck(false);
                })}>预览SKU匹配与差异</button>
                <button className="btn" disabled={busy} onClick={() => {
                    setWorkbook(null);
                    setImportPending(false);
                    invalidate();
                }}>清除本次文件</button>
                </>}
      {preview && <>
                <p>可保存 {preview.ready} · 资料一致 {preview.unchanged} · 需处理 {preview.issues}</p>
                <div className="table-wrap pi-preview">
                <table>
                <thead>
                <tr>
                <th>SKU</th>
                <th>匹配结果</th>
                <th>修改内容</th>
                <th>核对提示</th>
                </tr>
                </thead>
                <tbody>{preview.rows.map((row: Row) => <tr key={row.inputSku}>
                    <td>{row.sku}</td>
                    <td>{row.status === 'issue' ? row.error : row.status === 'ready' ? '待保存' : '资料一致'}</td>
                    <td>{row.changes.map((c: Row) => <div key={c.field}>{c.field} {display(c.before)} → {display(c.after)}</div>)}</td>
                    <td>{row.warnings.join('；')}</td>
                    </tr>)}</tbody>
                </table>
                </div>
                <label className="pi-check">
                <input type="checkbox" checked={ack} disabled={busy} onChange={e => setAck(e.target.checked)}/>已核对差异，保存匹配成功的SKU并关联图片，待处理项保留在预览中</label>
                <button className="btn primary" disabled={busy || !ack || preview.rows.every((r: Row) => r.status === 'issue')} onClick={() => void commit()}>保存资料并同步图片</button>
                </>}
    </details>}
    <div className="pi-controls">
        <label className="pi-search">搜索SKU、商品、系列或供应商<input value={query} onChange={e => {
            setQuery(e.target.value);
            setPage(0);
        }}/>
        </label>
        <label className="pi-check">
        <input type="checkbox" checked={missingOnly} onChange={e => {
            setMissingOnly(e.target.checked);
            setPage(0);
        }}/>只看待补齐</label>
        </div>
    <div className="table-wrap">
        <table>
        <thead>
        <tr>
        <th>商品</th>
        <th>材质 / 尺寸</th>
        <th>净重 / 毛重 kg</th>
        <th>装箱资料</th>
        <th>体积 m³</th>
        <th>资料状态</th>
        <th>操作</th>
        </tr>
        </thead>
        <tbody>{shown.map((row: Row) => <tr key={row.sku} className={selected?.sku === row.sku ? 'pi-selected' : ''}>
            <td>
            <div className="pi-product">{row.image_id ? <img loading="lazy" src={'/api/product-information/files?id=' + encodeURIComponent(row.image_id)} alt={row.name || row.sku}/> : <span className="pi-no-photo">待补图</span>}<div>
            <strong>{row.sku}</strong>
            <small>{row.name}</small>
            </div>
            </div>
            </td>
            <td>{display(row.data.material)}<small>{display(row.data.dimensions)}{row.data.dimensions ? ' cm' : ''}</small><small>{[row.data.color, row.data.specification].filter(Boolean).join(' · ')}</small>
            </td>
            <td>{display(row.data.netWeightKg)} / {display(row.data.grossWeightKg)}</td>
            <td>{display(row.data.cartonQty)} 件/箱<small>{[row.data.cartonLengthCm, row.data.cartonWidthCm, row.data.cartonHeightCm].map(display).join(' × ')} cm</small>
            </td>
            <td>单件 {display(row.data.unitVolumeCbm)}<small>单箱 {display(row.data.cartonVolumeCbm)}</small></td>
            <td>{row.version ? <span className="pi-live">已生效</span> : '尚未录入'}<small>{row.missing.length ? '缺少 ' + row.missing.length + ' 项，可继续补录' : '规格已齐'}</small><small>{row.version ? 'v' + row.version + ' · ' + row.actor_name : ''}</small>
            </td>
            <td>
            <button className="btn" disabled={busy} onClick={() => void open(row)}>{catalog.canWrite ? '查看 / 补录' : '查看资料'}</button>
            </td>
            </tr>)}</tbody>
        </table>
        </div>
    <div className="pi-pager">
        <span>{rows.length}个SKU · 第{page + 1}页</span>
        <button className="btn" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button>
        <button className="btn" disabled={(page + 1) * 40 >= rows.length} onClick={() => setPage(page + 1)}>下一页</button>
        </div>
    {selected && <article className="pi-detail" ref={detailPanel}>
            <header className="pi-heading">
            <div>
            <h3>{selected.sku}</h3>
            <p>{selected.name}</p>
            </div>
            <button className="btn" disabled={busy} onClick={() => {
                    if (!editing || leave()) {
                        selection.current++;
                        setSelected(null);
                        setEditing(false);
                    }
                }}>关闭资料</button>
            </header>
      {!detail ? <p>读取详情…</p> : <>
                <p>{unitsLabel}</p>
                <div className="pi-fields">{Object.entries(profileFields).map(([key, label]) => <label key={key}>
                    <span>{label}</span>{editing ? <input type={profileNumericFields.includes(key) ? 'number' : 'text'} step={key === 'cartonQty' ? '1' : 'any'} min={profileNumericFields.includes(key) ? '0' : undefined} value={form[key] ?? ''} onChange={e => {
                        setForm({ ...form, [key]: e.target.value });
                        setManualPreview(null);
                    }}/> : <strong>{display(form[key])}</strong>}</label>)}</div>
      {catalog.canWrite && !editing && <button className="btn primary" onClick={() => {
                    setEditing(true);
                    setReason('');
                }}>补录 / 修改资料</button>}
      {editing && <>
                    <label className="pi-check">
                    <input type="checkbox" checked={units} onChange={e => {
                        setUnits(e.target.checked);
                        setManualPreview(null);
                    }}/>已核对 {unitsLabel}</label>
                    <label className="pi-check">
                    <input type="checkbox" checked={syncPlanning} onChange={e => {
                        setSyncPlanning(e.target.checked);
                        setManualPreview(null);
                    }}/>同步装箱数量与单件体积到供应参数</label>
                    <label className="pi-reason">修改依据<input value={reason} onChange={e => setReason(e.target.value)} placeholder="如实物测量、工厂规格表及日期"/>
                    </label>
                    <button className="btn" disabled={busy || !units || !reason.trim()} onClick={() => void run(async () => setManualPreview(await api(manualPayload())))}>核对修改</button>
                    <button className="btn" disabled={busy} onClick={() => {
                        setEditing(false);
                        setForm(detail.profile?.data || {});
                        setManualPreview(null);
                    }}>取消修改</button>{manualPreview && <>
                        <p>{manualPreview.rows[0].error || manualPreview.rows[0].warnings.join('；')}</p>
                        <ul>{manualPreview.rows[0].changes.map((c: Row) => <li key={c.field}>{c.field} {display(c.before)} → {display(c.after)}</li>)}</ul>
                        <button className="btn primary" disabled={busy || !reason.trim() || manualPreview.issues > 0 || manualPreview.ready === 0} onClick={() => void run(async () => {
                            await api({ ...manualPayload(), action: 'save', expected: { [selected.sku]: manualPreview.rows[0].token } });
                            const fresh = await api(undefined, selected.sku);
                            setDetail(fresh);
                            setForm(fresh.profile.data);
                            setEditing(false);
                            setManualPreview(null);
                            setMessage('商品资料已保存，修订记录可追溯');
                            await load();
                        })}>保存本次修改</button>
                        </>}</>}
      <section className="pi-calculation">
                <h4>备货装箱测算</h4>
                <label>计划件数<input type="number" min="0" step="1" value={quantity} onChange={e => setQuantity(e.target.value)}/>
                </label>
                <p>尺寸测算单箱体积 {measurements.calculatedCartonVolume == null ? '待补齐' : display(measurements.calculatedCartonVolume) + ' m³'} · 按装箱量测算单件体积 {measurements.calculatedUnitVolume == null ? '待补齐' : display(measurements.calculatedUnitVolume) + ' m³'}</p>{Number(quantity) > 0 && Number.isInteger(Number(quantity)) && Number(form.cartonQty) > 0 && <p>满箱 {Math.floor(Number(quantity) / Number(form.cartonQty))} 箱 · 余量 {Number(quantity) % Number(form.cartonQty)} 件 · 按整箱包装共 {Math.ceil(Number(quantity) / Number(form.cartonQty))} 箱{(form.cartonVolumeCbm || measurements.calculatedCartonVolume) && <> · 预计 {money(Math.ceil(Number(quantity) / Number(form.cartonQty)) * Number(form.cartonVolumeCbm || measurements.calculatedCartonVolume))} m³</>}</p>}{measurements.warnings.map((warning: string) => <p key={warning} className="notice warn">{warning}</p>)}</section>
      <h4>商品图片</h4>
                <div className="pi-images">{detail.files.map((file: Row) => <a key={file.id} href={'/api/product-information/files?id=' + file.id} target="_blank" rel="noreferrer">
                    <img src={'/api/product-information/files?id=' + file.id} loading="lazy" alt={selected.name}/>
                    <small>{file.actor_name} · {file.created_at.slice(0, 10)}</small>
                    </a>)}</div>{catalog.canWrite && <label className="pi-upload">补充商品图片<input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={e => {
                            const file = e.target.files?.[0];
                            if (file)
                                void run(async () => {
                                    await upload(selected.sku, file);
                                    setDetail(await api(undefined, selected.sku));
                                    await load();
                                    setMessage('商品图片已关联');
                                });
                            e.target.value = '';
                        }}/>
                    </label>}
      <details className="pi-cost-references"><summary>表内成本参考（独立于已生效的商品资料）</summary>
      <p>仅成本参考待财务核定；图片、材质、尺寸、重量、体积与装箱数已可直接使用。</p>{detail.profile?.references?.length ? <div className="table-wrap">
                    <table>
                    <thead>
                    <tr>
                    <th>站点</th>
                    <th>采购 CNY/件</th>
                    <th>海运 CNY/件</th>
                    <th>综合 CNY/件</th>
                    <th>来源</th>
                    </tr>
                    </thead>
                    <tbody>{detail.profile.references.map((ref: Row, index: number) => <tr key={index}>
                        <td>{ref.site}</td>
                        <td>{money(ref.purchase)}</td>
                        <td>{money(ref.freight)}</td>
                        <td>{money(ref.total)}</td>
                        <td>{ref.fileName}<small>{ref.sheet} 第{ref.row}行 · 待核定</small>
                        </td>
                        </tr>)}</tbody>
                    </table>
                    </div> : <p>待补充成本来源</p>}
      <p>财务核对费用范围、生效日期及差异后，在“商品成本与动销”中登记正式成本版本。</p>
      </details>
      <details>
                <summary>查看系统成本版本（CNY/件）</summary>
                <div className="table-wrap">
                <table>
                <thead>
                <tr>
                <th>站点</th>
                <th>综合成本</th>
                <th>范围</th>
                <th>生效日期</th>
                </tr>
                </thead>
                <tbody>{detail.costs.map((cost: Row, index: number) => <tr key={index}>
                    <td>{cost.site}</td>
                    <td>{cost.total == null ? '待核实' : money(cost.total / 10000)}</td>
                    <td>{cost.basis === 'landed' ? '完整到仓' : cost.basis === 'purchase_freight' ? '采购与海运' : '范围待核实'}</td>
                    <td>{cost.effective_date} · v{cost.version}</td>
                    </tr>)}</tbody>
                </table>
                </div>
                </details>
      <details>
                <summary>资料修订历史</summary>{detail.history.map((h: Row) => <details key={h.id}>
                    <summary>v{h.version} · {h.actor_name} · {new Date(h.created_at).toLocaleString('zh-CN')} · {h.reason}</summary>
                    <p>来源 {h.source.fileName} · {h.source.sources?.map((s: Row) => s.sheet + '第' + s.row + '行').join('、')}</p>
                    <dl className="pi-fields">{Object.entries(h.data).map(([key, value]) => <div key={key}>
                        <dt>{profileFields[key as keyof typeof profileFields]}</dt>
                        <dd>{display(value)}</dd>
                        </div>)}</dl>
                    </details>)}</details>
    </>}
    </article>}
    </>}
  </section>;
}
