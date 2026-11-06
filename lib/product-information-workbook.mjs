import { parseProfileSheets, profileFail } from './product-information-model.mjs';
// Read selected XLSX entries from the File so large embedded images are loaded one at a time.
export async function openProductWorkbook(file) {
    if (!file || file.size > 350 * 1024 * 1024 || file.size < 22)
        profileFail('请选择350MB以内的XLSX文件');
    const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 65557)).arrayBuffer());
    const view = new DataView(tail.buffer);
    let end = -1;
    for (let at = tail.length - 22; at >= 0; at--)
        if (view.getUint32(at, true) === 0x06054b50 && at + 22 + view.getUint16(at + 20, true) === tail.length) {
            end = at;
            break;
        }
    if (end < 0 || view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0)
        profileFail('工作簿压缩目录无效，请重新保存为XLSX');
    const size = view.getUint32(end + 12, true), offset = view.getUint32(end + 16, true), count = view.getUint16(end + 10, true);
    if (size > 8 * 1024 * 1024 || count > 10000 || offset + size > file.size)
        profileFail('工作簿目录超出限制');
    const directory = new Uint8Array(await file.slice(offset, offset + size).arrayBuffer()), dir = new DataView(directory.buffer), entries = new Map();
    let position = 0;
    for (let i = 0; i < count; i++) {
        if (position + 46 > size || dir.getUint32(position, true) !== 0x02014b50)
            profileFail('工作簿目录损坏');
        const nameLength = dir.getUint16(position + 28, true), extra = dir.getUint16(position + 30, true), comment = dir.getUint16(position + 32, true);
        const name = new TextDecoder().decode(directory.slice(position + 46, position + 46 + nameLength));
        const entry = { flags: dir.getUint16(position + 8, true), method: dir.getUint16(position + 10, true), compressed: dir.getUint32(position + 20, true), size: dir.getUint32(position + 24, true), offset: dir.getUint32(position + 42, true) };
        if (entries.has(name) || position + 46 + nameLength + extra + comment > size)
            profileFail('工作簿包含重复或损坏的文件项');
        entries.set(name, entry);
        position += 46 + nameLength + extra + comment;
    }
    async function read(path, limit = 20 * 1024 * 1024) {
        const entry = entries.get(path);
        if (!entry)
            return null;
        if (entry.flags & 1 || entry.size > limit || entry.compressed > file.size || entry.offset + 30 > file.size || ![0, 8].includes(entry.method))
            profileFail('工作簿条目加密、过大或压缩格式不支持');
        const local = new DataView(await file.slice(entry.offset, entry.offset + 30).arrayBuffer());
        if (local.getUint32(0, true) !== 0x04034b50)
            profileFail('工作簿文件项损坏');
        const start = entry.offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
        if (start + entry.compressed > file.size)
            profileFail('工作簿文件项不完整');
        let stream = file.slice(start, start + entry.compressed).stream();
        if (entry.method === 8)
            stream = stream.pipeThrough(new DecompressionStream('deflate-raw'));
        const reader = stream.getReader(), chunks = [];
        let total = 0;
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done)
                    break;
                total += value.length;
                if (total > entry.size || total > limit)
                    profileFail('工作簿解压内容超出限制');
                chunks.push(value);
            }
        }
        finally {
            await reader.cancel();
        }
        if (total !== entry.size)
            profileFail('工作簿解压长度不一致');
        const output = new Uint8Array(total);
        let cursor = 0;
        for (const chunk of chunks) {
            output.set(chunk, cursor);
            cursor += chunk.length;
        }
        return output;
    }
    return { entries, read };
}
const elements = (node, local) => Array.from(node.getElementsByTagNameNS('*', local));
function xml(bytes) {
    if (!bytes)
        return null;
    const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');
    if (elements(doc, 'parsererror').length)
        profileFail('工作簿XML内容损坏');
    return doc;
}
const relationshipId = element => element.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
function relativePath(base, target) {
    const parts = target.startsWith('/') ? [] : base.split('/').slice(0, -1);
    for (const part of target.split('/')) {
        if (!part || part === '.')
            continue;
        if (part === '..')
            parts.pop();
        else
            parts.push(part);
    }
    return parts.join('/');
}
function relationshipMap(doc, base) {
    return new Map(elements(doc, 'Relationship').filter(r => r.getAttribute('TargetMode') !== 'External').map(r => [r.getAttribute('Id'), relativePath(base, r.getAttribute('Target') || '')]));
}
export async function readProductWorkbook(file) {
    const zip = await openProductWorkbook(file), book = xml(await zip.read('xl/workbook.xml')), rels = xml(await zip.read('xl/_rels/workbook.xml.rels'));
    if (!book || !rels)
        profileFail('请选择标准XLSX工作簿');
    const strings = xml(await zip.read('xl/sharedStrings.xml'));
    const shared = strings ? elements(strings, 'si').map(si => elements(si, 't').map(t => t.textContent).join('')) : [];
    const paths = relationshipMap(rels, 'xl/workbook.xml'), sheets = [];
    for (const sheet of elements(book, 'sheet')) {
        const path = paths.get(relationshipId(sheet));
        if (!path)
            continue;
        const doc = xml(await zip.read(path));
        if (!doc)
            continue;
        const rows = [];
        for (const row of elements(doc, 'row')) {
            const rowNumber = Number(row.getAttribute('r'));
            if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > 10002)
                profileFail('工作表超过10000行，请拆分');
            const values = [];
            for (const cell of elements(row, 'c')) {
                const address = cell.getAttribute('r') || '', letters = address.match(/^[A-Z]+/)?.[0] || '';
                let column = 0;
                for (const c of letters)
                    column = column * 26 + c.charCodeAt(0) - 64;
                if (column < 1 || column > 200)
                    continue;
                const type = cell.getAttribute('t'), value = elements(cell, 'v')[0]?.textContent ?? '', formula = elements(cell, 'f')[0]?.textContent ?? '';
                values[column - 1] = formula.includes('DISPIMG') ? formula : type === 's' ? shared[Number(value)] ?? '' : type === 'inlineStr' ? elements(cell, 't').map(t => t.textContent).join('') : value;
            }
            rows[rowNumber - 1] = values;
        }
        sheets.push({ name: sheet.getAttribute('name') || '', rows: Array.from({ length: rows.length }, (_, i) => rows[i] || []) });
    }
    const parsed = parseProfileSheets(sheets), imagePaths = new Map();
    const cells = xml(await zip.read('xl/cellimages.xml')), imageRels = xml(await zip.read('xl/_rels/cellimages.xml.rels'));
    if (cells && imageRels) {
        const media = relationshipMap(imageRels, 'xl/cellimages.xml');
        for (const pic of elements(cells, 'pic')) {
            const name = elements(pic, 'cNvPr')[0]?.getAttribute('name'), embed = elements(pic, 'blip')[0]?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
            if (name && media.has(embed))
                imagePaths.set(name, media.get(embed));
        }
    }
    return { ...parsed, fileName: file.name, imagePaths,
        async image(id) {
            const path = imagePaths.get(id);
            if (!path)
                return null;
            const bytes = await zip.read(path, 10 * 1024 * 1024);
            if (!bytes)
                return null;
            const suffix = path.split('.').pop().toLowerCase(), type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[suffix];
            if (!type)
                profileFail('商品图片格式暂不支持，请转为JPEG、PNG或WebP');
            return new File([bytes], path.split('/').pop(), { type });
        }
    };
}
