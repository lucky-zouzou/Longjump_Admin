// Store a visit marker only. The current task list always comes from the workspace.
const memory = new Map();
const keyFor = scope => 'lj-task-reminder:v1:' + scope;

export function claimReminder(scope, visit, browser = window) {
  const key = keyFor(scope), value = visit || 'tab';
  if (memory.get(key) === value) return false;
  try {
    const storage = visit ? browser.localStorage : browser.sessionStorage;
    if (storage.getItem(key) === value) return false;
    storage.setItem(key, value);
  } catch { /* Private browsing can limit storage to this document. */ }
  memory.set(key, value);
  return true;
}

export function forgetTabReminder(scope) {
  const key = keyFor(scope);
  memory.delete(key);
  try { window.sessionStorage.removeItem(key); } catch { /* optional storage */ }
}

export function rankedReminderTasks(tasks, allowed) {
  return tasks.filter(task => allowed.includes(task.tab))
    .sort((a, b) => Number(b.level === 'red') - Number(a.level === 'red'));
}
