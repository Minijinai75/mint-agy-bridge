// Unit tests: message parsing, agent-file planning, the stdin size guard, error wording, model list parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessages, IMAGE_PLACEHOLDER } from '../lib/parse.mjs';
import { planTurn, renderAgentFile, agentNameFor, LONG_MESSAGE_POINTER, CONTINUE_POINTER, stdinLine } from '../lib/agent-file.mjs';
import { humanError, parseAgyError } from '../lib/errors.mjs';
import { parseModelList } from '../lib/agy.mjs';
import { loadConfig, applyRuntimePatch, publicConfig, DEFAULTS } from '../lib/config.mjs';

const sys = c => ({ role: 'system', content: c });
const user = c => ({ role: 'user', content: c });
const bot = c => ({ role: 'assistant', content: c });

// ── parseMessages ─────────────────────────────────────────────────────────
test('header = leading system messages; latest user is current; the rest is history', () => {
  const p = parseMessages([sys('CARD'), sys('PRESET'), bot('hello'), user('hi'), bot('yo'), user('now')]);
  assert.equal(p.systemPrompt, 'CARD\n\nPRESET');
  assert.deepEqual(p.history.map(t => t.role), ['assistant', 'user', 'assistant']);
  assert.equal(p.current.content, 'now');
  assert.deepEqual(p.after, []);
});

test('system messages after the chat starts stay in place (author note, depth injections)', () => {
  const p = parseMessages([sys('CARD'), bot('hello'), user('a'), sys('AUTHOR NOTE'), bot('b'), user('c'), sys('POST-HISTORY')]);
  assert.equal(p.systemPrompt, 'CARD');
  assert.deepEqual(p.history.map(t => t.content), ['hello', 'a', 'AUTHOR NOTE', 'b']);
  assert.equal(p.current.content, 'c');
  assert.deepEqual(p.after.map(t => t.content), ['POST-HISTORY']);
});

test('blank system placeholders do not end the header', () => {
  const p = parseMessages([sys('CARD'), sys(''), sys('MORE'), bot('hello'), user('x')]);
  assert.equal(p.systemPrompt, 'CARD\n\nMORE');
});

test('rescue rule: header given as a user message before the first reply', () => {
  const p = parseMessages([user('[Character card here]'), sys('world info'), user('setting 2'), bot('greeting'), user('hi')]);
  assert.ok(p.systemPrompt.includes('[Character card here]'));
  assert.equal(p.current.content, 'hi');
});

test('no user message at all → current null (continue)', () => {
  const p = parseMessages([sys('CARD'), bot('hello')]);
  assert.equal(p.current, null);
  assert.equal(p.history.length, 1);
});

test('images become a placeholder and are counted', () => {
  const p = parseMessages([sys('CARD'), user([{ type: 'text', text: 'look ' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }])]);
  assert.equal(p.current.content, 'look ' + IMAGE_PLACEHOLDER);
  assert.equal(p.imageCount, 1);
});

// ── planTurn / agent file ────────────────────────────────────────────────
test('agent file holds framing + card + history; stdin holds only the latest message', () => {
  const p = parseMessages([sys('CARD'), bot('hello'), user('a'), bot('b'), user('LATEST'), sys('JB')]);
  const plan = planTurn(p, { stdinLimitBytes: 180000, framing: 'FRAME' });
  assert.ok(plan.body.startsWith('FRAME\n\nCARD\n\n<history>\n<reply>\nhello\n</reply>'));
  assert.ok(!plan.body.includes('LATEST'));
  assert.equal(plan.stdinText, 'LATEST\n\n<system>\nJB\n</system>');
  assert.equal(plan.movedToAgentFile, false);
});

test('size guard: a latest message over the limit moves into the agent file, stdin gets a pointer', () => {
  const big = '尾'.repeat(70000);   // 210,000 bytes in UTF-8
  const p = parseMessages([sys('CARD'), user(big + 'END-MARK')]);
  const plan = planTurn(p, { stdinLimitBytes: 180000, framing: '' });
  assert.equal(plan.movedToAgentFile, true);
  assert.equal(plan.stdinText, LONG_MESSAGE_POINTER);
  assert.ok(plan.body.endsWith('END-MARK\n</latest_message>'));
  assert.ok(Buffer.byteLength(stdinLine(plan.stdinText)) < 1000);
});

test('size guard counts bytes, not characters', () => {
  const s = '字'.repeat(61000);     // 61,000 chars but 183,000 bytes
  const plan = planTurn(parseMessages([user(s)]), { stdinLimitBytes: 180000, framing: '' });
  assert.equal(plan.movedToAgentFile, true);
  const ok = planTurn(parseMessages([user('a'.repeat(179000))]), { stdinLimitBytes: 180000, framing: '' });
  assert.equal(ok.movedToAgentFile, false);
});

test('no user message → continue pointer on stdin', () => {
  const plan = planTurn(parseMessages([sys('CARD'), bot('hello')]), { stdinLimitBytes: 180000 });
  assert.equal(plan.stdinText, CONTINUE_POINTER);
  assert.ok(plan.body.includes('<history>'));
});

test('rendered agent file has the tool-free front matter', () => {
  const name = agentNameFor('body');
  assert.match(name, /^mint-[0-9a-f]{8}-[0-9a-f]{4}$/);
  const file = renderAgentFile(name, 'BODY');
  const front = file.split('---')[1];
  for (const line of ['excludeDefaultComponents: true', 'inheritCustomizations: false', 'inheritMcp: false', 'tools: []', `name: ${name}`]) {
    assert.ok(front.includes(line), line);
  }
  assert.ok(file.trimEnd().endsWith('BODY'));
});

// ── errors ────────────────────────────────────────────────────────────────
test('humanError: project quota 429 (real agy 1.4.2 text)', () => {
  const raw = 'RESOURCE_EXHAUSTED (code 429): Quota exceeded for aiplatform.googleapis.com/global_online_prediction_requests_per_base_model with base model: anthropic-claude-opus. Please submit a quota increase request.';
  assert.match(humanError(raw), /Google Cloud 專案.*配額/);
  assert.ok(humanError(raw).includes('原始錯誤'));
});

test('humanError: model not in list (real agy text) lists what is available', () => {
  const raw = 'invalid model selection (--model "x" --effort ""): model x is not recognized as a known model or custom model in settings\nAvailable models:\n  Gemini 3.8 Flash (High)\n  Claude Sonnet 4.6 (Thinking)';
  const h = humanError(raw);
  assert.match(h, /不在你 agy 帳號的清單/);
  assert.ok(h.includes('Gemini 3.8 Flash (High)、Claude Sonnet 4.6 (Thinking)'));
});

test('humanError: missing agy, timeout, credits, generic 429, refusal before auth', () => {
  assert.match(humanError(Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' })), /找不到 agy/);
  assert.match(humanError(new Error('x'), { timedOut: true, timeoutSec: 300 }), /300 秒/);
  assert.match(humanError('Your AI credits balance is too low to continue.'), /點數不足/);
  assert.match(humanError('RESOURCE_EXHAUSTED (code 429): rate limited'), /等一兩分鐘/);
  assert.match(humanError('Unauthorized: response blocked by safety filters'), /依內容擋下/);
  assert.match(humanError('UNAUTHENTICATED: please sign in'), /還沒登入/);
  assert.equal(humanError('something else'), 'something else');
});

test('parseAgyError reads the AGY_ERROR line', () => {
  const e = parseAgyError('error: boom\nAGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): x","retryable":false}\n');
  assert.equal(e.retryable, false);
  assert.match(e.short_error, /429/);
  assert.equal(parseAgyError('nothing here'), null);
});

// ── agy models / config ──────────────────────────────────────────────────
test('parseModelList reads "id<TAB>label" lines and skips the banner', () => {
  const list = parseModelList('Fetching available models...\r\ngemini-4-argon-high\tGemini 4 Argon (High)\r\nclaude-opus-5-5-max\tClaude Opus 5.5 (Max)\r\n');
  assert.deepEqual(list.map(m => m.id), ['gemini-4-argon-high', 'claude-opus-5-5-max']);
  assert.equal(list[0].label, 'Gemini 4 Argon (High)');
});

test('config: bad values are ignored, runtime patch only touches runtime keys, api key hidden', () => {
  const { cfg } = loadConfig('/nonexistent-dir-for-test', { MINT_PORT: '5501' });
  assert.equal(cfg.port, 5501);
  applyRuntimePatch(cfg, { port: 1, printTimeoutSec: 3, maxRetries: 2, defaultModel: 'm', apiKey: 'x' });
  assert.equal(cfg.port, 5501);
  assert.equal(cfg.printTimeoutSec, DEFAULTS.printTimeoutSec);
  assert.equal(cfg.maxRetries, 2);
  assert.equal(cfg.defaultModel, 'm');
  assert.equal(cfg.apiKey, '');
  assert.equal(publicConfig({ ...cfg, apiKey: 'secret' }).apiKey, '(set)');
});

test('agy environment: auto-update off, retries from config, ADC only when asked', async () => {
  const { agyEnv } = await import('../lib/agy.mjs');
  const e = agyEnv({ ...DEFAULTS, maxRetries: 2 });
  assert.equal(e.AGY_CLI_DISABLE_AUTO_UPDATE, '1');
  assert.equal(e.AGY_CLI_MODEL_API_MAX_RETRIES, '2');
  assert.equal(e.AGY_ADC_AUTH, process.env.AGY_ADC_AUTH);
  assert.equal(agyEnv({ ...DEFAULTS, adcAuth: true }).AGY_ADC_AUTH, 'true');
});
