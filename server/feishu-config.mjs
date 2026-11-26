import {readFileSync} from 'node:fs';

export function readFeishuCredentials(values=process.env){
 const hasEnv=Boolean(values.FEISHU_APP_ID||values.FEISHU_APP_SECRET);
 let input;
 if(hasEnv)input={appId:values.FEISHU_APP_ID,appSecret:values.FEISHU_APP_SECRET};
 else {
  try{input=JSON.parse(readFileSync(values.LOONGJUMP_FEISHU_CREDENTIALS_FILE||'secrets/feishu_credentials.json','utf8'));}
  catch(error){if(!values.LOONGJUMP_FEISHU_CREDENTIALS_FILE&&error.code==='ENOENT')return null;throw Object.assign(Error('飞书私密配置文件不可用，请管理员核对'),{code:'credentials_unavailable'});}
 }
 const appId=typeof input?.appId==='string'?input.appId.trim():'',appSecret=typeof input?.appSecret==='string'?input.appSecret.trim():'';
 if(!appId&&!appSecret)return null;
 if(!/^cli_[A-Za-z0-9_-]{4,100}$/.test(appId)||!appSecret||appSecret.length>4096)throw Object.assign(Error('飞书应用凭据不完整，请管理员核对'),{code:'credentials_incomplete'});
 return {appId,appSecret};
}
