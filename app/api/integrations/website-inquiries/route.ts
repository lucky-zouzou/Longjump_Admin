import {env} from 'cloudflare:workers';
import {database} from '../../../../lib/database';
import {handleWebsiteInquiry} from '../../../../lib/website-inquiry-handler.mjs';
export async function POST(request:Request){
 const config=env as unknown as {LOONGJUMP_INQUIRY_SYNC_SECRET?:string;LOONGJUMP_INQUIRY_SOURCE?:string};
 return handleWebsiteInquiry(request,database(),config.LOONGJUMP_INQUIRY_SYNC_SECRET,config.LOONGJUMP_INQUIRY_SOURCE||'loongjump-website');
}
