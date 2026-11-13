import { database, ensureSchema } from '../../../lib/database';
import { requireActor } from '../../../lib/auth';
import { readProductImageIndex } from '../../../lib/product-images.mjs';

export async function GET(request: Request) {
    try {
        await ensureSchema();
        const actor = await requireActor(request);
        return Response.json(await readProductImageIndex(database(), actor), { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
        const value = error as { status?: number; message?: string };
        if (value.status) return Response.json({ error: value.message }, { status: value.status });
        console.error('Product image index failed', error);
        return Response.json({ error: '商品图片暂时无法读取' }, { status: 500 });
    }
}
