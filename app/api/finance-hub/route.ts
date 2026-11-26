import {database,ensureSchema} from '../../../lib/database';
import {requireActor} from '../../../lib/auth';
import {readFinanceHub} from '../../../lib/finance-hub.mjs';
import {workplaceError} from '../workplace/route';
export async function GET(request:Request){try{await ensureSchema();const actor=await requireActor(request);return Response.json(await readFinanceHub(database(),actor,Object.fromEntries(new URL(request.url).searchParams)),{headers:{'Cache-Control':'private,no-store'}});}catch(e){return workplaceError(e);}}
