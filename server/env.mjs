import {readFileSync} from 'node:fs';
import {openDatabase,fileBucket} from './storage.mjs';
import {createCompanyAccount} from './create-account.mjs';
import {readExchangeRateKey} from './exchangerate-config.mjs';
import {readFeishuCredentials} from './feishu-config.mjs';
import {startFeishuSync} from '../lib/feishu-sync.mjs';
const key=Symbol.for('loongjump.node.storage');
export const env=globalThis[key]||(globalThis[key]={DB:openDatabase(),WHOLESALE_FILES:fileBucket()});
env.readExchangeRateKey=readExchangeRateKey;
env.readFeishuCredentials=readFeishuCredentials;
env.startFeishuSync=(actor,input)=>startFeishuSync(env.DB,readFeishuCredentials(),input,{trigger:'manual',actorId:actor.id});
// Keep private file access in Node. Worker deployments use an OPENAI_API_KEY secret.
env.readEmployeeAssistantKey = () => {
  if(process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {return readFileSync(process.env.LOONGJUMP_OPENAI_KEY_FILE || 'secrets/openai_api_key.txt','utf8').trim();}
  catch {return '';}
};
env.COMPANY_ACCOUNTS={create:(actor,input)=>createCompanyAccount(env.DB.sqlite,actor,input)};

const bestConfigFile = process.env.LOONGJUMP_BEST_CREDENTIALS_FILE;
const bestConfig = bestConfigFile ? JSON.parse(readFileSync(bestConfigFile,'utf8')) : {};
env.BEST_PARTNER_ID = bestConfigFile ? bestConfig.partnerId : process.env.BEST_PARTNER_ID;
env.BEST_API_SECRET = bestConfigFile ? bestConfig.secret : process.env.BEST_API_SECRET;

for(const key of ['MATERIALS_ENABLED','MATERIALS_S3_ENDPOINT','MATERIALS_S3_BUCKET','MATERIALS_S3_ACCESS_KEY','MATERIALS_S3_SECRET_KEY','MATERIALS_S3_REGION'])env[key]=process.env[key];
