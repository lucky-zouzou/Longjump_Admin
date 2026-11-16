const greetings = [
  '今天也给自己留一口热茶，慢慢进入状态。',
  '开工啦！挑一件顺手的小事，给今天热个身。',
  '欢迎回来！愿今天的好消息，比未读消息多一点。',
  '今天的小目标里，也给伸个懒腰留个位置。',
  '愿今天的沟通，都像遇见绿灯一样顺畅。',
  '新的一天，先从最想打勾的那件事开始吧。',
  '嗨，很高兴见到你！今天也一起把事情做漂亮。',
  '给今天留一点空白，说不定会冒出好点子。',
  '喝口水，松松肩，按自己的节奏开工吧。',
  '愿今天的待办清单里，藏着一两件开心事。',
  '见到你真好，今天又有机会把一个点子变成真的。',
  '愿你的咖啡刚刚好，想找的同事也刚好在线。',
  '忙里偷个小闲，看看窗外，给眼睛也放个风。',
  '灵感要是还在路上，让它慢慢来，我们先打个招呼。'
];

export function dailyGreeting(now=new Date(), zone) {
  const parts=new Intl.DateTimeFormat('en',{timeZone:zone,year:'numeric',month:'numeric',day:'numeric'}).formatToParts(now);
  const fields=Object.fromEntries(parts.map(p=>[p.type,p.value]));
  const day=Math.floor(Date.UTC(+fields.year,+fields.month-1,+fields.day)/86400000);
  return greetings[((day%greetings.length)+greetings.length)%greetings.length];
}

export function weatherWords(symbol='') {
  const code=symbol.split('_')[0];
  if (code.includes('thunder')) return '雷雨';
  if (code.includes('sleet')) return '雨夹雪';
  if (code.includes('snow')) return '有雪';
  if (code.includes('heavyrain')) return '大雨';
  if (code.includes('lightrain')) return '小雨';
  if (code.includes('rainshowers')) return '阵雨';
  if (code.includes('rain')) return '有雨';
  return {clearsky:'晴',fair:'晴间少云',partlycloudy:'多云',cloudy:'阴',fog:'有雾'}[code]||'';
}


export function salutation(now=new Date(), zone) {
  const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',hourCycle:'h23'}).format(now));
  if (hour<5) return '夜深了，辛苦啦';
  if (hour<11) return '早上好';
  if (hour<14) return '中午好';
  if (hour<18) return '下午好';
  return '晚上好';
}
