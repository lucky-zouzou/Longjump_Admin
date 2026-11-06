import {env} from 'cloudflare:workers';
import {requireActor} from '../../../lib/auth';
import {database} from '../../../lib/database';
import {readBestTracking, manageBestTracking} from '../../../lib/best-tracking.mjs';

const headers = {'Cache-Control':'private, no-store'};
function failure(error:any) {
  const status = error?.status || 500;
  return Response.json({error:status === 500 ? '运输轨迹暂时不可用，请刷新后重试' : error.message},{status,headers});
}

export async function GET(request:Request) {
  try {
    const actor = await requireActor(request);
    return Response.json(await readBestTracking(database(),actor,new URL(request.url).searchParams.get('legId')),{headers});
  } catch (error) { return failure(error); }
}

export async function POST(request:Request) {
  try {
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin) return Response.json({error:'请求来源无效'},{status:403,headers});
    const actor = await requireActor(request);
    const body = await request.text();
    if (body.length > 2048) return Response.json({error:'内容过长'},{status:413,headers});
    let input;
    try { input = JSON.parse(body); } catch { return Response.json({error:'格式无效'},{status:400,headers}); }
    if (!input || !['link','unlink','refresh'].includes(input.action)) return Response.json({error:'无效操作'},{status:400,headers});
    return Response.json(await manageBestTracking(database(),env,actor,input),{headers});
  } catch (error) { return failure(error); }
}
