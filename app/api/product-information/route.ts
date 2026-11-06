import { database, ensureSchema } from '../../../lib/database';
import { requireActor } from '../../../lib/auth';
import { readProductInformation, previewProductInformation, saveProductInformation } from '../../../lib/product-information.mjs';
function failure(error: unknown) {
    const value = error as {
        status?: number;
        message?: string;
    };
    if (value.status)
        return Response.json({ error: value.message }, { status: value.status });
    console.error('Product information request failed', error);
    return Response.json({ error: '商品资料操作失败，请保留内容后重试' }, { status: 500 });
}
export async function GET(request: Request) {
    try {
        await ensureSchema();
        const actor = await requireActor(request);
        return Response.json(await readProductInformation(database(), actor, new URL(request.url).searchParams.get('sku')), { headers: { 'Cache-Control': 'private, no-store' } });
    }
    catch (error) {
        return failure(error);
    }
}
export async function POST(request: Request) {
    try {
        if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin)
            return Response.json({ error: '请求来源无效' }, { status: 403 });
        await ensureSchema();
        const actor = await requireActor(request), raw = await request.text();
        if (raw.length > 4000000)
            return Response.json({ error: '内容过大，请拆分文件' }, { status: 413 });
        let payload;
        try {
            payload = JSON.parse(raw);
        }
        catch {
            return Response.json({ error: '请求格式错误' }, { status: 400 });
        }
        if (!payload || !['preview', 'save'].includes(payload.action))
            return Response.json({ error: '操作无效' }, { status: 400 });
        return Response.json(await (payload.action === 'preview' ? previewProductInformation(database(), actor, payload) : saveProductInformation(database(), actor, payload)));
    }
    catch (error) {
        return failure(error);
    }
}
