import {readFileSync} from 'node:fs';

export function readExchangeRateKey(values=process.env){
 if(values.EXCHANGERATE_API_KEY?.trim())return values.EXCHANGERATE_API_KEY.trim();
 const path=values.LOONGJUMP_EXCHANGERATE_KEY_FILE;
 if(!path)return '';
 // A configured but unreadable secret must fail closed, rather than silently changing providers.
 try{return readFileSync(path,'utf8').trim()||fail();}catch{throw Error('汇率密钥文件不可用');}
}
function fail(){throw Error('汇率密钥文件为空');}
