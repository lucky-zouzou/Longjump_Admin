import { profileFail } from './product-information-model.mjs';

// Images are shared product master data, not access to cost references or history.
export const PRODUCT_IMAGE_ROLES = ['管理员', '供应链', '财务', '运营', '运营主管'];
export async function productImageAccess(db, actor) {
    if (!actor || !PRODUCT_IMAGE_ROLES.includes(actor.role))
        profileFail('当前账号无权查看商品图片', 403);
    const live = await db.prepare('SELECT role,active FROM users WHERE id=?').bind(actor.id).first();
    if (!live || live.active !== 1 || live.role !== actor.role)
        profileFail('账号权限已变化，请重新登录', 403);
}

export async function readProductImageIndex(db, actor) {
    await productImageAccess(db, actor);
    // One indexed lookup per SKU; no full profiles, costs, uploader or storage paths.
    const { results } = await db.prepare(`SELECT s.sku,
        (SELECT f.id FROM product_profile_files f WHERE f.sku=s.sku
         ORDER BY f.created_at DESC,f.id DESC LIMIT 1) image_id
        FROM sku_settings s ORDER BY s.sku`).all();
    return { images: results.filter(row => row.image_id).map(row => ({ sku: row.sku, id: row.image_id })) };
}
