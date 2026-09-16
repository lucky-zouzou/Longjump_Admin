import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openDatabase,fileBucket} from './storage.mjs';
import {setAccount} from './accounts.mjs';
import {createBackup,restoreBackup,verifyArchive} from './backup.mjs';
const [command,...args]=process.argv.slice(2),opts={};for(let i=0;i<args.length;i+=2){if(!args[i].startsWith('--')||!args[i+1])throw Error('Options require --name value');opts[args[i].slice(2)]=args[i+1]}
try{
 if(command==='account:add'){const password=process.env.LOONGJUMP_ACCOUNT_PASSWORD_FILE?readFileSync(process.env.LOONGJUMP_ACCOUNT_PASSWORD_FILE,'utf8').trim():readFileSync(0,'utf8').trim();const db=openDatabase();setAccount(db.sqlite,{...opts,password});db.sqlite.close();console.log('Company account saved; existing sessions revoked.');}
 else if(command==='backup'){const db=openDatabase();try{console.log(await createBackup({DB:db,WHOLESALE_FILES:fileBucket()},opts.output||`backups/LOONGJUMP-${Date.now()}.tar`))}finally{db.sqlite.close()}}
 else if(command==='restore'){if(!opts.input||!opts.target)throw Error('Required: --input backup.tar --target NEW_DIRECTORY');console.log(JSON.stringify(await restoreBackup(opts.input,opts.target)));}
 else if(command==='verify'){if(!opts.input)throw Error('Required: --input backup.tar');const m=await verifyArchive(opts.input);console.log(JSON.stringify({verified:true,tables:m.tables.length,files:m.files.length,createdAt:m.createdAt}));}
 else throw Error('Commands: account:add, backup --output FILE, verify --input FILE, restore --input FILE --target NEW_DIRECTORY');
}catch(e){console.error(e.message);process.exitCode=1}
