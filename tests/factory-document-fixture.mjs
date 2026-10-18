import {purchasePreparation,savePurchaseDraft,TERMS} from '../lib/purchase-documents.mjs';
export async function preparePurchase(f,month='2026-09'){
 const s=await purchasePreparation(f.db,month),future=new Date(Date.now()+10*86400000).toISOString().slice(0,10);
 const documents=s.groups.map((g,k)=>({...g,number:`PO-${month}-${k}`,orderDate:new Date(Date.now()+8*3600000).toISOString().slice(0,10),contact:'工厂联系人',phone:'12345678',currency:'CNY',taxRate:'8.5',paymentTerms:'到集运仓月结60天',terms:TERMS,termsReviewed:true,items:g.items.map(i=>({...i,purchasePrice:'25.50',dueDate:future,color:'黑色',specification:'大号'}))}));
 await savePurchaseDraft(f.db,f.users.supply,{month,sourceKey:s.sourceKey,version:s.draft?.version||0,documents});return documents;
}
