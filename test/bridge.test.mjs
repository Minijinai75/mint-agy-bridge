// End-to-end over HTTP against a fake agy (test/fixtures/fake-agy.mjs): no network, no quota.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleChatCompletions, _setConfig, _setWorkspace, _setModels, _state } from '../index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mint-test-'));
const dataDir = path.join(tmp, 'agydata');
const ws = path.join(tmp, 'ws');
const argsOut = path.join(tmp, 'args.json');
let server, base;

before(async () => {
  process.env.FAKE_AGY_DATA = dataDir;
  process.env.FAKE_AGY_ARGS_OUT = argsOut;
  _setConfig({ agyPath: path.join(here, 'fixtures', 'fake-agy.mjs'), agyDataDir: dataDir, usageLog: false, framing: 'FRAME', stdinLimitBytes: 180000, maxRetries: 0 });
  _setWorkspace(ws, path.join(tmp, 'logs'));
  _setModels([{ id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' }, { id: 'gemini-3.8-flash-low', label: 'Flash' }]);
  server = http.createServer((req, res) => handleChatCompletions(req, res));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const chat = (body) => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function sseText(res) {
  const raw = await res.text();
  let text = '', finish = null, done = false;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const d = line.slice(6);
    if (d === '[DONE]') { done = true; continue; }
    const j = JSON.parse(d);
    text += j.choices[0].delta.content || '';
    finish = j.choices[0].finish_reason || finish;
  }
  return { text, finish, done };
}
const msgs = (latest) => [{ role: 'system', content: 'CARD-起' }, { role: 'assistant', content: '歡迎光臨' }, { role: 'user', content: latest }];
const agentFilesLeft = () => fs.readdirSync(path.join(ws, '.agents', 'agents')).length;

test('streaming reply: text arrives, agent file + agy conversation files are cleaned up', async () => {
  const res = await chat({ model: 'gemini-4-argon-high', messages: msgs('早安'), stream: true });
  assert.equal(res.status, 200);
  const { text, finish, done } = await sseText(res);
  assert.match(text, /^echo:早安\|agent=\d+\|tail=/);
  assert.equal(finish, 'stop'); assert.ok(done);
  const seen = JSON.parse(fs.readFileSync(argsOut, 'utf8'));
  assert.ok(seen.agentText.includes('CARD-起') && seen.agentText.includes('歡迎光臨'));
  assert.ok(seen.agentText.includes('tools: []'));
  for (const f of ['--sandbox', '--disable-slash-commands', '--print-timeout', '--agent']) assert.ok(seen.argv.includes(f), f);
  assert.equal(seen.argv[seen.argv.indexOf('--model') + 1], 'gemini-4-argon-high');
  assert.equal(seen.env.retries, '0'); assert.equal(seen.env.noUpdate, '1');
  assert.equal(agentFilesLeft(), 0);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'conversations')), []);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'brain')), []);
});

test('non-streaming reply returns an OpenAI chat.completion with usage', async () => {
  const res = await chat({ model: 'gemini-4-argon-high', messages: msgs('hi'), stream: false });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.match(j.choices[0].message.content, /^echo:hi/);
  assert.equal(j.usage.prompt_tokens, 100);
  assert.equal(j.usage.completion_tokens, 20);
});

test('model not in the account list → 400 with the list, agy never started', async () => {
  fs.rmSync(argsOut, { force: true });
  const res = await chat({ model: 'claude-opus-4-6', messages: msgs('x'), stream: false });
  assert.equal(res.status, 400);
  const j = await res.json();
  assert.match(j.error.message, /gemini-4-argon-high/);
  assert.ok(!fs.existsSync(argsOut));
});

test('no model in request → first listed model', async () => {
  const res = await chat({ messages: msgs('預設'), stream: false });
  const seen = JSON.parse(fs.readFileSync(argsOut, 'utf8'));
  assert.equal(seen.argv[seen.argv.indexOf('--model') + 1], 'gemini-4-argon-high');
  assert.equal(res.status, 200);
});

test('429 from agy becomes a readable message (stream and json)', async () => {
  const s = await sseText(await chat({ model: 'gemini-4-argon-high', messages: msgs('#429'), stream: true }));
  assert.match(s.text, /薄荷橋：.*配額不夠/);
  const j = await chat({ model: 'gemini-4-argon-high', messages: msgs('#429'), stream: false });
  assert.equal(j.status, 502);
  assert.match((await j.json()).error.message, /配額不夠/);
});

test('oversized latest message goes into the agent file; stdin only gets the pointer', async () => {
  const big = '長'.repeat(70000) + 'TAIL-MARK';
  const res = await chat({ model: 'gemini-4-argon-high', messages: msgs(big), stream: false });
  assert.equal(res.status, 200);
  const seen = JSON.parse(fs.readFileSync(argsOut, 'utf8'));
  assert.ok(Buffer.byteLength(seen.msg) < 1000, 'stdin stayed small');
  assert.ok(seen.agentText.trimEnd().endsWith('TAIL-MARK\n</latest_message>'));
  assert.equal(_state().lastTurn.movedToAgentFile, true);
});

test('unexpected agy step (tool) is flagged in lastTurn', async () => {
  await (await chat({ model: 'gemini-4-argon-high', messages: msgs('#tool'), stream: false })).json();
  assert.deepEqual(_state().lastTurn.alarm.unexpectedSteps, ['run_command']);
});

test('a new request supersedes the one in flight (swipe while generating)', async () => {
  const first = chat({ model: 'gemini-4-argon-high', messages: msgs('#slow 第一則'), stream: true });
  await new Promise(r => setTimeout(r, 400));
  const second = await sseText(await chat({ model: 'gemini-4-argon-high', messages: msgs('第二則'), stream: true }));
  assert.match(second.text, /^echo:第二則/);
  const firstRes = await sseText(await first);
  assert.equal(firstRes.finish, 'length', 'superseded stream is closed, marked as cut short');
  assert.ok(firstRes.done);
});

test('SillyTavern disconnects mid-reply → reply finishes, regenerate gets it whole without a new agy run', async () => {
  const ac = new AbortController();
  const p = fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gemini-4-argon-high', messages: msgs('#slow 斷線測試'), stream: true }), signal: ac.signal })
    .then(r => r.body.getReader().read()).catch(() => {});
  await new Promise(r => setTimeout(r, 300));
  ac.abort(); await p;
  await new Promise(r => setTimeout(r, 2500));   // fake finishes in ~1.5 s
  assert.equal(_state().resumeKeys.length, 1);
  fs.rmSync(argsOut, { force: true });
  const again = await sseText(await chat({ model: 'gemini-4-argon-high', messages: msgs('#slow 斷線測試'), stream: true }));
  assert.match(again.text, /^echo:#slow 斷線測試\|agent=/);
  assert.ok(!fs.existsSync(argsOut), 'served from the resume store, agy not run again');
  assert.equal(_state().resumeKeys.length, 0);
});

test('bad requests', async () => {
  assert.equal((await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{nope' })).status, 400);
  assert.equal((await chat({ messages: 'x' })).status, 400);
});
