import {database} from '../../../lib/database';
import {employeeActionCounts} from '../../../lib/business-actions.mjs';
import {canReadActions} from '../../../lib/business-action-model.mjs';
import {env} from 'cloudflare:workers';
import {requireActor,HttpError} from '../../../lib/auth';
import {recentKnowledge} from '../../../lib/employee-knowledge.mjs';
import {answerWithKnowledge,assistantHome} from '../../../lib/employee-assistant.mjs';

const headers={'Cache-Control':'private, no-store'};
function problem(e:unknown) {
  return Response.json({error:e instanceof HttpError?e.message:'助手暂时无法访问，请重新打开再试。'},
    {status:e instanceof HttpError?e.status:503,headers});
}

export async function GET(request:Request) {
  try {
    const actor=await requireActor(request);
    if(new URL(request.url).searchParams.has('actionCounts')) {
      if(!canReadActions(actor)) throw new HttpError(403,'此岗位无权查看经营行动单');
      return Response.json(await employeeActionCounts(database(),actor),{headers});
    }
    return Response.json({...assistantHome(actor),recent:await recentKnowledge(database(),actor,new Date().toISOString())},{headers});
  }
  catch(e) {return problem(e);}
}

export async function POST(request:Request) {
  try {
    if(request.headers.get('origin')!==new URL(request.url).origin) throw new HttpError(403,'请求来源无效');
    if(!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415,'请提交 JSON 格式的问题');
    const actor=await requireActor(request);
    if(Number(request.headers.get('content-length'))>8192) throw new HttpError(413,'问题过长');
    const reader=request.body?.getReader();
    if(!reader) throw new HttpError(400,'请填写问题');
    const chunks:Uint8Array[]=[];
    let size=0;
    while(true) {
      const {done,value}=await reader.read();
      if(done) break;
      size+=value.byteLength;
      if(size>8192) {await reader.cancel();throw new HttpError(413,'问题过长');}
      chunks.push(value);
    }
    let input;
    try {const text=new TextDecoder();input=JSON.parse(chunks.map(c=>text.decode(c,{stream:true})).join('')+text.decode());}
    catch {throw new HttpError(400,'问题格式无效');}
    if(!input || typeof input.question!=='string' || !input.question.trim() || input.question.length>600 ||
      ['guideId','previous','page'].some(k=>input[k]!==undefined && (typeof input[k]!=='string'||input[k].length>80)))
      throw new HttpError(400,'请输入 1 至 600 字的问题');
    if((input.mode!==undefined&&!['auto','internal','public'].includes(input.mode))||
      (input.knowledgeId!==undefined&&(typeof input.knowledgeId!=='string'||!/^[0-9a-f]{64}$/.test(input.knowledgeId))))throw new HttpError(400,'无效的知识查询');
    const configured=typeof env.readEmployeeAssistantKey==='function'?env.readEmployeeAssistantKey():env.OPENAI_API_KEY;
    const key=typeof configured==='string'?configured.trim():'';
    const response=await answerWithKnowledge(database(),actor,input,{apiKey:key,signal:request.signal});
    return Response.json(response,{headers});
  } catch(e) {return problem(e);}
}
