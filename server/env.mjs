import {openDatabase,fileBucket} from './storage.mjs';
import {createCompanyAccount} from './create-account.mjs';
const key=Symbol.for('loongjump.node.storage');
export const env=globalThis[key]||(globalThis[key]={DB:openDatabase(),WHOLESALE_FILES:fileBucket()});
env.COMPANY_ACCOUNTS={create:(actor,input)=>createCompanyAccount(env.DB.sqlite,actor,input)};
