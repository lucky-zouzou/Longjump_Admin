export class ProductInformationError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}
export function profileFail(message, status = 400) {
    throw new ProductInformationError(message, status);
}
export const profileFields = {
    sourceName: '表内商品名称', color: '颜色', specification: '规格', dimensions: '展开尺寸（cm）',
    netWeightKg: '净重（kg）', grossWeightKg: '毛重（kg）', unitVolumeCbm: '单件体积（m³）',
    material: '材质', sellingPoints: '产品卖点', cartonQty: '装箱数量（件/箱）',
    cartonLengthCm: '外箱长（cm）', cartonWidthCm: '外箱宽（cm）', cartonHeightCm: '外箱高（cm）',
    cartonVolumeCbm: '单箱体积（m³）', sourceStatus: '表内商品状态', notes: '备注',
};
export const profileNumericFields = ['netWeightKg', 'grossWeightKg', 'unitVolumeCbm', 'cartonQty', 'cartonLengthCm', 'cartonWidthCm', 'cartonHeightCm', 'cartonVolumeCbm'];
export const profileRequiredFields = ['color', 'specification', 'dimensions', 'netWeightKg', 'grossWeightKg', 'material', 'cartonQty', 'cartonLengthCm', 'cartonWidthCm', 'cartonHeightCm', 'unitVolumeCbm'];
export const normalizedSku = value => String(value ?? '').trim().toUpperCase();
export const profileMissing = data => profileRequiredFields.filter(key => data[key] == null || data[key] === '');
export function normalizeProfile(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        profileFail('商品资料格式无效');
    const data = {};
    for (const key of Object.keys(profileFields)) {
        const value = input[key];
        if (value == null || String(value).trim() === '')
            continue;
        if (profileNumericFields.includes(key)) {
            const number = Number(value);
            if (!['string', 'number'].includes(typeof value) || !Number.isFinite(number) || number <= 0 || number > 1e7 || key === 'cartonQty' && !Number.isInteger(number))
                profileFail(`${profileFields[key]}须为正数，未知请留空，装箱数量须为整数`);
            data[key] = number;
        }
        else {
            if (typeof value !== 'string' || value.length > 2000)
                profileFail(`${profileFields[key]}须为不超过2000字的文字`);
            data[key] = value.trim();
        }
    }
    if (data.netWeightKg && data.grossWeightKg && data.grossWeightKg < data.netWeightKg)
        profileFail('毛重小于净重，请核对');
    return data;
}
export function profileMeasurements(data) {
    const box = data.cartonLengthCm && data.cartonWidthCm && data.cartonHeightCm ? data.cartonLengthCm * data.cartonWidthCm * data.cartonHeightCm / 1e6 : null;
    const volume = data.cartonVolumeCbm ?? box;
    const unit = volume && data.cartonQty ? volume / data.cartonQty : null;
    const warnings = [];
    if (box && data.cartonVolumeCbm && Math.abs(box - data.cartonVolumeCbm) > Math.max(0.000001, box * 0.02))
        warnings.push('单箱体积与外箱尺寸相差超过2%，请核实');
    if (unit && data.unitVolumeCbm && Math.abs(unit - data.unitVolumeCbm) > Math.max(0.000001, unit * 0.02))
        warnings.push('单件体积与装箱资料相差超过2%，请核实');
    return { calculatedCartonVolume: box, calculatedUnitVolume: unit, warnings };
}
const cleanHeader = value => String(value ?? '').replace(/[\s*]/g, '').replace(/^8(?=泰国)/, '').replace(/[（(].*?[）)]/g, '');
const headerFields = { '商品编码SKU': 'sku', '商品名称': 'sourceName', '颜色': 'color', '规格': 'specification', '展开尺寸': 'dimensions', '净重': 'netWeightKg', '毛重': 'grossWeightKg', '单个体积': 'unitVolumeCbm', '单件体积': 'unitVolumeCbm', '材质': 'material', '产品卖点': 'sellingPoints', '产品装箱数量': 'cartonQty', '外箱长': 'cartonLengthCm', '外箱宽': 'cartonWidthCm', '外箱高': 'cartonHeightCm', '单箱体积': 'cartonVolumeCbm', '商品状态': 'sourceStatus', '状态': 'sourceStatus', '备注': 'notes' };
const sites = { 印尼: '印尼', 马来: '马来西亚', 菲律宾: '菲律宾', 泰国: '泰国', 越南: '越南' };
// Read only header-bearing sheets. A zero calculated from missing dimensions is retained as a warning.
export function parseProfileSheets(sheets) {
    const products = new Map(), skippedSheets = [];
    const sorted = [...sheets].sort((a, b) => Number(b.rows.some(r => r.some(c => cleanHeader(c) === '展开尺寸'))) - Number(a.rows.some(r => r.some(c => cleanHeader(c) === '展开尺寸'))));
    for (const sheet of sorted) {
        const headerAt = sheet.rows.findIndex(row => row.some(cell => cleanHeader(cell) === '商品编码SKU'));
        if (headerAt < 0) {
            skippedSheets.push(sheet.name);
            continue;
        }
        const headers = sheet.rows[headerAt].map(cleanHeader), skuIndex = headers.indexOf('商品编码SKU'), seen = new Set();
        for (let index = headerAt + 1; index < sheet.rows.length; index++) {
            const cells = sheet.rows[index], sku = normalizedSku(cells[skuIndex]);
            if (!sku)
                continue;
            if (seen.has(sku))
                profileFail(`${sheet.name} 第${index + 1}行重复SKU ${sku}，请整理后导入`);
            seen.add(sku);
            const item = products.get(sku) ?? { sku, data: {}, sources: [], references: [], warnings: [], imageIds: [] };
            const source = { sheet: sheet.name, row: index + 1 };
            item.sources.push(source);
            headers.forEach((header, column) => {
                const key = headerFields[header], raw = cells[column];
                if (!key || key === 'sku' || raw == null || String(raw).trim() === '')
                    return;
                let value = String(raw).trim();
                if (profileNumericFields.includes(key)) {
                    value = Number(raw);
                    if (!Number.isFinite(value) || value <= 0 || key === 'cartonQty' && !Number.isInteger(value)) {
                        item.warnings.push(`${sheet.name}第${index + 1}行${profileFields[key]}=${raw}，待补录`);
                        return;
                    }
                }
                if (item.data[key] == null)
                    item.data[key] = value;
                else if (item.data[key] !== value)
                    item.warnings.push(`${sheet.name}第${index + 1}行${profileFields[key]}有差异，采用规格明细表中的值`);
            });
            const image = String(cells[headers.indexOf('图片')] ?? '').match(/DISPIMG\("([^"]+)"/i);
            if (image && !item.imageIds.includes(image[1]))
                item.imageIds.push(image[1]);
            for (const [prefix, site] of Object.entries(sites)) {
                const cost = { site, source, currency: 'CNY', state: 'pending', purchase: cells[headers.indexOf('商品采购成本')] ?? null, freight: cells[headers.indexOf(prefix + '海运费用')] ?? null, total: cells[headers.indexOf(prefix + '综合成本')] ?? null };
                if ([cost.freight, cost.total].some(v => v != null && v !== ''))
                    item.references.push(cost);
            }
            products.set(sku, item);
        }
    }
    if (!products.size)
        profileFail('没有找到带“商品编码SKU”表头的资料');
    return { rows: [...products.values()], skippedSheets };
}
