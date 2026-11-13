import { env } from 'cloudflare:workers';
import { database, ensureSchema } from '../../../../lib/database';
import { HttpError, requireActor } from '../../../../lib/auth';
import { readProductImage, uploadProductImage } from '../../../../lib/product-information-files.mjs';
interface Bucket {
    put(key: string, value: ArrayBuffer, options: {
        httpMetadata: {
            contentType: string;
        };
    }): Promise<unknown>;
    get(key: string): Promise<{
        body: ReadableStream;
    } | null>;
    delete(key: string): Promise<void>;
}
function bucket() {
    if (!env.WHOLESALE_FILES)
        throw new HttpError(503, '图片存储暂不可用');
    return env.WHOLESALE_FILES as Bucket;
}
function failure(error: unknown) {
    const value = error as {
        status?: number;
        message?: string;
    };
    if (value.status)
        return Response.json({ error: value.message }, { status: value.status });
    console.error('Product image failed', error);
    return Response.json({ error: '图片处理失败，请重试' }, { status: 500 });
}
export async function GET(request: Request) {
    try {
        await ensureSchema();
        const actor = await requireActor(request), file = await readProductImage(database(), actor, new URL(request.url).searchParams.get('id') || '');
        // Revalidate permissions before serving a cached image, without retransmitting bytes.
        const etag = `"${file.sha256}"`, cache = { 'Cache-Control': 'private, no-cache', ETag: etag };
        if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: cache });
        const object = await bucket().get(file.object_key);
        if (!object)
            throw new HttpError(404, '图片文件暂不可用');
        return new Response(object.body, { headers: { 'Content-Type': file.content_type, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`, ...cache, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
    }
    catch (error) {
        return failure(error);
    }
}
export async function POST(request: Request) {
    try {
        if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin)
            throw new HttpError(403, '请求来源无效');
        await ensureSchema();
        const actor = await requireActor(request);
        if (Number(request.headers.get('content-length') || 0) > 11 * 1024 * 1024)
            throw new HttpError(413, '图片不能超过10MB');
        const form = await request.formData();
        return Response.json(await uploadProductImage(database(), bucket(), actor, { sku: String(form.get('sku') || ''), file: form.get('file') }));
    }
    catch (error) {
        return failure(error);
    }
}
