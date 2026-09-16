import {spawnSync} from 'node:child_process';
import {rmSync,renameSync,existsSync} from 'node:fs';
const r=spawnSync('pnpm',['exec','vinext','build'],{stdio:'inherit',env:{...process.env,LOONGJUMP_TARGET:'node'}});if(r.status!==0)process.exit(r.status||1);if(existsSync('dist-node'))rmSync('dist-node',{recursive:true});renameSync('dist','dist-node');
