import {requireActor} from '../../../lib/auth';
import {database,ensureSchema} from '../../../lib/database';
import {readStyleOperations} from '../../../lib/style-operations.mjs';

export async function GET(request:Request){
 try{
  await ensureSchema();
  const actor=await requireActor(request);
  const data=await readStyleOperations(database(),actor,Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(data,{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){
  const e=error as {status?:number;message?:string};
  if(!e.status)console.error('Style operations read failed',error);
  return Response.json({error:e.status?e.message:'款式资料读取失败，请重试'},{status:e.status||500});
 }
}
