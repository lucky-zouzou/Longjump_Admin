// Explicit isolated synthetic fixture; never opens production storage or credentials.
import {openDatabase} from '../server/storage.mjs';
import {existsSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve('work/connections-preview'),target=root+'/business.sqlite';
if(existsSync(target))throw Error('Existing TEST fixture retained; no overwrite');
mkdirSync(root,{recursive:true,mode:0o700});
const {sqlite}=openDatabase(target);
try{
 for(const [id,role,site,channel] of [['admin-1','管理员',null,null],['id-ops','运营','印尼','TikTok'],['sample-bd','达人BD',null,null],['supply-1','供应链',null,null],['finance-1','财务',null,null]])sqlite.prepare('INSERT INTO users(id,email,name,role,site,channel,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id,id+'@example.test','TEST-ONLY '+role+' '+id,role,site,channel,new Date().toISOString(),new Date().toISOString());
 sqlite.exec("CREATE TABLE connections_preview_marker(id TEXT PRIMARY KEY,created_at TEXT NOT NULL)");
 sqlite.prepare('INSERT INTO connections_preview_marker VALUES(?,?)').run('TEST-ONLY-CONNECTIONS-v1',new Date().toISOString());
 console.log('Synthetic Connections preview prepared');
}finally{sqlite.close();}
