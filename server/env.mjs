import {openDatabase,fileBucket} from './storage.mjs';
const key=Symbol.for('loongjump.node.storage');
export const env=globalThis[key]||(globalThis[key]={DB:openDatabase(),WHOLESALE_FILES:fileBucket()});
