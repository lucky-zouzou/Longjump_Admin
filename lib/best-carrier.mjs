export function isBestCarrier(name) {
  const normalized = String(name ?? '').normalize('NFKC').toLowerCase().replace(/[\s.·_-]+/g, '');
  return ['百世','百世集团','百世跨境','百世跨境物流','百世国际','百世国际物流','百世物流','best','bestinc','bestexpress','bestlogistics','bestcrossborder'].includes(normalized);
}
