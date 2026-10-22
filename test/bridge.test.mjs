// End-to-end over HTTP against a fake agy (test/fixtures/fake-agy.mjs): no network, no quota.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, _setConfig, _setWorkspace, _setModels, _state, _forgetAgy, STALL_RETRY_NOTE } from '../index.mjs';
import { maskHome } from '../lib/agy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mint-test-'));
const dataDir = path.join(tmp, 'agydata');
const ws = path.join(tmp, 'ws');
const argsOut = path.join(tmp, 'args.json');
const keptDir = path.join(tmp, 'kept-logs');
const BASE_CFG = { host: '127.0.0.1', apiKey: '', agyPath: path.join(here, 'fixtures', 'fake-agy.mjs'), agyDataDir: dataDir, usageLog: false, framing: 'FRAME', stdinLimitBytes: 180000, maxRetries: 0, keepOnDisconnect: true, maxConcurrent: 2, printTimeoutSec: 300, watchdogExtraSec: 30, honorMaxTokens: true, stallSec: 120, stallRetry: true, statusRecheckMs: 5000, doneGraceMs: 5000, stallFirstSec: 180, keptLogsDir: keptDir, cleanupRetryMs: 300, platform: process.platform };   // platform: not a config.json key — tests run the Windows branches on any OS by setting 'win32'
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
// Windows: a fake agy killed a moment ago may still hold its working folder, so retry the removal for a while.
// Removing the temp folder is housekeeping, not a test: Windows sometimes keeps it locked for a moment
// after the last fake agy was killed (checked 26-10-20: no fake agy left running at that point).
after(async () => {
  server.close();
  await sleep(1000);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
  catch (err) { console.warn(`(temp folder left behind: ${err.code} ${tmp})`); }
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
// The bridge answers as soon as the reply is complete and tidies up (status, files) once agy has exited,
// so after reading a body the tests wait for that tidy-up before looking at files or lastTurn.
async function settle(maxMs = 1500) {
  const t0 = Date.now();
  while (_state().busy > 0 && Date.now() - t0 < maxMs) await sleep(20);
  await sleep(20);
}
const chat = async (body, extra = {}) => {
  const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...(extra.headers || {}) }, body: JSON.stringify(body), signal: extra.signal });
  const json = res.json.bind(res), text = res.text.bind(res);
  res.json = async () => { const j = await json(); await settle(); return j; };
  res.text = async () => { const t = await text(); await settle(); return t; };
  return res;
};
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

test('model not in the account list → error with the list (400 stream / 200+error json), agy never started', async () => {
  fs.rmSync(argsOut, { force: true });
  const res = await chat({ model: 'claude-opus-4-6', messages: msgs('x'), stream: true });
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
// Non-streaming failures are HTTP 200 + {error}: SillyTavern's backend drops the body of a non-2xx
// non-streaming reply and shows only "Bad Gateway".
const failStatus = stream => (stream ? 502 : 200);

test('429 before any text → readable error, not a chat reply (502 stream / 200+error json)', async () => {
  for (const stream of [true, false]) {
    const res = await chat({ model: M, messages: msgs('#429'), stream });
    assert.equal(res.status, failStatus(stream));
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

test('content filter before any text → the filter message, quickly (stream and json)', async () => {
  for (const stream of [true, false]) {
    const t0 = Date.now();
    const res = await chat({ model: M, messages: msgs('#filter0'), stream });
    assert.equal(res.status, failStatus(stream));
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
  assert.equal(res.status, 200);   // non-streaming: 200 + error
  assert.equal((await res.clone().json()).choices, undefined);
  const m = (await res.json()).error.message;
  assert.match(m, /agy 自己中途結束了（代碼 1）/);
  assert.doesNotMatch(m, /停掉了 agy/);
});

test('max_tokens: long reply is stopped near the limit with finish_reason "length", agy killed (stream and json)', async () => {
  const t0 = Date.now();
  const s = await sseText(await chat({ model: M, messages: msgs('#long #stall'), stream: true, max_tokens: 50 }));
  assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0} ms (fake agy stalls 20 s after its text)`);
  assert.equal(s.finish, 'length'); assert.ok(s.done); assert.deepEqual(s.errors, []);
  assert.ok(s.text.length >= 50 && s.text.length < 80, `got ${s.text.length} chars`);
  assert.equal(_state().lastTurn.capped, true);
  const j = await (await chat({ model: M, messages: msgs('#long'), max_tokens: 50 })).json();
  assert.equal(j.choices[0].finish_reason, 'length');
  assert.ok(j.choices[0].message.content.length < 80);
});

test('reply that itself quotes the filter sentence is NOT treated as filtered', async () => {
  for (const stream of [true, false]) {
    const res = await chat({ model: M, messages: msgs('#quote'), stream });
    assert.equal(res.status, 200);
    if (stream) {
      const s = await sseText(res);
      assert.deepEqual(s.errors, []); assert.equal(s.finish, 'stop');
      assert.match(s.text, /blocked by content safety filters/);
    } else {
      const j = await res.json();
      assert.equal(j.error, undefined);
      assert.match(j.choices[0].message.content, /Prohibited Use policy/);
    }
    assert.equal(_state().lastTurn.contentBlocked, false);
  }
});

test('max_completion_tokens wins over max_tokens; non-integer values are ignored', async () => {
  const a = await (await chat({ model: M, messages: msgs('#long'), max_tokens: 4000, max_completion_tokens: 30 })).json();
  assert.equal(a.choices[0].finish_reason, 'length');
  assert.equal(_state().lastTurn.maxTokens, 30);
  const b = await (await chat({ model: M, messages: msgs('#long'), max_tokens: 30.5 })).json();
  assert.equal(b.choices[0].finish_reason, 'stop');
});

test('max_tokens: whitespace-only text never counts as "reached the limit"', async () => {
  const j = await (await chat({ model: M, messages: msgs('#blankfirst'), max_tokens: 1 })).json();
  assert.equal(j.choices[0].finish_reason, 'length');
  assert.ok(j.choices[0].message.content.trim().length > 0);
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
  await res.json();
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

// ── 0.1.2: stalled half-way, thinking blocks and max_tokens, agy looked up again ──
const stallMark = () => path.join(dataDir, 'stalled-once');

test('stall (stream): text stops for stallSec → agy stopped, sent again once; half kept, marked line, then the new reply', async () => {
  fs.rmSync(stallMark(), { force: true });
  _setConfig({ stallSec: 1 });
  const t0 = Date.now();
  const s = await sseText(await chat({ model: M, messages: msgs('#stallonce'), stream: true }));
  assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0} ms (fake agy goes silent for 20 s)`);
  assert.equal(s.text, `前半段寫到一半${STALL_RETRY_NOTE}重來的回覆。`);
  assert.equal(s.finish, 'stop'); assert.ok(s.done); assert.deepEqual(s.errors, []);
  const lt = _state().lastTurn;
  assert.equal(lt.ok, true); assert.equal(lt.retriedAfterStall, true); assert.equal(lt.stalled, false);
  assert.equal(agentFilesLeft(), 0);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'conversations')), []);   // both runs cleaned up
});

test('stall (json): only the second run\'s reply, no half and no marker line', async () => {
  fs.rmSync(stallMark(), { force: true });
  _setConfig({ stallSec: 1 });
  const j = await (await chat({ model: M, messages: msgs('#stallonce') })).json();
  assert.equal(j.choices[0].message.content, '重來的回覆。');
  assert.equal(j.choices[0].finish_reason, 'stop');
});

test('stall twice → only one retry; error event says the model went quiet for N s and that it was sent again', async () => {
  _setConfig({ stallSec: 1 });
  const t0 = Date.now();
  const s = await sseText(await chat({ model: M, messages: msgs('#stallalways'), stream: true }));
  assert.ok(Date.now() - t0 < 10000, `took ${Date.now() - t0} ms`);
  assert.equal(s.text, `前半段寫到一半${STALL_RETRY_NOTE}前半段寫到一半`);
  assert.equal(s.errors.length, 1);
  assert.match(s.errors[0], /模型那頭 1 秒沒出字/); assert.match(s.errors[0], /重送過一次/);
  assert.doesNotMatch(s.errors[0], /橋在 \d+ 秒時停掉了/);   // not the overall-timeout wording
  const lt = _state().lastTurn;
  assert.equal(lt.stalled, true); assert.equal(lt.retriedAfterStall, true);
  assert.equal(lt.tokPerSec, null);   // text arrived over less than a second: no speed rather than an absurd one
  fs.rmSync(stallMark(), { force: true });
});

test('stallRetry off → stopped once, no retry, no marker line', async () => {
  _setConfig({ stallSec: 1, stallRetry: false });
  const s = await sseText(await chat({ model: M, messages: msgs('#stallalways'), stream: true }));
  assert.equal(s.text, '前半段寫到一半');
  assert.match(s.errors[0], /模型那頭 1 秒沒出字/); assert.doesNotMatch(s.errors[0], /重送過一次/);
  assert.equal(_state().lastTurn.retriedAfterStall, undefined);
  fs.rmSync(stallMark(), { force: true });
});

test('slow but steady text is not a stall (gaps shorter than stallSec)', async () => {
  _setConfig({ stallSec: 1 });
  const s = await sseText(await chat({ model: M, messages: msgs('#slow'), stream: true }));
  assert.match(s.text, /^echo:#slow/); assert.deepEqual(s.errors, []);
  assert.equal(_state().lastTurn.stalled, false);
});

test('reply finished (DONE) but agy slow to exit → not a stall, no retry', async () => {
  _setConfig({ stallSec: 1 });
  const s = await sseText(await chat({ model: M, messages: msgs('#donehang'), stream: true }));
  assert.equal(s.text, '完整的回覆。'); assert.deepEqual(s.errors, []); assert.equal(s.finish, 'stop');
  assert.equal(_state().lastTurn.stalled, false); assert.equal(_state().lastTurn.retriedAfterStall, undefined);
});

test('reply complete but agy never exits → finished as a success within the grace, not at the timeout', async () => {
  _setConfig({ doneGraceMs: 300 });
  for (const stream of [true, false]) {
    const t0 = Date.now();
    const res = await chat({ model: M, messages: msgs('#donenoexit'), stream });
    const text = stream ? (await sseText(res)) : (await res.json());
    assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms (fake agy never exits)`);
    if (stream) { assert.equal(text.text, '正文生完了。\n'); assert.equal(text.finish, 'stop'); assert.ok(text.done); assert.deepEqual(text.errors, []); }
    else assert.equal(text.choices[0].message.content, '正文生完了。\n');
    const lt = _state().lastTurn;
    assert.equal(lt.ok, true); assert.equal(lt.lingered, true); assert.equal(lt.timedOut, false); assert.equal(lt.usage.output_tokens, 3961);
    // agy's log of that run is kept (redacted), and agy's conversation files are gone
    assert.match(lt.agyLog, /^logs\/.*_lingered\.log$/);
    const kept = fs.readFileSync(path.join(keptDir, path.basename(lt.agyLog)), 'utf8');
    assert.match(kept, /applyAuthResult/);
    for (const secret of ['player@example.com', 'my-proj-123', 'Player']) assert.ok(!kept.includes(secret), `${secret} left in the kept log`);
    assert.match(kept, /workspace ~.Secret Folder.ws/);   // another player's home folder becomes ~, the rest of the path stays
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'conversations')), []);
  }
});

test('the client is answered when the reply is complete, not when agy finally exits', async () => {
  _setConfig({ doneGraceMs: 2500 });
  const t0 = Date.now();
  const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: M, messages: msgs('#donenoexit'), stream: true }) });
  const raw = await res.text();
  assert.ok(Date.now() - t0 < 1500, `answered after ${Date.now() - t0} ms; agy is stopped only at 2.5 s`);
  assert.match(raw, /data: \[DONE\]/);
  await settle(5000);
  assert.equal(_state().lastTurn.lingered, true);
  assert.deepEqual(_state().resumeKeys, []);   // closing the stream ourselves is not a disconnect: nothing stored for "resume"
});

test('DONE without a result event and no exit: answered after the grace; telemetry says so (sawResult false, hang ≈ grace)', async () => {
  _setConfig({ doneGraceMs: 400 });
  const s = await sseText(await chat({ model: M, messages: msgs('#doneonly'), stream: true }));
  assert.equal(s.text, '只有完成訊號。'); assert.equal(s.finish, 'stop'); assert.deepEqual(s.errors, []);
  const lt = _state().lastTurn;
  assert.equal(lt.ok, true); assert.equal(lt.lingered, true); assert.equal(lt.sawResult, false);
  assert.ok(lt.postDoneHangSec >= 0.3 && lt.postDoneHangSec < 1.5, `postDoneHangSec ${lt.postDoneHangSec}`);
});

test('text after a DONE (a second reply step) is kept: the turn is not cut at the first DONE', async () => {
  _setConfig({ doneGraceMs: 500 });   // shorter than the whole second step: the first DONE's timer must be called off
  const s = await sseText(await chat({ model: M, messages: msgs('#twodone'), stream: true }));
  assert.equal(s.text, '第一段。第二段。'); assert.equal(s.finish, 'stop'); assert.deepEqual(s.errors, []);
  assert.equal(_state().lastTurn.textAfterDone, true); assert.equal(_state().lastTurn.lingered, undefined);
});

test('stall retry after a finished <think> block: the retry\'s own thinking is left out of the stream', async () => {
  fs.rmSync(stallMark(), { force: true });
  _setConfig({ stallSec: 1 });
  const s = await sseText(await chat({ model: M, messages: msgs('#stallthink'), stream: true }));
  assert.equal(s.text, `<think>想A</think>\n半截${STALL_RETRY_NOTE}全文。`);
  assert.equal(s.errors.length, 0);
});

test('a thinking tag that never closes properly does not switch max_tokens off', async () => {
  const s = await sseText(await chat({ model: M, messages: msgs('#mismatch'), stream: true, max_tokens: 100 }));
  assert.equal(s.finish, 'length');
  assert.equal(_state().lastTurn.capped, true);
});

test('silence before the first word longer than stallFirstSec → stopped and sent again; the error says nothing came at all', async () => {
  _setConfig({ stallFirstSec: 1 });
  const t0 = Date.now();
  const res = await chat({ model: M, messages: msgs('#hang'), stream: true });
  assert.equal(res.status, 502);
  const m = (await res.json()).error.message;
  assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0} ms`);
  assert.match(m, /模型那頭 1 秒沒出字/); assert.match(m, /一個字都還沒出/); assert.match(m, /重送過一次/);
  assert.equal(_state().lastTurn.stalledBeforeText, true); assert.equal(_state().lastTurn.retriedAfterStall, true);
});

test('max_tokens does not count a <think> block written into the reply', async () => {
  const s = await sseText(await chat({ model: M, messages: msgs('#think'), stream: true, max_tokens: 100 }));
  assert.equal(s.finish, 'stop'); assert.match(s.text, /<\/think>\n狐狸回家了。$/);
  assert.equal(_state().lastTurn.capped, false);
});

test('/status: agy missing → agyPath advice first and the error code; agy back → looked up again, warning gone', async () => {
  // A path under the home folder (nothing is created there): what is tested is the masking, and on macOS / Linux
  // os.tmpdir() is not under the home folder. Forward slashes, the other case: still masked.
  _setConfig({ agyPath: path.join(os.homedir(), 'mint-test-no-such', 'no-such-agy.exe').replace(/\\/g, '/').toUpperCase(), statusRecheckMs: 0 });
  let st = await (await fetch(`${base}/status`)).json();
  assert.equal(st.agy.version, null);
  assert.match(st.warnings[0], /agyPath/);
  assert.ok(!st.warnings.some(w => /不在驗過的版本/.test(w)), JSON.stringify(st.warnings));   // no bogus "agy null not tested"
  assert.match(st.agy.error, /ENOENT/);
  assert.ok(!JSON.stringify(st).toLowerCase().includes(os.userInfo().username.toLowerCase()), `user name shown: ${JSON.stringify(st)}`);
  assert.match(st.agy.path, /^~/);
  _setConfig({ agyPath: BASE_CFG.agyPath, statusRecheckMs: 0 });
  st = await (await fetch(`${base}/status`)).json();
  assert.equal(st.agy.version, '1.4.2');
  assert.equal(st.agy.error, undefined);
  assert.ok(!st.warnings.some(w => /找不到 agy/.test(w)), JSON.stringify(st.warnings));
});

// 26-10-21 朔牽星: an agy installed from inside the Claude desktop app (MSIX) is ENOENT for a SillyTavern
// started from the desktop, full agyPath or not. The hint fits ENOENT under AppData\Local and nothing else.
test('/status: ENOENT on a path under AppData\\Local → the MSIX hint right after the agyPath advice; ENOENT elsewhere → no hint', async () => {
  const MSIX = /Claude 桌面版/;
  _forgetAgy();
  _setConfig({ agyPath: path.join(tmp, 'AppData', 'Local', 'agy', 'bin', 'agy.exe'), statusRecheckMs: 0, platform: 'win32' });
  let st = await (await fetch(`${base}/status`)).json();
  assert.equal(st.agy.version, null);
  assert.match(st.agy.error, /ENOENT/);
  assert.match(st.warnings[0], /agyPath/);
  assert.match(st.warnings[1], MSIX);
  assert.match(st.warnings[1], /explorer\.exe/);
  assert.equal(st.warnings.filter(w => MSIX.test(w)).length, 1);
  assert.ok(!JSON.stringify(st).toLowerCase().includes(os.userInfo().username.toLowerCase()), `user name shown: ${JSON.stringify(st)}`);

  // The model list failing for the same reason must not repeat the two sentences above.
  _setModels([]);
  await fetch(`${base}/v1/models`);
  st = await (await fetch(`${base}/status`)).json();
  assert.equal(st.warnings.filter(w => MSIX.test(w)).length, 1, JSON.stringify(st.warnings));
  assert.equal(st.warnings.filter(w => /agyPath/.test(w)).length, 1, JSON.stringify(st.warnings));
  _setModels([{ id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' }, { id: 'gemini-3.8-flash-low', label: 'Flash' }]);

  // Same ENOENT, a path outside AppData\Local: no hint.
  _forgetAgy();
  _setConfig({ agyPath: path.join(path.parse(tmp).root, `mint-no-such-${process.pid}`, 'agy.exe'), statusRecheckMs: 0, platform: 'win32' });
  st = await (await fetch(`${base}/status`)).json();
  assert.equal(st.agy.version, null);
  assert.match(st.agy.error, /ENOENT/);
  assert.match(st.warnings[0], /agyPath/); assert.match(st.warnings[0], /%LOCALAPPDATA%/);
  assert.ok(!st.warnings.some(w => MSIX.test(w)), JSON.stringify(st.warnings));

  // The same AppData\Local path and the same ENOENT on macOS / Linux: MSIX is a Windows thing, no hint; the advice names which agy, not agy.exe.
  for (const platform of ['linux', 'darwin']) {
    _forgetAgy();
    _setConfig({ agyPath: path.join(tmp, 'AppData', 'Local', 'agy', 'bin', 'agy.exe'), statusRecheckMs: 0, platform });
    st = await (await fetch(`${base}/status`)).json();
    assert.equal(st.agy.version, null); assert.match(st.agy.error, /ENOENT/);
    assert.match(st.warnings[0], /agyPath/); assert.match(st.warnings[0], /which agy/); assert.doesNotMatch(st.warnings[0], /agy\.exe|%LOCALAPPDATA%/);
    if (platform === 'darwin') assert.match(st.warnings[0], /homebrew/);
    assert.ok(!st.warnings.some(w => MSIX.test(w)), JSON.stringify(st.warnings));
    assert.equal(st.agy.hiddenIn, undefined);
  }

  // agy back: the hint goes with the error.
  _setConfig({ agyPath: BASE_CFG.agyPath, statusRecheckMs: 0 });
  st = await (await fetch(`${base}/status`)).json();
  assert.equal(st.agy.version, '1.4.2');
  assert.ok(!st.warnings.some(w => MSIX.test(w)), JSON.stringify(st.warnings));
});

// The drawer is readable from outside: when some app's LocalCache holds an agy, say which and where.
test('/status: the agy found in an app\'s LocalCache drawer → the warning names the app and the path, agy.hiddenIn set', async () => {
  const fakeLocal = path.join(tmp, 'fake-localappdata');
  const drawer = path.join(fakeLocal, 'Packages', 'Claude_test1234', 'LocalCache', 'Local', 'agy', 'bin');
  fs.mkdirSync(drawer, { recursive: true });
  fs.writeFileSync(path.join(drawer, 'agy.exe'), 'MZ');
  const savedLocal = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = fakeLocal;
  try {
    _forgetAgy();
    _setConfig({ agyPath: path.join(tmp, 'AppData', 'Local', 'agy', 'bin', 'agy.exe'), statusRecheckMs: 0, platform: 'win32' });
    const st = await (await fetch(`${base}/status`)).json();
    assert.equal(st.agy.version, null);
    assert.match(st.warnings[1], /agy 其實在 Claude_test1234 這個 App 的私人抽屜裡/);
    assert.ok(st.warnings[1].includes(String.raw`Claude_test1234\LocalCache\Local\agy\bin\agy.exe`.replace(/\\/g, path.sep)), st.warnings[1]);
    assert.doesNotMatch(st.warnings[1], /若是/);
    assert.ok(st.agy.hiddenIn && st.agy.hiddenIn.includes('Claude_test1234'), JSON.stringify(st.agy));
    assert.ok(!JSON.stringify(st).toLowerCase().includes(os.userInfo().username.toLowerCase()), `user name shown: ${JSON.stringify(st)}`);
  } finally {
    process.env.LOCALAPPDATA = savedLocal;
    _setConfig({ agyPath: BASE_CFG.agyPath, statusRecheckMs: 0 });
    await fetch(`${base}/status`);
  }
});

// The real incident's path: no agyPath, the default location is missing, and "agy.exe" is not on PATH.
// The status page judges from the default location; the chat error must carry the same verdict although
// the spawn error only says "agy.exe". Run as Windows on every OS (0.1.4): the fake LOCALAPPDATA is an
// AppData\Local folder under the temp folder, so the default location fits the hint anywhere.
test('no agyPath, default location missing → MSIX hint on /status and in the chat error', async () => {
  const fakeLocal = path.join(tmp, 'AppData', 'Local');
  fs.mkdirSync(fakeLocal, { recursive: true });
  const emptyPath = path.join(tmp, 'empty-path');
  fs.mkdirSync(emptyPath, { recursive: true });
  const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, PATH: process.env.PATH };
  process.env.LOCALAPPDATA = fakeLocal;
  process.env.PATH = emptyPath;              // a bare "agy.exe" must be ENOENT whatever this machine has installed
  try {
    _forgetAgy();
    _setConfig({ agyPath: '', statusRecheckMs: 0, platform: 'win32' });
    const st = await (await fetch(`${base}/status`)).json();
    assert.equal(st.agy.version, null);
    assert.equal(st.agy.path, 'agy.exe');
    assert.match(st.agy.error, /預設位置讀不到 agy/); assert.match(st.agy.error, /ENOENT/);
    assert.match(st.warnings[1], /Claude 桌面版/);
    const res = await chat({ model: M, messages: msgs('#msix'), stream: false });
    const body = await res.json();
    const message = body.error?.message || body.error || '';
    assert.match(message, /找不到 agy 程式/); assert.match(message, /Claude 桌面版/); assert.match(message, /MSIX 封裝 App 的檔案虛擬化/);
  } finally {
    process.env.LOCALAPPDATA = saved.LOCALAPPDATA; process.env.PATH = saved.PATH;
    _setConfig({ agyPath: BASE_CFG.agyPath, statusRecheckMs: 0 });
    await fetch(`${base}/status`);
  }
});

// ── 0.1.4: macOS / Linux ──────────────────────────────────────────────────
// No agyPath, an executable named agy in a PATH folder (a wrapper around the fake): found through PATH, run
// through PATH, and the status page shows where it is. Windows has no such wrapper (a .cmd cannot be run
// without a shell), so there the PATH scan is covered by the unit tests only.
test('no agyPath: an executable agy on PATH is found and run; /status shows its path (macOS / Linux)', { skip: process.platform === 'win32' }, async () => {
  const binDir = path.join(tmp, 'path-bin'); fs.mkdirSync(binDir, { recursive: true });
  const wrapper = path.join(binDir, 'agy');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${BASE_CFG.agyPath}" "$@"\n`); fs.chmodSync(wrapper, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${binDir}:${savedPath}`;
  try {
    _forgetAgy();
    _setConfig({ agyPath: '', statusRecheckMs: 0 });
    const st = await (await fetch(`${base}/status`)).json();
    assert.equal(st.agy.version, '1.4.2', JSON.stringify(st.agy));
    assert.equal(st.agy.path, maskHome(wrapper));
    assert.equal(st.agy.error, undefined);
    assert.deepEqual(st.warnings.filter(w => /agyPath|桌面版/.test(w)), []);
    const j = await (await chat({ model: M, messages: msgs('經由 PATH') })).json();
    assert.match(j.choices[0].message.content, /^echo:經由 PATH/);
  } finally {
    process.env.PATH = savedPath;
    _setConfig({ agyPath: BASE_CFG.agyPath, statusRecheckMs: 0 });
    await fetch(`${base}/status`);
  }
});

// Is a process gone? ESRCH, or (Linux) a zombie nobody reaped yet.
const gone = pid => {
  try { process.kill(pid, 0); } catch { return true; }
  try { return /^State:\s+Z/m.test(fs.readFileSync(`/proc/${pid}/status`, 'utf8')); } catch { return false; }
};

// A stopped agy takes the helpers it started with it: taskkill /T on Windows, the process group elsewhere
// (before 0.1.4, SIGTERM reached agy alone and a helper of a stalled agy ran on).
test('stall → agy is stopped together with the helper it started', async () => {
  const pidFile = path.join(tmp, 'helper.pid'); fs.rmSync(pidFile, { force: true });
  process.env.FAKE_AGY_GRANDCHILD_OUT = pidFile;
  _setConfig({ stallFirstSec: 1, stallRetry: false });
  try {
    const body = await (await chat({ model: M, messages: msgs('#hanghelper'), stream: false })).json();
    assert.match(body.error.message, /模型那頭 1 秒沒出字/);
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.ok(pid > 0, `helper pid: ${pid}`);
    let left = true;
    for (let i = 0; i < 50 && left; i++) { left = !gone(pid); if (left) await sleep(100); }
    assert.equal(left, false, `helper ${pid} still running`);
  } finally { delete process.env.FAKE_AGY_GRANDCHILD_OUT; }
});
