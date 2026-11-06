import {readFileSync} from 'node:fs';
import {openDatabase,fileBucket} from './storage.mjs';
import {createCompanyAccount} from './create-account.mjs';
const key=Symbol.for('loongjump.node.storage');
export const env=globalThis[key]||(globalThis[key]={DB:openDatabase(),WHOLESALE_FILES:fileBucket()});
env.COMPANY_ACCOUNTS={create:(actor,input)=>createCompanyAccount(env.DB.sqlite,actor,input)};

const bestConfigFile = process.env.LOONGJUMP_BEST_CREDENTIALS_FILE;
const bestConfig = bestConfigFile ? JSON.parse(readFileSync(bestConfigFile,'utf8')) : {};
env.BEST_PARTNER_ID = bestConfigFile ? bestConfig.partnerId : process.env.BEST_PARTNER_ID;
env.BEST_API_SECRET = bestConfigFile ? bestConfig.secret : process.env.BEST_API_SECRET;
