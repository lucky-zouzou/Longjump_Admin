// Explicit local-only synthetic demo. Refuses existing directories and paths outside work/.
import {resolve,dirname,join} from 'node:path';
import {existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {backup} from 'node:sqlite';
import {workplaceFixture} from '../tests/workplace-fixture.mjs';
import {setAccount} from '../server/accounts.mjs';
import {readExpenses} from '../lib/finance-workbench.mjs';
import {mutateLeave} from '../lib/attendance.mjs';
const target=resolve(process.argv[2]||'work/TEST-PEOPLE-DEMO');
if(dirname(target)!==resolve('work')||!target.split('/').pop().startsWith('TEST-PEOPLE-')||existsSync(target))throw Error('Use a NEW work/TEST-PEOPLE-* directory; no existing or external data allowed.');
mkdirSync(target,{recursive:true,mode:0o700});const f=await workplaceFixture();
for(const u of Object.values(f.users))setAccount(f.sqlite,{...u,email:`${u.id}@example.test`,password:'TestOnly-People-2026!'});
const id=await f.expense({amount:1000});await f.approve(id);await f.pay(id,400);const second=await f.expense({amount:500});await f.change(f.users.manager,second,'managerApprove');await f.expense({currency:'IDR',amount:200000,category:'advertising'});
await mutateLeave(f.db,f.users.indonesia,{action:'leaveCreate',date:'2026-11-24',portion:'first',reason:'TEST-ONLY 工作交接',operationId:crypto.randomUUID()});
const {fileBucket}=await import('../server/storage.mjs');const bucket=fileBucket(join(target,'files'));for(const [key,bytes] of f.contents)await bucket.put(key,bytes);
f.sqlite.exec('CREATE TABLE local_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TEXT NOT NULL)');for(const name of readdirSync('drizzle').filter(x=>x.endsWith('.sql')).sort())f.sqlite.prepare('INSERT INTO local_migrations VALUES(?,?,?)').run(name,createHash('sha256').update(readFileSync(join('drizzle',name))).digest('hex'),new Date().toISOString());
await backup(f.sqlite,join(target,'business.sqlite'));f.sqlite.close();writeFileSync(join(target,'TEST-ONLY.txt'),'Synthetic demonstration only. Accounts: id-ops, manager, hr, finance-1, finance2, admin-1 @example.test\nLocal demo password: TestOnly-People-2026!\n',{mode:0o600});console.log('Created synthetic demo:',target);
