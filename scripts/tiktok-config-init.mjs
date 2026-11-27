// Run from the checkout/deployment root. Never overwrites existing credentials or encryption keys.
import {mkdirSync,writeFileSync,existsSync,chmodSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
mkdirSync('secrets',{recursive:true,mode:0o700});
for(const [path,value] of [
 ['secrets/tiktok_credentials.json',JSON.stringify({shop:{appId:'',appSecret:'',authorizationUrl:''},ads:{appId:'',appSecret:'',authorizationUrl:''}},null,2)+'\n'],
 ['secrets/tiktok_token_key.txt',randomBytes(32).toString('hex')+'\n']
]){
 if(existsSync(path)){console.log(path+': existing file retained');continue;}
 writeFileSync(path,value,{flag:'wx',mode:0o600});chmodSync(path,0o600);console.log(path+': private file created');
}
