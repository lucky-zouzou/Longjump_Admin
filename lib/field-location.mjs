// Coordinates are evidence from a device, not proof against GPS spoofing.
export function validateLocation(value,now=Date.now()){
 if(!value||typeof value!=='object')throw Error('请允许手机定位后重新采集现场位置 / Aktifkan lokasi lalu coba lagi');
 const {latitude,longitude,accuracy,capturedAt}=value;
 if(![latitude,longitude,accuracy,capturedAt].every(v=>typeof v==='number'&&Number.isFinite(v))||Math.abs(latitude)>90||Math.abs(longitude)>180||accuracy<=0||accuracy>100000)throw Error('定位数据无效 / Lokasi tidak valid');
 if(now-capturedAt>120000||capturedAt>now+30000)throw Error('定位已过期，请重新采集 / Lokasi kedaluwarsa');
 return {latitude,longitude,accuracy,capturedAt,receivedAt:new Date(now).toISOString(),address:`GPS ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`};
}
export function distanceMeters(a,b){const rad=x=>x*Math.PI/180,dlat=rad(b.latitude-a.latitude),dlon=rad(b.longitude-a.longitude),h=Math.sin(dlat/2)**2+Math.cos(rad(a.latitude))*Math.cos(rad(b.latitude))*Math.sin(dlon/2)**2;return 12742000*Math.asin(Math.sqrt(Math.min(1,h)));}
