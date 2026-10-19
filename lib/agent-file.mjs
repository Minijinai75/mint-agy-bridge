// Build the per-request agy custom agent file and the stdin message.
//
// Why the history goes into the agent file and not into stdin (measured with agy 1.4.2):
//   * A user message larger than ~192,000 bytes is silently cut from the END by agy — the model
//     sees "content truncated" and the run still reports SUCCESS.
//   * The agent file (system prompt) took 390,000 bytes with the head and tail both intact.
// So: card + preset + full history live in the agent file; stdin carries only the latest message.
// If that one message is itself too large, it moves into the agent file as well.

import { createHash, randomBytes } from 'node:crypto';
import { renderTurn } from './parse.mjs';

export const DEFAULT_FRAMING = [
  'You are the character engine of a roleplay / interactive fiction chat app, not a coding assistant.',
  'Everything below is supplied by the chat app: character, setting and instructions first, then the earlier conversation inside <history>',
  '(<user> = the user, <reply> = your earlier replies, <system> = notes the app inserted).',
  'Reply in plain text to the latest user message only. Never mention tools, files, workspaces or code unless the story itself is about them.',
].join(' ');

// The front matter: no default agy prompt, no tools, no global rules, no MCP.
const FRONT_MATTER = [
  'mainAgent: true',
  'subagent: false',
  'excludeDefaultComponents: true',
  'inheritCustomizations: false',
  'inheritMcp: false',
  'tools: []',
];

// First line of every agent body. Never "---", so a card that starts with a fake front-matter
// block can never be read as a second front matter, even with framing disabled.
export const BODY_MARKER = '[Mint AGY Bridge: roleplay session]';
export const LONG_MESSAGE_POINTER = '(The latest message is too long to send directly. Its full text is at the end of your instructions inside <latest_message>. Respond to it.)';
export const CONTINUE_POINTER = '(Continue the conversation from where <history> ends.)';
export const CONTINUE_INSTRUCTION = 'Your reply inside <partial_reply> was cut off. Continue it exactly from its last character. Output only the continuation; do not repeat any of it.';

/** A fresh agent name for one request: mint-<8 hex of content>-<4 hex random>. */
export function agentNameFor(body) {
  const h = createHash('sha256').update(body).digest('hex').slice(0, 8);
  return `mint-${h}-${randomBytes(2).toString('hex')}`;
}

/** A trailing assistant turn (optionally followed by system nudges) = SillyTavern "continue" or a prefill. */
export function splitPartial(turns) {
  let i = turns.length - 1;
  while (i >= 0 && turns[i].role === 'system') i--;
  if (i >= 0 && turns[i].role === 'assistant') return { rest: turns.slice(0, i), partial: turns[i].content, trailing: turns.slice(i + 1) };
  return null;
}

/**
 * @param {{systemPrompt:string, history:any[], current:any, after:any[]}} parsed  output of parseMessages
 * @param {{stdinLimitBytes:number, framing?:string}} opts
 * @returns {{ body:string, stdinText:string, movedToAgentFile:boolean, continuation:boolean, bytes:{agentFile:number, stdin:number} }}
 */
export function planTurn(parsed, { stdinLimitBytes, framing = DEFAULT_FRAMING }) {
  const sections = [BODY_MARKER];
  if (framing && framing.trim()) sections.push(framing.trim());
  if (parsed.systemPrompt && parsed.systemPrompt.trim()) sections.push(parsed.systemPrompt);

  let history = parsed.history;
  let stdinText;
  let continuation = false;
  const continueBlock = sp => {
    continuation = true;
    const tail = sp.trailing.length ? '\n\n' + sp.trailing.map(renderTurn).join('\n') : '';
    return `${CONTINUE_INSTRUCTION}\n<partial_reply>\n${sp.partial}\n</partial_reply>${tail}`;
  };
  if (parsed.current) {
    const sp = splitPartial(parsed.after);
    const after = sp ? sp.rest : parsed.after;
    stdinText = parsed.current.content;
    if (after.length) stdinText += '\n\n' + after.map(renderTurn).join('\n');
    if (sp) stdinText += '\n\n' + continueBlock(sp);
  } else {
    const sp = splitPartial(history);
    if (sp) { history = sp.rest; stdinText = continueBlock(sp); }
    else stdinText = CONTINUE_POINTER;
  }
  if (history.length) sections.push(`<history>\n${history.map(renderTurn).join('\n')}\n</history>`);
  if (!stdinText.trim()) stdinText = '(empty message)';

  let movedToAgentFile = false;
  if (Buffer.byteLength(stdinText, 'utf8') > stdinLimitBytes) {
    sections.push(`<latest_message>\n${stdinText}\n</latest_message>`);
    stdinText = LONG_MESSAGE_POINTER;
    movedToAgentFile = true;
  }

  const body = sections.join('\n\n');
  return { body, stdinText, movedToAgentFile, continuation, bytes: { agentFile: Buffer.byteLength(body, 'utf8'), stdin: Buffer.byteLength(stdinText, 'utf8') } };
}

/** The whole .md file agy reads from <workspace>/.agents/agents/<name>.md */
export function renderAgentFile(name, body) {
  return [
    '---',
    `name: ${name}`,
    'description: Mint AGY Bridge roleplay agent (generated for one request, deleted afterwards).',
    ...FRONT_MATTER,
    '---',
    '',
    body,
    '',
  ].join('\n');
}

/** One NDJSON line for `agy --input-format stream-json`. */
export function stdinLine(text) {
  return JSON.stringify({ event: 'user', message: { role: 'user', content: text } }) + '\n';
}
