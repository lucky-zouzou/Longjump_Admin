import {env} from 'cloudflare:workers';
import {requireActor,HttpError} from '../../../lib/auth';
import {database} from '../../../lib/database';
import {backupStream} from '../../../lib/full-backup.mjs';
import {releaseMigrations} from '../../../lib/backup-version.mjs';
export async function GET(request:Request){try{const actor=await requireActor(request);if(actor.role!=='管理员')throw new HttpError(403,'仅管理员可导出完整备份');if(!env.WHOLESALE_FILES)throw new HttpError(503,'凭证存储未绑定');return new Response(await backupStream(database(),env.WHOLESALE_FILES,actor,releaseMigrations),{headers:{'content-type':'application/x-tar','content-disposition':`attachment; filename="LOONGJUMP-full-backup-${new Date().toISOString().slice(0,10)}.tar"`,'cache-control':'no-store'}})}catch(e:any){return Response.json({error:e.message||'完整备份失败'},{status:e.status||500})}}
