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

export const LONG_MESSAGE_POINTER = '(The latest message is too long to send directly. Its full text is at the end of your instructions inside <latest_message>. Respond to it.)';
export const CONTINUE_POINTER = '(Continue the conversation from where <history> ends.)';

/** A fresh agent name for one request: mint-<8 hex of content>-<4 hex random>. */
export function agentNameFor(body) {
  const h = createHash('sha256').update(body).digest('hex').slice(0, 8);
  return `mint-${h}-${randomBytes(2).toString('hex')}`;
}

/**
 * @param {{systemPrompt:string, history:any[], current:any, after:any[]}} parsed  output of parseMessages
 * @param {{stdinLimitBytes:number, framing?:string}} opts
 * @returns {{ body:string, stdinText:string, movedToAgentFile:boolean, bytes:{agentFile:number, stdin:number} }}
 */
export function planTurn(parsed, { stdinLimitBytes, framing = DEFAULT_FRAMING }) {
  const sections = [];
  if (framing && framing.trim()) sections.push(framing.trim());
  if (parsed.systemPrompt && parsed.systemPrompt.trim()) sections.push(parsed.systemPrompt);
  if (parsed.history.length) sections.push(`<history>\n${parsed.history.map(renderTurn).join('\n')}\n</history>`);

  let stdinText;
  if (parsed.current) {
    stdinText = parsed.current.content;
    if (parsed.after.length) stdinText += '\n\n' + parsed.after.map(renderTurn).join('\n');
  } else {
    stdinText = CONTINUE_POINTER;
  }
  if (!stdinText.trim()) stdinText = '(empty message)';

  let movedToAgentFile = false;
  if (Buffer.byteLength(stdinText, 'utf8') > stdinLimitBytes) {
    sections.push(`<latest_message>\n${stdinText}\n</latest_message>`);
    stdinText = LONG_MESSAGE_POINTER;
    movedToAgentFile = true;
  }

  const body = sections.join('\n\n');
  return { body, stdinText, movedToAgentFile, bytes: { agentFile: Buffer.byteLength(body, 'utf8'), stdin: Buffer.byteLength(stdinText, 'utf8') } };
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
