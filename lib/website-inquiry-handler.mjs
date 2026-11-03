import {verifyInquiryRequest,InquiryError} from './website-inquiry-auth.mjs';
import {receiveWebsiteInquiry} from './website-leads.mjs';
import {ConflictError} from './atomic.mjs';

export async function handleWebsiteInquiry(request,db,secret,source='loongjump-website'){
 try{
  const payload=await verifyInquiryRequest(request,secret);
  return Response.json(await receiveWebsiteInquiry(db,payload,source),{headers:{'Cache-Control':'no-store'}});
 }catch(error){
  const known=error instanceof InquiryError||error instanceof ConflictError;
  if(!known)console.error('Website inquiry sync failed:',error.message);
  return Response.json({error:known?error.message:'询盘暂未同步，请重试'},{status:known?error.status:500,headers:{'Cache-Control':'no-store'}});
 }
}
