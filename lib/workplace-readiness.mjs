// Configuration checks only: readiness never invents a schedule or grants a role.
export function workplaceSetup(c, user, users) {
  const profile = c.profiles.find(p => p.user_id === user.id);
  const unit = c.units.find(u => u.id === profile?.unit_id);
  const shift = c.shifts.find(s => s.id === profile?.shift_id);
  const activePeople = new Set(users.filter(u => u.active).map(u => u.id));
  const issues = [];
  if (profile && !profile.active) issues.push('profile_inactive');
  if (!unit?.active) issues.push('unit');
  else if (user.site && user.site !== unit.site) issues.push('site');
  if (!String(profile?.job_title || '').trim()) issues.push('job');
  const organizationReady = Boolean(profile?.active && unit?.active && (!user.site || user.site === unit.site));
  const shiftReady = Boolean(shift?.active && shift.unit_id === unit?.id);
  if (!shiftReady) issues.push('shift');
  const managers = new Set(c.grants.filter(g => g.unit_id === unit?.id && g.capability === 'manager').map(g => g.user_id));
  if (profile?.manager_id) managers.add(profile.manager_id);
  const validManagers = [...managers].filter(id => id !== user.id && activePeople.has(id));
  const managerReady = validManagers.length > 0;
  if (!managerReady) issues.push('manager');
  const canPunch = organizationReady && shiftReady && !issues.includes('job');
  const canLeave = canPunch && managerReady;
  const hrReady = c.grants.some(g => g.unit_id === unit?.id && g.capability === 'hr' &&
    g.user_id !== user.id && activePeople.has(g.user_id) && validManagers.some(id => id !== g.user_id));
  return {organizationReady, managerReady, canPunch, canLeave, issues,
    warnings: canLeave && !hrReady ? ['hr_review'] : []};
}
