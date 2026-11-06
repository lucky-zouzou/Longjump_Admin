import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixtures.mjs';
import { normalizeProfile, parseProfileSheets, profileMeasurements } from '../lib/product-information-model.mjs';
import { previewProductInformation, saveProductInformation, readProductInformation } from '../lib/product-information.mjs';
import { uploadProductImage, readProductImage } from '../lib/product-information-files.mjs';
import { createBackup, restoreBackup, verifyArchive } from '../server/backup.mjs';
import { fileBucket, openDatabase } from '../server/storage.mjs';
import { openProductWorkbook } from '../lib/product-information-workbook.mjs';
import * as XLSX from 'xlsx';
const payload = rows => ({ rows, mode: 'fill', unitsConfirmed: true, syncPlanning: true, fileName: 'TEST-ONLY.xlsx', reason: '测试工厂资料核对' });
const information = { color: '黑', material: 'PVC', cartonQty: 20, cartonLengthCm: 40, cartonWidthCm: 30, cartonHeightCm: 20, cartonVolumeCbm: 0.024, unitVolumeCbm: 0.0012 };
const prepare = async (f, p, actor = f.users.supply) => {
    const preview = await previewProductInformation(f.db, actor, p);
    return { ...p, expected: Object.fromEntries(preview.rows.map(r => [r.sku, r.token])) };
};
test('资料补录保留成本与库存，按SKU匹配并更新装箱供应参数，重试幂等', async () => {
    const f = fixture(), stocks = f.sqlite.prepare('SELECT * FROM inventory_balances').all();
    const references = [{ site: '印尼', purchase: 10, freight: 2, total: 12, source: { sheet: 'Sheet1', row: 3 } }, { site: '印尼', purchase: 10, freight: 4, total: 14, source: { sheet: 'Sheet2', row: 3 } }];
    const p = payload([{ sku: ' bag-a ', data: information, references }]), ready = await prepare(f, p);
    assert.equal((await saveProductInformation(f.db, f.users.supply, ready)).saved, 1);
    assert.equal((await saveProductInformation(f.db, f.users.supply, ready)).saved, 0);
    const detail = await readProductInformation(f.db, f.users.finance, 'BAG-A');
    assert.equal(detail.profile.references.length, 2);
    assert.equal(detail.profile.references[0].state, 'pending');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM product_cost_versions').get().n, 0);
    assert.deepEqual(f.sqlite.prepare('SELECT * FROM inventory_balances').all(), stocks);
    assert.equal(f.sqlite.prepare("SELECT carton_qty FROM sku_settings WHERE sku='BAG-A'").get().carton_qty, 20);
    assert.equal(detail.history.length, 1);
});
test('未知SKU、大小写歧义、同批重复、缺失单位确认阻止写入', async () => {
    const f = fixture(), p = payload([{ sku: 'BAG-A', data: information }, { sku: 'NEW-SKU', data: information }]);
    assert.equal((await previewProductInformation(f.db, f.users.supply, p)).issues, 1);
    await assert.rejects(saveProductInformation(f.db, f.users.supply, await prepare(f, p)), /匹配/);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM product_profiles').get().n, 0);
    f.sqlite.prepare("INSERT INTO sku_settings(sku,name,updated_at) VALUES('bag-a','歧义','2026-01-01')").run();
    assert.match((await previewProductInformation(f.db, f.users.supply, p)).rows[0].error, /歧义/);
    assert.equal((await previewProductInformation(f.db, f.users.supply, payload([{ sku: 'BAG-B', data: {} }, { sku: 'BAG-B', data: {} }]))).issues, 1);
    await assert.rejects(previewProductInformation(f.db, f.users.supply, { ...p, unitsConfirmed: false }), /单位|确认/);
});
test('仅供应链和管理员维护，财务只读，工厂和运营无权读成本参考', async () => {
    const f = fixture(), p = payload([{ sku: 'BAG-A', data: information }]);
    assert.equal((await readProductInformation(f.db, f.users.finance)).canWrite, false);
    await assert.rejects(previewProductInformation(f.db, f.users.finance, p), e => e.status === 403);
    await assert.rejects(readProductInformation(f.db, f.users.indonesia), e => e.status === 403);
    await assert.rejects(readProductInformation(f.db, { ...f.users.admin, role: '工厂' }), e => e.status === 403);
    f.sqlite.prepare('UPDATE users SET active=0 WHERE id=?').run(f.users.supply.id);
    await assert.rejects(previewProductInformation(f.db, f.users.supply, p), e => e.status === 403);
});
test('填空模式保留已填资料，手动修订和清空保留历史', async () => {
    const f = fixture(), p = payload([{ sku: 'BAG-A', data: information }]);
    await saveProductInformation(f.db, f.users.supply, await prepare(f, p));
    const update = payload([{ sku: 'BAG-A', data: { color: '白', sellingPoints: '可折叠' } }]);
    const preview = await previewProductInformation(f.db, f.users.supply, update);
    assert.equal(preview.rows[0].data.color, '黑');
    assert.ok(preview.rows[0].warnings.length);
    await saveProductInformation(f.db, f.users.supply, await prepare(f, update));
    const clear = { ...payload([{ sku: 'BAG-A', data: { color: '白' }, clearFields: ['material'] }]), mode: 'replace' };
    await saveProductInformation(f.db, f.users.supply, await prepare(f, clear));
    const detail = await readProductInformation(f.db, f.users.finance, 'BAG-A');
    assert.equal(detail.profile.data.material, undefined);
    assert.equal(detail.profile.data.color, '白');
    assert.equal(detail.history.length, 3);
    assert.throws(() => f.sqlite.exec('DELETE FROM product_profile_history'), /immutable/);
});
test('陈旧预览及同期供应参数修改均阻止覆盖', async () => {
    const f = fixture(), p = payload([{ sku: 'BAG-A', data: information }]), ready = await prepare(f, p);
    f.sqlite.prepare("UPDATE sku_settings SET carton_qty=99 WHERE sku='BAG-A'").run();
    await assert.rejects(saveProductInformation(f.db, f.users.supply, ready), /变化/);
    const fresh = await prepare(f, p);
    await saveProductInformation(f.db, f.users.supply, fresh);
    const edit = { ...payload([{ sku: 'BAG-A', data: { color: '白' } }]), mode: 'replace' }, old = await prepare(f, edit);
    await saveProductInformation(f.db, f.users.supply, await prepare(f, { ...edit, rows: [{ sku: 'BAG-A', data: { color: '蓝' } }] }));
    await assert.rejects(saveProductInformation(f.db, f.users.supply, old), /变化/);
});
test('并发写入在事务内保护版本，整批回滚', async () => {
    const f = fixture(), p = payload([{ sku: 'BAG-A', data: information }, { sku: 'BAG-B', data: information }]), ready = await prepare(f, p);
    const db = { ...f.db, batch: async (statements) => {
            f.sqlite.prepare("UPDATE sku_settings SET carton_qty=88 WHERE sku='BAG-B'").run();
            return f.db.batch(statements);
        } };
    await assert.rejects(saveProductInformation(db, f.users.supply, ready), e => e.status === 409);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM product_profiles').get().n, 0);
    assert.equal(f.sqlite.prepare("SELECT carton_qty FROM sku_settings WHERE sku='BAG-A'").get().carton_qty, 1);
});
test('毛重、箱数和体积校验，疑似尺寸不一致时暂停供应参数同步', async () => {
    assert.throws(() => normalizeProfile({ cartonQty: 1.5 }), /整数/);
    assert.throws(() => normalizeProfile({ grossWeightKg: 0.2, netWeightKg: 0.3 }), /毛重/);
    assert.throws(() => normalizeProfile({ unitVolumeCbm: 0 }), /正数/);
    assert.equal(profileMeasurements(information).warnings.length, 0);
    const f = fixture(), p = payload([{ sku: 'BAG-A', data: { ...information, cartonVolumeCbm: 3 } }]);
    const preview = await previewProductInformation(f.db, f.users.supply, p);
    assert.ok(preview.rows[0].warnings.length);
    await saveProductInformation(f.db, f.users.supply, await prepare(f, p));
    assert.equal(f.sqlite.prepare("SELECT unit_volume_cbm FROM sku_settings WHERE sku='BAG-A'").get().unit_volume_cbm, 0);
});
test('工作表按表头合并SKU、补缺规格，保留两表成本及图片引用，忽略无表头工作表', () => {
    const sheets = [{ name: 'Sheet2', rows: [['*商品编码SKU', '商品名称', '印尼综合成本'], ['bag-a', '辅表名', 99], ['BAG-B', '第二款', 33]] }, { name: 'Sheet1', rows: [['初稿'], ['*商品编码SKU', '*商品名称', '展开尺寸', '*产品装箱数量\n', '*商品采购成本\n（含头程运费）', '*印尼海运费用（1800）', '*印尼综合成本', '图片', '单个体积'], ['BAG-A', '主表名', '40*30*20', 20, 10, 2, 12, '_xlfn.DISPIMG("ID_TEST",1)', 0]] }, { name: 'Sheet3', rows: [['BAG-C', 22]] }];
    const p = parseProfileSheets(sheets);
    assert.equal(p.rows.length, 2);
    assert.equal(p.rows[0].data.sourceName, '主表名');
    assert.equal(p.rows[0].references.length, 2);
    assert.equal(p.rows[0].references[0].freight, 2);
    assert.deepEqual(p.rows[0].imageIds, ['ID_TEST']);
    assert.ok(p.rows[0].warnings.length);
    assert.equal(p.rows[0].data.unitVolumeCbm, undefined);
    assert.deepEqual(p.skippedSheets, ['Sheet3']);
});
test('XLSX压缩读取支持选择文件项，拒绝无效和超限文件', async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['商品编码SKU'], ['BAG-A']]), '资料');
    const file = new File([XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer', compression: true })], 'test.xlsx');
    const zip = await openProductWorkbook(file);
    assert.match(new TextDecoder().decode(await zip.read('xl/workbook.xml')), /资料/);
    await assert.rejects(zip.read('xl/workbook.xml', 1), /超|过大/);
    await assert.rejects(openProductWorkbook(new File(['invalid'], 'x.xlsx')), /请选择/);
});
test('商品图片鉴权、文件签名及幂等校验', async () => {
    const f = fixture(), store = new Map(), bucket = { put: async (k, b) => store.set(k, b), delete: async (k) => store.delete(k) };
    const file = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])], 'TEST.png', { type: 'image/png' });
    const result = await uploadProductImage(f.db, bucket, f.users.supply, { sku: 'BAG-A', file });
    assert.equal((await uploadProductImage(f.db, bucket, f.users.supply, { sku: 'BAG-A', file })).duplicate, true);
    assert.equal(store.size, 1);
    assert.equal((await readProductImage(f.db, f.users.finance, result.id)).sku, 'BAG-A');
    await assert.rejects(readProductImage(f.db, f.users.sales, result.id), e => e.status === 403);
    await assert.rejects(uploadProductImage(f.db, bucket, f.users.supply, { sku: 'BAG-A', file: new File(['fake'], 'x.png', { type: 'image/png' }) }), /内容/);
});
test('商品资料和图片进入全量备份并可完整恢复', async () => {
    const f = fixture(), root = mkdtempSync(join(tmpdir(), 'lj-product-'));
    let restored;
    try {
        const bucket = fileBucket(join(root, 'files')), p = payload([{ sku: 'BAG-A', data: information }]);
        await saveProductInformation(f.db, f.users.supply, await prepare(f, p));
        const file = new File([new Uint8Array([255, 216, 255, 0])], 'TEST.jpg', { type: 'image/jpeg' });
        const uploaded = await uploadProductImage(f.db, bucket, f.users.supply, { sku: 'BAG-A', file });
        const backup = join(root, 'backup.tar');
        await createBackup({ DB: f.db, WHOLESALE_FILES: bucket }, backup);
        assert.equal((await verifyArchive(backup)).files.length, 1);
        await restoreBackup(backup, join(root, 'restore'));
        restored = openDatabase(join(root, 'restore', 'business.sqlite'));
        assert.equal(restored.sqlite.prepare('SELECT COUNT(*) n FROM product_profiles').get().n, 1);
        assert.ok(restored.sqlite.prepare('SELECT id FROM product_profile_files WHERE id=?').get(uploaded.id));
    }
    finally {
        restored?.sqlite.close();
        rmSync(root, { recursive: true, force: true });
    }
});
