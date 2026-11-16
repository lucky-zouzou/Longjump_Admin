export const assistantName = '小品同学';

// A leading name is the shortcut. Normal menu searches keep their meaning.
export function wakeQuestion(input) {
  const text = String(input || '').trim();
  return text.startsWith(assistantName)
    ? text.slice(assistantName.length).replace(/^[\s,，、:：。!！?？]+/u,'').trim()
    : null;
}
