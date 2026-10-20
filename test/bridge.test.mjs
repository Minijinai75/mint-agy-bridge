// End-to-end over HTTP against a fake agy (test/fixtures/fake-agy.mjs): no network, no quota.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, _setConfig, _setWorkspace, _setModels, _state } from '../index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mint-test-'));
const dataDir = path.join(tmp, 'agydata');
const ws = path.join(tmp, 'ws');
const argsOut = path.join(tmp, 'args.json');
const BASE_CFG = { host: '127.0.0.1', apiKey: '', agyPath: path.join(here, 'fixtures', 'fake-agy.mjs'), agyDataDir: dataDir, usageLog: false, framing: 'FRAME', stdinLimitBytes: 180000, maxRetries: 0, keepOnDisconnect: true, maxConcurrent: 2, printTimeoutSec: 300, watchdogExtraSec: 30, honorMaxTokens: true };
let server, base;

before(async () => {
  process.env.FAKE_AGY_DATA = dataDir;
  process.env.FAKE_AGY_ARGS_OUT = argsOut;
  _setConfig(BASE_CFG);
  _setWorkspace(ws, path.join(tmp, 'logs'));
  _setModels([{ id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' }, { id: 'gemini-3.8-flash-low', label: 'Flash' }]);
  server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => { _setConfig(BASE_CFG); });
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const chat = (body, extra = {}) => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...(extra.headers || {}) }, body: JSON.stringify(body), signal: extra.signal });
async function sseText(res) {
  const raw = await res.text();
  let text = '', finish = null, done = false;
  const errors = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const d = line.slice(6);
    if (d === '[DONE]') { done = true; continue; }
    const j = JSON.parse(d);
    if (j.error) { errors.push(j.error.message); continue; }
    text += j.choices[0].delta.content || '';
    finish = j.choices[0].finish_reason || finish;
  }
  return { text, finish, done, errors, raw };
}
const msgs = (latest, card = 'CARD-起') => [{ role: 'system', content: card }, { role: 'assistant', content: '歡迎光臨' }, { role: 'user', content: latest }];
const agentFilesLeft = () => fs.readdirSync(path.join(ws, '.agents', 'agents')).length;
const seenArgs = () => JSON.parse(fs.readFileSync(argsOut, 'utf8'));
const M = 'gemini-4-argon-high';

// ── happy paths ───────────────────────────────────────────────────────────
test('streaming reply: text arrives, agent file + agy conversation files are cleaned up', async () => {
  const res = await chat({ model: M, messages: msgs('早安'), stream: true });
  assert.equal(res.status, 200);
  const { text, finish, done } = await sseText(res);
  assert.match(text, /^echo:早安\|agent=\d+\|tail=/);
  assert.equal(finish, 'stop'); assert.ok(done);
  const seen = seenArgs();
  assert.ok(seen.agentText.includes('CARD-起') && seen.agentText.includes('歡迎光臨'));
  assert.ok(seen.agentText.includes('tools: []'));
  for (const f of ['--sandbox', '--disable-slash-commands', '--print-timeout', '--agent']) assert.ok(seen.argv.includes(f), f);
  assert.equal(seen.argv[seen.argv.indexOf('--model') + 1], M);
  assert.equal(seen.env.retries, '0'); assert.equal(seen.env.noUpdate, '1');
  assert.equal(agentFilesLeft(), 0);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'conversations')), []);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'brain')), []);
});

test('no "stream" field → non-streaming chat.completion (OpenAI default)', async () => {
  const res = await chat({ model: M, messages: msgs('hi') });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const j = await res.json();
  assert.match(j.choices[0].message.content, /^echo:hi/);
  assert.equal(j.usage.prompt_tokens, 100);
});

test('model not in the account list → 400 with the list, agy never started', async () => {
  fs.rmSync(argsOut, { force: true });
  const res = await chat({ model: 'claude-opus-4-6', messages: msgs('x') });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /gemini-4-argon-high/);
  assert.ok(!fs.existsSync(argsOut));
});

test('no model in request → first listed model', async () => {
  const res = await chat({ messages: msgs('預設') });
  assert.equal(res.status, 200);
  assert.equal(seenArgs().argv[seenArgs().argv.indexOf('--model') + 1], M);
});

// ── errors ────────────────────────────────────────────────────────────────
test('429 before any text → HTTP 502 with a readable message (stream and json), not a chat reply', async () => {
  for (const stream of [true, false]) {
    const res = await chat({ model: M, messages: msgs('#429'), stream });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error.message, /薄荷橋：.*配額不夠/);
  }
});

test('failure after text started → partial text kept, error sent as an error event (not reply text), stream closed', async () => {
  const s = await sseText(await chat({ model: M, messages: msgs('#midfail'), stream: true }));
  assert.equal(s.text, '前半段');
  assert.equal(s.errors.length, 1);
  assert.match(s.errors[0], /^薄荷橋：連不上 Google/);
  assert.ok(s.done);
});

// ── 0.1.1: content filter, timeout wording, exit code, max_tokens ─────────
test('content filter after text → agy stopped at once, text kept, error event says filter (not timeout)', async () => {
  const t0 = Date.now();
  const s = await sseText(await chat({ model: M, messages: msgs('#filter'), stream: true }));
  assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0} ms (fake agy hangs 20 s)`);
  assert.equal(s.text, '正文寫完了。');
  assert.equal(s.errors.length, 1);
  assert.match(s.errors[0], /內容過濾擋下/);
  assert.doesNotMatch(s.errors[0], /秒時停掉/);
  assert.match(s.errors[0], /content safety filters[\s\S]*Retries remaining: 3/);
  assert.equal(_state().lastTurn.contentBlocked, true);
});

test('content filter before any text → HTTP 502 with the filter message, quickly (stream and json)', async () => {
  for (const stream of [true, false]) {
    const t0 = Date.now();
    const res = await chat({ model: M, messages: msgs('#filter0'), stream });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error.message, /薄荷橋：被 Google 的內容過濾擋下了/);
    assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0} ms`);
  }
});

test('bridge timeout → says the bridge stopped agy after N s; no misleading "exited with code"', async () => {
  _setConfig({ printTimeoutSec: 1, watchdogExtraSec: 0 });
  const res = await chat({ model: M, messages: msgs('#hang'), stream: true });
  assert.equal(res.status, 502);
  const m = (await res.json()).error.message;
  assert.match(m, /橋在 \d+ 秒時停掉了 agy/);
  assert.doesNotMatch(m, /exited with code/);
  assert.equal(_state().lastTurn.timedOut, true);
});

test('agy exits with code 1 and says nothing → its own readable message, not the timeout one', async () => {
  const res = await chat({ model: M, messages: msgs('#exit1') });
  assert.equal(res.status, 502);
  const m = (await res.json()).error.message;
  assert.match(m, /agy 自己中途結束了（代碼 1）/);
  assert.doesNotMatch(m, /停掉了 agy/);
});

test('max_tokens: long reply is stopped near the limit with finish_reason "length" (stream and json)', async () => {
  const s = await sseText(await chat({ model: M, messages: msgs('#long'), stream: true, max_tokens: 50 }));
  assert.equal(s.finish, 'length'); assert.ok(s.done); assert.deepEqual(s.errors, []);
  assert.ok(s.text.length >= 50 && s.text.length < 80, `got ${s.text.length} chars`);
  assert.equal(_state().lastTurn.capped, true);
  const j = await (await chat({ model: M, messages: msgs('#long'), max_tokens: 50 })).json();
  assert.equal(j.choices[0].finish_reason, 'length');
  assert.ok(j.choices[0].message.content.length < 80);
});

test('max_tokens: above the reply length, or honorMaxTokens off → the whole reply, finish "stop"', async () => {
  const s = await sseText(await chat({ model: M, messages: msgs('#long'), stream: true, max_tokens: 4000 }));
  assert.equal(s.finish, 'stop'); assert.equal(s.text.length, 60 * 13);
  _setConfig({ honorMaxTokens: false });
  const j = await (await chat({ model: M, messages: msgs('#long'), max_tokens: 50 })).json();
  assert.equal(j.choices[0].finish_reason, 'stop');
  assert.equal(j.choices[0].message.content.length, 60 * 13);
});

test('oversized latest message goes into the agent file; stdin only gets the pointer', async () => {
  const big = '長'.repeat(70000) + 'TAIL-MARK';
  const res = await chat({ model: M, messages: msgs(big) });
  assert.equal(res.status, 200);
  const seen = seenArgs();
  assert.ok(Buffer.byteLength(seen.msg) < 1000, 'stdin stayed small');
  assert.ok(seen.agentText.trimEnd().endsWith('TAIL-MARK\n</latest_message>'));
  assert.equal(_state().lastTurn.movedToAgentFile, true);
});

test('unexpected agy step (tool) is flagged in lastTurn', async () => {
  await (await chat({ model: M, messages: msgs('#tool') })).json();
  assert.deepEqual(_state().lastTurn.alarm.unexpectedSteps, ['run_command']);
});

test('a last line without newline is still parsed (denied action alarm)', async () => {
  const j = await (await chat({ model: M, messages: msgs('#nonl') })).json();
  assert.match(j.choices[0].message.content, /^echo:#nonl/);
  assert.deepEqual(_state().lastTurn.alarm.deniedActions, [{ tool: 'write_to_file' }]);
});

test('agy exits but a grandchild keeps its pipes open → the reply still finishes promptly', async () => {
  const t0 = Date.now();
  const j = await (await chat({ model: M, messages: msgs('#grandchild') })).json();
  assert.match(j.choices[0].message.content, /^echo:#grandchild/);
  assert.ok(Date.now() - t0 < 6000, `took ${Date.now() - t0} ms`);
});

// ── superseding, parallel chats, disconnects ──────────────────────────────
test('same chat: a new request supersedes the one in flight (swipe while generating)', async () => {
  const first = chat({ model: M, messages: msgs('#slow 第一則'), stream: true });
  await sleep(500);
  const second = await sseText(await chat({ model: M, messages: msgs('第二則'), stream: true }));
  assert.match(second.text, /^echo:第二則/);
  const firstRes = await first;
  if (firstRes.status === 200) {
    const s = await sseText(firstRes);
    assert.equal(s.finish, 'length'); assert.ok(s.done);
  } else {
    assert.equal(firstRes.status, 409);   // superseded before its first text
  }
});

test('different chats run in parallel; neither is superseded', async () => {
  const a = chat({ model: M, messages: msgs('#slow A', 'CARD-A'), stream: true });
  await sleep(200);
  const b = chat({ model: M, messages: msgs('#slow B', 'CARD-B'), stream: true });
  const [ra, rb] = await Promise.all([a, b]);
  const [sa, sb] = await Promise.all([sseText(ra), sseText(rb)]);
  assert.match(sa.text, /^echo:#slow A/); assert.equal(sa.finish, 'stop');
  assert.match(sb.text, /^echo:#slow B/); assert.equal(sb.finish, 'stop');
});

test('maxConcurrent: a third chat beyond the limit gets 429', async () => {
  _setConfig({ maxConcurrent: 1 });
  const a = chat({ model: M, messages: msgs('#slow A', 'CARD-A1'), stream: true });
  await sleep(300);
  const b = await chat({ model: M, messages: msgs('B', 'CARD-B1'), stream: true });
  assert.equal(b.status, 429);
  await sseText(await a);
});

async function disconnectMidReply(latest) {
  const ac = new AbortController();
  const p = chat({ model: M, messages: msgs(latest), stream: true }, { signal: ac.signal }).then(r => r.body.getReader().read()).catch(() => {});
  await sleep(400);
  ac.abort(); await p;
  await sleep(200);   // let the server notice the closed connection
}

test('disconnect mid-reply → reply finishes, regenerate (after it finished) gets it whole without a new agy run', async () => {
  await disconnectMidReply('#slow 斷線測試');
  await sleep(2500);
  assert.equal(_state().resumeKeys.length, 1);
  fs.rmSync(argsOut, { force: true });
  const again = await sseText(await chat({ model: M, messages: msgs('#slow 斷線測試'), stream: true }));
  assert.match(again.text, /^echo:#slow 斷線測試\|agent=/);
  assert.ok(!fs.existsSync(argsOut), 'served from the resume store, agy not run again');
  assert.equal(_state().resumeKeys.length, 0);
});

test('disconnect mid-reply → regenerate while it is still running joins it (waiter path)', async () => {
  await disconnectMidReply('#slow 等待者');
  fs.rmSync(argsOut, { force: true });
  const again = await sseText(await chat({ model: M, messages: msgs('#slow 等待者'), stream: true }));
  assert.match(again.text, /^echo:#slow 等待者\|agent=/);
  await sleep(100);
  assert.ok(!fs.existsSync(argsOut), 'joined the running reply, agy not run again');
  assert.equal(_state().resumeKeys.length, 0);
});

test('keepOnDisconnect=false → disconnect stops agy; regenerate runs a fresh one', async () => {
  _setConfig({ keepOnDisconnect: false });
  await disconnectMidReply('#slow 停止');
  await sleep(2500);
  assert.equal(_state().resumeKeys.length, 0);
  fs.rmSync(argsOut, { force: true });
  const again = await sseText(await chat({ model: M, messages: msgs('#slow 停止'), stream: true }));
  assert.match(again.text, /^echo:#slow 停止/);
  assert.ok(fs.existsSync(argsOut), 'agy ran again');
  assert.equal(agentFilesLeft(), 0);
});

// ── server guards ────────────────────────────────────────────────────────
function rawRequest({ method = 'GET', pathName = '/v1/models', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = http.request({ host: u.hostname, port: u.port, method, path: pathName, headers }, res => {
      let data = ''; res.on('data', d => { data += d; }); res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('guards: text/plain POST → 415, foreign Host → 403, health always open', async () => {
  const port = new URL(base).port;
  assert.equal((await rawRequest({ method: 'POST', pathName: '/config', headers: { 'content-type': 'text/plain', host: `127.0.0.1:${port}` }, body: '{"framing":"evil"}' })).status, 415);
  assert.equal((await rawRequest({ pathName: '/v1/models', headers: { host: `evil.example:${port}` } })).status, 403);
  assert.equal((await rawRequest({ pathName: '/healthz', headers: { host: `evil.example:${port}` } })).status, 200);
  assert.equal((await rawRequest({ pathName: '/v1/models', headers: { host: `localhost:${port}` } })).status, 200);
});

test('guards: apiKey required when set', async () => {
  _setConfig({ apiKey: 'k1' });
  assert.equal((await fetch(`${base}/v1/models`)).status, 401);
  assert.equal((await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer k1' } })).status, 200);
});

test('POST /config clamps values', async () => {
  const r = await fetch(`${base}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ printTimeoutSec: 99999999, maxConcurrent: 3 }) });
  const j = await r.json();
  assert.equal(j.printTimeoutSec, 86400);
  assert.equal(j.maxConcurrent, 3);
});

test('bad requests', async () => {
  assert.equal((await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })).status, 400);
  assert.equal((await chat({ messages: 'x' })).status, 400);
});
