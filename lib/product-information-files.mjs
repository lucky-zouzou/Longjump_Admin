import { profileAccess, profileHash } from './product-information.mjs';
import { profileFail } from './product-information-model.mjs';
import { productImageAccess } from './product-images.mjs';
import { assertWritable, atomicBatch, guardStatement } from './atomic.mjs';
export async function uploadProductImage(db, bucket, actor, { sku, file }) {
    await profileAccess(db, actor, true);
    await assertWritable(db);
    if (!await db.prepare('SELECT sku FROM sku_settings WHERE sku=?').bind(sku).first())
        profileFail('请先匹配系统SKU', 404);
    if (!(file instanceof File) || file.size === 0 || file.size > 10 * 1024 * 1024)
        profileFail('商品图片须为10MB以内的JPEG、PNG或WebP');
    const bytes = await file.arrayBuffer(), data = new Uint8Array(bytes), ascii = (start, end) => String.fromCharCode(...data.slice(start, end));
    const valid = file.type === 'image/jpeg' ? data.length > 3 && data[0] === 255 && data[1] === 216 && data[2] === 255 : file.type === 'image/png' ? data.length >= 8 && data[0] === 137 && ascii(1, 8) === 'PNG\r\n\x1a\n' : file.type === 'image/webp' && data.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    if (!valid)
        profileFail('图片内容与文件类型不符');
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(n => n.toString(16).padStart(2, '0')).join('');
    const prior = await db.prepare('SELECT id FROM product_profile_files WHERE sku=? AND sha256=?').bind(sku, digest).first();
    if (prior)
        return { ok: true, id: prior.id, duplicate: true };
    const count = await db.prepare('SELECT COUNT(*) n FROM product_profile_files WHERE sku=?').bind(sku).first();
    if (count.n >= 10)
        profileFail('每个SKU最多保留10张商品图片');
    const id = 'product_' + crypto.randomUUID(), key = 'products/' + await profileHash(sku) + '/' + id;
    const name = file.name.replace(/[\r\n]/g, '').slice(0, 180), stamp = new Date().toISOString();
    await bucket.put(key, bytes, { httpMetadata: { contentType: file.type } });
    try {
        await atomicBatch(db, [
            guardStatement(db, actor, 'product-profile.image', 'EXISTS(SELECT 1 FROM users WHERE id=? AND role=? AND active=1) AND (SELECT COUNT(*) FROM product_profile_files WHERE sku=?)<10 AND NOT EXISTS(SELECT 1 FROM system_maintenance WHERE id=\'global\' AND mode<>\'normal\' AND expires_at>?)', [actor.id, actor.role, sku, stamp]),
            db.prepare('INSERT INTO product_profile_files(id,sku,object_key,sha256,name,content_type,size,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id, sku, key, digest, name, file.type, file.size, actor.id, actor.name, stamp),
            db.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(), '上传商品图片', 'product_profile', sku, JSON.stringify({ id, name, sha256: digest }), actor.id, actor.name, stamp),
        ]);
    }
    catch (error) {
        await bucket.delete(key);
        if (/UNIQUE constraint/i.test(String(error))) {
            const existing = await db.prepare('SELECT id FROM product_profile_files WHERE sku=? AND sha256=?').bind(sku, digest).first();
            if (existing)
                return { ok: true, id: existing.id, duplicate: true };
        }
        throw error;
    }
    return { ok: true, id, duplicate: false };
}
export async function readProductImage(db, actor, id) {
    await productImageAccess(db, actor);
    const file = await db.prepare('SELECT * FROM product_profile_files WHERE id=?').bind(id).first();
    if (!file)
        profileFail('商品图片不存在', 404);
    return file;
}
