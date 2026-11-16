import {NAVIGATION_BY_ROLE} from './permissions.mjs';
import {builtinGuides} from './employee-guides.mjs';

const pages = new Set(Object.values(NAVIGATION_BY_ROLE).flat());
const shortText = (v, limit) => typeof v === 'string' && v.trim().length > 0 && v.length <= limit;
const listOfText = (v, maxItems, limit) => Array.isArray(v) && v.length > 0 &&
  v.length <= maxItems && v.every(item => shortText(item, limit));

export function parseHandbook(pack) {
  const ids = new Set(builtinGuides.map(g => g.id));
  const dailyRoles = new Set();
  if (!pack || pack.format !== 1 || !shortText(pack.edition, 48) || !Array.isArray(pack.guides) ||
      !pack.guides.length || pack.guides.length > 160) throw Error('Invalid employee handbook');
  for (const g of pack.guides) {
    if (!g || !/^[a-z][a-z0-9-]{1,65}$/.test(g.id) || ids.has(g.id) ||
        !(pages.has(g.page) || g.page === '@work') || !shortText(g.title, 100) ||
        !listOfText(g.steps, 4, 600) || !listOfText(g.keywords, 24, 65) ||
        !shortText(g.next, 400) || !Array.isArray(g.roles) || !g.roles.length ||
        !g.roles.every(role => Object.hasOwn(NAVIGATION_BY_ROLE, role))) throw Error('Invalid handbook procedure');
    ids.add(g.id);
    if (g.dailyRole !== undefined) {
      if (!g.roles.includes(g.dailyRole) || dailyRoles.has(g.dailyRole) ||
          (g.page !== '@work' && !NAVIGATION_BY_ROLE[g.dailyRole].includes(g.page))) throw Error('Invalid daily handbook role');
      dailyRoles.add(g.dailyRole);
    }
  }
  return {format:1,edition:pack.edition,guides:pack.guides.map(({id,page,roles,keywords,title,steps,next,dailyRole})=>({
    id,page,roles,keywords,title,steps,next,...(dailyRole ? {dailyRole} : {})
  }))};
}
