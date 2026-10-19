// Turn SillyTavern's OpenAI-style `messages` into the pieces the bridge needs:
//   systemPrompt  — the header block (card, preset, world info that comes before the chat)
//   history       — turns before the latest user message
//   current       — the latest user message
//   after         — anything SillyTavern placed after it (post-history instructions, a prefill)
//
// Header detection is the two-step rule inherited from the author's earlier tavern bridges:
// the header is the leading run of system messages; every system message that appears once the
// chat has started stays where it is (rendered as <system> in the history).

const SETTING_HEADS = ['[', '<', '#', '〔', '---', '//', 'CHILD BLOCK', 'GLOBAL BLOCK', '## Phase'];
export const IMAGE_PLACEHOLDER = '[image omitted: Mint AGY Bridge v1 does not send images]';

/** Plain text of one message. Image parts become a placeholder (v1 sends no images). */
export function textOf(msg) {
  if (!msg) return '';
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map(p => (p && p.type === 'image_url') ? IMAGE_PLACEHOLDER : ((p && typeof p.text === 'string') ? p.text : '')).join('');
  }
  return c == null ? '' : String(c);
}

/** Is this message effectively empty? An image counts as content. */
export function blankContent(content) {
  if (typeof content === 'string') return content.trim() === '';
  if (Array.isArray(content)) {
    if (content.some(p => p && p.type === 'image_url')) return false;
    return !content.some(p => p && typeof p.text === 'string' && p.text.trim() !== '');
  }
  return content == null ? true : String(content).trim() === '';
}

/** What a message is: sys / dlg (dialogue) / inj (injected system) / inj? (looks like a setting block) / ? */
export function kindOfTurn(msg, i, headerEnd = 0) {
  if (!msg) return '?';
  if (i < headerEnd) return 'sys';
  if (msg.role === 'assistant') return 'dlg';
  if (msg.role === 'system') return 'inj';
  if (msg.role === 'user') {
    const text = textOf(msg);
    if (text.includes('<user_input>')) return 'dlg';
    const head = text.trimStart();
    return SETTING_HEADS.some(p => head.startsWith(p)) ? 'inj?' : 'dlg';
  }
  return '?';
}

/** Rule 1 (strict): the leading run of system messages; blank placeholders are skipped. */
function strictHeaderEnd(messages) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role === 'system' || blankContent(m.content)) continue;
    return i;
  }
  return messages.length;
}

/**
 * Rule 2 (rescue), used when rule 1 finds no header but system messages exist:
 * everything before the first assistant message is header, walking back from it and stopping at
 * a setting-type system message. A system group sitting right before the first assistant message
 * and right after a player line is an injection, not a setting, and is skipped.
 * Without any assistant message, fall back to "everything before the last user message".
 */
function rescueHeaderEnd(messages) {
  const firstBot = messages.findIndex(m => m && m.role === 'assistant');
  if (firstBot < 0) {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i] && messages[i].role === 'user') return i;
    return messages.length;
  }
  let trailStart = firstBot;
  while (trailStart - 1 >= 0 && (!messages[trailStart - 1] || messages[trailStart - 1].role === 'system')) trailStart--;
  let before = trailStart - 1;
  while (before >= 0 && !messages[before]) before--;
  const trailIsInjection = trailStart < firstBot && before >= 0
    && messages[before].role === 'user' && !blankContent(messages[before].content)
    && kindOfTurn(messages[before], before, 0) === 'dlg'
    && messages.slice(0, before).some(m => m && m.role === 'system');
  let end = firstBot;
  for (let i = firstBot - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'system') {
      if (trailIsInjection && i >= trailStart) continue;
      break;
    }
    end = i;
  }
  return end;
}

function splitAt(messages, headerEnd) {
  const systemParts = [];
  const flow = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    const content = textOf(m);
    if (i < headerEnd) { systemParts.push(content); continue; }
    flow.push({ role: m.role === 'assistant' ? 'assistant' : (m.role === 'system' ? 'system' : 'user'), content });
  }
  const systemPrompt = systemParts.filter(s => s.trim() !== '').join('\n\n');
  let curIdx = -1;
  for (let i = flow.length - 1; i >= 0; i--) if (flow[i].role === 'user') { curIdx = i; break; }
  if (curIdx === -1) return { systemPrompt, history: flow, current: null, after: [], headerEnd };
  return { systemPrompt, history: flow.slice(0, curIdx), current: flow[curIdx], after: flow.slice(curIdx + 1), headerEnd };
}

/**
 * @param {Array<{role:string, content:any}>} messages
 * @returns {{ systemPrompt:string, history:{role,content}[], current:{role,content}|null, after:{role,content}[], headerEnd:number, imageCount:number }}
 */
export function parseMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const imageCount = list.reduce((n, m) => n + (Array.isArray(m?.content) ? m.content.filter(p => p && p.type === 'image_url').length : 0), 0);
  const strictEnd = strictHeaderEnd(list);
  const strict = splitAt(list, strictEnd);
  const hasSystem = list.some(m => m && m.role === 'system');
  if (strict.systemPrompt || !hasSystem) return { ...strict, imageCount };
  // Rule 1 failed although system messages exist. If the chat opens with plain dialogue and no
  // system message precedes the first assistant reply, there is no header at all — don't rescue.
  if (strictEnd === 0) {
    const firstBot = list.findIndex(m => m && m.role === 'assistant');
    const systemBeforeBot = firstBot > 0 && list.slice(0, firstBot).some(m => m && m.role === 'system');
    if (!systemBeforeBot) return { ...strict, imageCount };
  }
  return { ...splitAt(list, rescueHeaderEnd(list)), imageCount };
}

/** <user>…</user> / <reply>…</reply> / <system>…</system> */
export function renderTurn(t) {
  const tag = t.role === 'user' ? 'user' : (t.role === 'system' ? 'system' : 'reply');
  return `<${tag}>\n${t.content}\n</${tag}>`;
}
