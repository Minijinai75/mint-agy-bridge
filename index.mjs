// Mint AGY Bridge (薄荷橋) — a SillyTavern server plugin that serves an OpenAI-compatible
// /v1/chat/completions endpoint backed by the official Antigravity CLI (`agy`).
//
// Each request: write the card + history into a throwaway agy custom agent (tools: [], no default
// agy prompt) → run `agy --print` once → stream the reply back → delete the agent file and agy's
// local copy of the conversation. See README.md for install, docs/DESIGN.md for the reasoning.

import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, applyRuntimePatch, publicConfig } from './lib/config.mjs';
import { parseMessages, textOf } from './lib/parse.mjs';
import { planTurn, agentNameFor, renderAgentFile } from './lib/agent-file.mjs';
import { humanError } from './lib/errors.mjs';
import { runTurn, fetchModels, agyVersion, readAgySettings, cleanupConversation, resolveAgyPath } from './lib/agy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ID = 'mint-agy-bridge';
const TAG = `[${PLUGIN_ID}]`;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MODELS_TTL_MS = 10 * 60 * 1000;
export const TESTED_AGY_VERSIONS = ['1.4.2'];

function readOwnVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
}

export const info = {
  id: PLUGIN_ID,
  name: 'Mint AGY Bridge',
  description: 'OpenAI-compatible endpoint for SillyTavern, backed by the official Antigravity CLI (agy).',
};

// ── state ─────────────────────────────────────────────────────────────────
let { cfg, fileError: configFileError } = loadConfig(__dirname);
let server = null;
let workspace = null;           // <tmp>/mint-agy-bridge-<port>/ws  (contains .agents/agents/)
let logsDir = null;
let current = null;             // ticket of the request being generated
let requestCount = 0;
let lastTurn = null;            // token counts and timing of the last reply (no content)
let agyInfo = { path: null, version: null, versionTested: null, settings: null };
const models = { list: [], at: 0, error: null, inflight: null };

// ── models ────────────────────────────────────────────────────────────────
export async function listModels({ refresh = false } = {}) {
  if (!refresh && models.list.length && Date.now() - models.at < MODELS_TTL_MS) return models.list;
  if (models.inflight) return models.inflight;
  models.inflight = (async () => {
    const { models: list, error } = await fetchModels(cfg);
    if (list.length) { models.list = list; models.at = Date.now(); models.error = null; }
    else { models.error = humanError(error); console.error(`${TAG} 模型清單拿不到：${models.error}`); }
    return models.list;   // keep the old list when a refresh fails
  })().finally(() => { models.inflight = null; });
  return models.inflight;
}

// ── resume: SillyTavern disconnected mid-reply → finish anyway, hand it over on regenerate ─
const resumeStore = new Map();   // key → { text, usage, at }
function resumeKey(modelId, messages) {
  let lastUser = '', prevAssistant = '', seenUser = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== 'object') continue;
    if (!seenUser && m.role === 'user') { lastUser = textOf(m); seenUser = true; continue; }
    if (seenUser && m.role === 'assistant') { prevAssistant = textOf(m); break; }
  }
  return createHash('sha256').update(JSON.stringify([modelId, messages.length, lastUser, prevAssistant])).digest('hex').slice(0, 16);
}
function pruneResume(now = Date.now()) {
  for (const [k, v] of resumeStore) if (now - v.at > cfg.resumeMinutes * 60000) resumeStore.delete(k);
}

// ── helpers ───────────────────────────────────────────────────────────────
function appendUsageLog(entry) {
  if (!cfg.usageLog) return;
  try {
    const dir = path.join(__dirname, 'usage');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${new Date().toISOString().slice(0, 7)}.jsonl`), JSON.stringify(entry) + '\n');
  } catch { /* never let bookkeeping break a reply */ }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0; let settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    req.on('data', c => {
      if (settled) return;
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) { finish(reject, new Error('oversized')); return; }
      chunks.push(c);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => finish(resolve, null));
  });
}

function sendJson(res, code, obj) {
  if (res.headersSent) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
const errorBody = (message, type = 'server_error') => ({ error: { message, type } });

function makeChunk(id, model, delta, finishReason) {
  return { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

function authorized(req) {
  if (!cfg.apiKey) return true;
  return (req.headers.authorization || '') === `Bearer ${cfg.apiKey}`;
}

function releaseCurrent(reason) {
  const t = current;
  if (!t) return;
  current = null;
  t.aborted = true;
  console.log(`${TAG} 前一則讓位（${reason}）`);
  t.handle?.kill();
}

function removeQuietly(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }

// ── /v1/chat/completions ──────────────────────────────────────────────────
export async function handleChatCompletions(req, res) {
  const ticket = { aborted: false, orphaned: false, handle: null, fp: null, done: null, result: null };
  let resolveDone; ticket.done = new Promise(r => { resolveDone = r; });
  let finished = false;
  let completionId = `chatcmpl-${randomUUID().slice(0, 8)}`;
  let modelId = null;
  const alive = () => !res.writableEnded && !res.destroyed;

  // SillyTavern closed the connection (phone locked, timeout, Stop button — indistinguishable).
  // Before agy started: drop it. After: let it finish and keep the reply for a regenerate.
  res.on('close', () => {
    if (finished || ticket.aborted || ticket.orphaned) return;
    if (!ticket.handle) { ticket.aborted = true; return; }
    ticket.orphaned = true;
    console.log(`${TAG} 酒館端斷線，這一則照樣生完先存著；按重新生成就拿整段。`);
  });

  const agentFiles = [];
  try {
    if (!workspace) return sendJson(res, 503, errorBody('薄荷橋還沒初始化完成（工作夾建立失敗，看酒館主控台）。'));
    let body;
    try { body = await readBody(req); }
    catch { return sendJson(res, 413, errorBody(`請求太大（上限 ${MAX_BODY_BYTES / 1024 / 1024} MB）`, 'invalid_request')); }
    if (body === null) return;
    let parsed;
    try { parsed = JSON.parse(body); body = null; }
    catch { return sendJson(res, 400, errorBody('Invalid JSON', 'invalid_request')); }
    const isObj = parsed && typeof parsed === 'object' && !Array.isArray(parsed);
    const { messages, model: requestModel, stream } = isObj ? parsed : {};
    if (!isObj || !Array.isArray(messages)) return sendJson(res, 400, errorBody('messages must be an array', 'invalid_request'));
    if (ticket.aborted) return;

    // Which model: the request's → config.defaultModel → the first one agy lists.
    modelId = (typeof requestModel === 'string' && requestModel.trim()) || cfg.defaultModel || '';
    let list = await listModels();
    if (!modelId) modelId = list[0]?.id || '';
    if (!modelId) return sendJson(res, 503, errorBody(`還拿不到 agy 的模型清單，沒辦法挑預設模型。${models.error || ''}`));
    if (list.length && !list.some(m => m.id === modelId)) {
      list = await listModels({ refresh: true });   // maybe the player signed in differently since
      if (list.length && !list.some(m => m.id === modelId)) {
        const msg = `模型「${modelId}」不在你 agy 帳號的清單裡（每個帳號、每種登入方式看到的模型不同）。現在能用的：${list.map(m => m.id).join('、')}。在酒館重新整理模型清單再選一次。`;
        return sendJson(res, 400, errorBody(msg, 'invalid_request'));
      }
    }
    if (ticket.aborted) return;

    // ── same question again while/after a disconnected reply finished → hand over the stored reply
    pruneResume();
    ticket.fp = resumeKey(modelId, messages);
    let resumed = null;
    if (current && current.orphaned && current.fp === ticket.fp) {
      console.log(`${TAG} 續盤：同一題，等斷線那則生完一起給`);
      resumed = await current.done;
      resumeStore.delete(ticket.fp);
    } else if (resumeStore.has(ticket.fp)) {
      resumed = resumeStore.get(ticket.fp); resumeStore.delete(ticket.fp);
    }
    if (resumed && resumed.ok && resumed.text) {
      const no = ++requestCount;
      console.log(`${TAG}[${no}] ← 續盤，直接給存好的 ${resumed.text.length} 字`);
      if (ticket.aborted || !alive()) return;
      return replyWhole(res, stream, completionId, modelId, resumed.text, resumed.usage);
    }

    // ── plan this turn
    const p = parseMessages(messages);
    const plan = planTurn(p, { stdinLimitBytes: cfg.stdinLimitBytes, framing: cfg.framing });
    const agentName = agentNameFor(plan.body);
    const agentFile = path.join(workspace, '.agents', 'agents', `${agentName}.md`);
    const logFile = path.join(logsDir, `${agentName}.log`);
    agentFiles.push(agentFile, logFile);
    fs.writeFileSync(agentFile, renderAgentFile(agentName, plan.body), 'utf8');
    if (ticket.aborted) return;   // SillyTavern left before agy started: nobody wants this one

    releaseCurrent('新請求進來');
    current = ticket;
    const no = ++requestCount;
    const shape = `msgs=${messages.length} agentFile=${plan.bytes.agentFile}B stdin=${plan.bytes.stdin}B${plan.movedToAgentFile ? ' (最新一則太長，已移進代理檔)' : ''}${p.imageCount ? ` 圖${p.imageCount}張未帶` : ''}`;
    console.log(`${TAG}[${no}] → ${modelId} ${shape} ${stream === false ? 'json' : 'stream'}`);

    let sentText = false;
    const isStream = stream !== false;
    if (isStream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`data: ${JSON.stringify(makeChunk(completionId, modelId, { role: 'assistant', content: '' }, null))}\n\n`);
    }
    const writeText = t => {
      if (!isStream || ticket.aborted || !alive()) return;
      sentText = true;
      res.write(`data: ${JSON.stringify(makeChunk(completionId, modelId, { content: t }, null))}\n\n`);
    };

    ticket.handle = runTurn({ cfg, workspace, agentName, model: modelId, stdinText: plan.stdinText, logFile, onText: writeText });
    const r = await ticket.handle.done;
    ticket.result = r;

    // ── bookkeeping
    if (cfg.cleanupConversations && r.conversationId) cleanupConversation(cfg, r.conversationId);
    const u = r.usage || {};
    const alarm = (r.unexpectedSteps.length || r.deniedActions) ? { unexpectedSteps: r.unexpectedSteps, deniedActions: r.deniedActions } : null;
    if (alarm) console.warn(`${TAG}[${no}] ⚠ agy 出現非對話步驟或被拒動作：${JSON.stringify(alarm).slice(0, 400)}`);
    console.log(`${TAG}[${no}] ← ${r.ok ? 'ok' : 'fail'}${ticket.aborted ? '(讓位)' : ticket.orphaned ? '(斷線後生完)' : ''} in=${u.input_tokens ?? 'n/a'} out=${u.output_tokens ?? 'n/a'} think=${u.thinking_tokens ?? 'n/a'} cacheR=${u.cache_read_tokens ?? 'n/a'} ttft=${r.ttftMs ?? 'n/a'}ms total=${r.ms}ms exit=${r.exitCode}`);
    if (!r.ok && !ticket.aborted) console.error(`${TAG}[${no}] error: ${String(r.error?.message || r.error).slice(0, 500)}`);
    lastTurn = { model: modelId, ok: r.ok, usage: r.usage, ttftMs: r.ttftMs, ms: r.ms, at: new Date().toISOString(), movedToAgentFile: plan.movedToAgentFile, ...(alarm ? { alarm } : {}) };
    appendUsageLog({ t: lastTurn.at, n: no, model: modelId, ok: r.ok, aborted: ticket.aborted, orphaned: ticket.orphaned, usage: r.usage, ttftMs: r.ttftMs, ms: r.ms, agentFileBytes: plan.bytes.agentFile, stdinBytes: plan.bytes.stdin, movedToAgentFile: plan.movedToAgentFile, msgs: messages.length, ...(alarm ? { alarm } : {}) });

    if (ticket.orphaned && !ticket.aborted && r.ok) {
      resumeStore.set(ticket.fp, { ok: true, text: r.text, usage: r.usage, at: Date.now() });
      console.log(`${TAG}[${no}] 斷線那則已存好 ${r.text.length} 字，等重新生成來拿`);
    }
    if (!alive()) return;
    if (ticket.aborted) {
      // Superseded by a newer request: close this one cleanly so the client is not left hanging.
      if (!isStream) return sendJson(res, 409, errorBody('這一則被新的請求取代了（重新生成或又送了一句）。', 'superseded'));
      res.write(`data: ${JSON.stringify(makeChunk(completionId, modelId, {}, 'length'))}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    const errText = r.ok ? null : humanError(r.error, { timedOut: r.timedOut, timeoutSec: cfg.printTimeoutSec });
    if (!isStream) {
      if (!r.ok) return sendJson(res, 502, errorBody(errText));
      return replyWhole(res, false, completionId, modelId, r.text, r.usage);
    }
    if (!r.ok) res.write(`data: ${JSON.stringify(makeChunk(completionId, modelId, { content: `${sentText ? '\n\n' : ''}[薄荷橋：${errText}]` }, null))}\n\n`);
    else if (!sentText) res.write(`data: ${JSON.stringify(makeChunk(completionId, modelId, { content: r.text }, null))}\n\n`);
    res.write(`data: ${JSON.stringify(makeChunk(completionId, modelId, {}, 'stop'))}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error(`${TAG} 拋錯：${String(err?.stack || err).slice(0, 600)}`);
    if (!res.headersSent) sendJson(res, 500, errorBody(humanError(err)));
    else if (alive()) {
      res.write(`data: ${JSON.stringify(makeChunk(completionId, modelId, { content: `\n\n[薄荷橋：${humanError(err)}]` }, null))}\n\n`);
      res.write('data: [DONE]\n\n'); res.end();
    }
  } finally {
    finished = true;
    if (res.headersSent && alive()) { try { res.end(); } catch { /* already closed */ } }   // never leave a stream open
    if (current === ticket) current = null;
    resolveDone(ticket.result);
    for (const f of agentFiles) removeQuietly(f);
  }
}

function replyWhole(res, stream, id, model, text, usage) {
  const u = usage || {};
  if (stream === false) {
    return sendJson(res, 200, {
      id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: u.input_tokens ?? 0, completion_tokens: u.output_tokens ?? 0, total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) },
    });
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(`data: ${JSON.stringify(makeChunk(id, model, { role: 'assistant', content: '' }, null))}\n\n`);
  res.write(`data: ${JSON.stringify(makeChunk(id, model, { content: text }, null))}\n\n`);
  res.write(`data: ${JSON.stringify(makeChunk(id, model, {}, 'stop'))}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

// ── status ────────────────────────────────────────────────────────────────
export function statusPayload() {
  const warnings = [];
  if (configFileError) warnings.push(configFileError);
  if (!agyInfo.version) warnings.push('找不到 agy 或讀不到版本——先照 README 裝好 Antigravity CLI。');
  else if (!agyInfo.versionTested) warnings.push(`agy ${agyInfo.version} 不在驗過的版本（${TESTED_AGY_VERSIONS.join('、')}）裡：大多照樣能用，有怪狀況請回報。`);
  if (models.error && !models.list.length) warnings.push(models.error);
  if (agyInfo.settings?.useG1Credits) warnings.push('agy 全域設定 useG1Credits 是開的：免費額度用完會自動扣付費 AI 點數（要關請自己改 agy 的 settings.json，橋不會動它）。');
  return {
    ok: true, plugin: PLUGIN_ID, version: readOwnVersion(),
    bridge: server ? { running: true, url: `http://${cfg.host}:${cfg.port}/v1`, busy: current !== null, requestCount, last: lastTurn } : { running: false },
    agy: { path: agyInfo.path, version: agyInfo.version, versionTested: agyInfo.versionTested, cloudProjectSignIn: agyInfo.settings?.cloudProjectSignIn ?? null },
    models: models.list.map(m => m.id),
    warnings,
  };
}

// ── HTTP server ───────────────────────────────────────────────────────────
function startServer() {
  return new Promise((resolve, reject) => {
    const s = http.createServer(async (req, res) => {
      req.on('error', () => {}); res.on('error', () => {});
      try {
        const url = new URL(req.url, 'http://localhost');
        const p = url.pathname.replace(/\/+$/, '') || '/';
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
        if (req.method === 'GET' && (p === '/' || p === '/health' || p === '/healthz')) {
          return sendJson(res, 200, { status: 'ok', busy: current !== null, requestCount, agyVersion: agyInfo.version });
        }
        if (!authorized(req)) return sendJson(res, 401, errorBody('API key 不對（config.json 的 apiKey）', 'invalid_request'));
        if (req.method === 'GET' && (p === '/v1/models' || p === '/models')) {
          const list = await listModels({ refresh: url.searchParams.get('refresh') === '1' });
          return sendJson(res, 200, { object: 'list', data: list.map(m => ({ id: m.id, object: 'model', created: 0, owned_by: 'antigravity', name: m.label })) });
        }
        if (req.method === 'GET' && p === '/status') return sendJson(res, 200, statusPayload());
        if (req.method === 'GET' && p === '/config') return sendJson(res, 200, publicConfig(cfg));
        if (req.method === 'POST' && p === '/config') {
          try { const raw = await readBody(req); if (raw) applyRuntimePatch(cfg, JSON.parse(raw)); } catch { /* keep current */ }
          return sendJson(res, 200, publicConfig(cfg));
        }
        if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/chat/completions')) return await handleChatCompletions(req, res);
        sendJson(res, 404, errorBody('Not found', 'not_found'));
      } catch {
        sendJson(res, 500, errorBody('Internal server error'));
      }
    });
    s.on('clientError', (_e, socket) => { if (socket.writable) socket.destroy(); });
    s.once('error', reject);
    s.listen(cfg.port, cfg.host, () => { console.log(`${TAG} 在 http://${cfg.host}:${cfg.port}/v1 待命`); resolve(s); });
  });
}

function prepareWorkspace() {
  const base = path.join(os.tmpdir(), `${PLUGIN_ID}-${cfg.port}`);
  const ws = path.join(base, 'ws');
  const agents = path.join(ws, '.agents', 'agents');
  removeQuietly(agents);                       // leftovers from a crash
  fs.mkdirSync(agents, { recursive: true });
  const logs = path.join(base, 'logs');
  removeQuietly(logs);
  fs.mkdirSync(logs, { recursive: true });
  return { ws, logs };
}

// ── SillyTavern plugin hooks ──────────────────────────────────────────────
export async function init(router) {
  ({ cfg, fileError: configFileError } = loadConfig(__dirname));
  if (configFileError) console.warn(`${TAG} ${configFileError}`);
  try { ({ ws: workspace, logs: logsDir } = prepareWorkspace()); }
  catch (err) { console.error(`${TAG} 建不了暫存工作夾：${err.message}`); }

  try { server = await startServer(); }
  catch (err) {
    console.error(err.code === 'EADDRINUSE' ? `${TAG} 埠 ${cfg.port} 被佔用了，橋沒啟動（改 config.json 的 port）。` : `${TAG} 橋啟動失敗：${err.message}`);
  }

  if (router) {
    router.get('/status', (_req, res) => res.json(statusPayload()));
    router.get('/config', (_req, res) => res.json(publicConfig(cfg)));
    router.post('/config', (req, res) => res.json(publicConfig(applyRuntimePatch(cfg, req.body))));
    router.get('/models', async (req, res) => res.json(await listModels({ refresh: req.query?.refresh === '1' })));
  }

  // Slow checks run in the background so SillyTavern's startup is not held up (agy models ≈ 8 s).
  agyInfo.path = resolveAgyPath(cfg);
  agyInfo.settings = readAgySettings(cfg);
  (async () => {
    agyInfo.version = await agyVersion(cfg);
    agyInfo.versionTested = agyInfo.version ? TESTED_AGY_VERSIONS.includes(agyInfo.version) : null;
    const list = await listModels({ refresh: true });
    console.log(`${TAG} agy ${agyInfo.version ?? '（找不到）'}｜模型 ${list.length} 個${list.length ? `：${list.map(m => m.id).join(', ')}` : ''}`);
    for (const w of statusPayload().warnings) console.warn(`${TAG} ⚠ ${w}`);
  })().catch(err => console.error(`${TAG} 啟動檢查失敗：${err.message}`));
}

export async function exit() {
  releaseCurrent('外掛關閉');
  if (server) { await new Promise(r => server.close(() => r())); server = null; }
  if (workspace) { removeQuietly(path.dirname(workspace)); workspace = null; }
}

// test hooks
export function _setConfig(patch) { cfg = { ...cfg, ...patch }; return cfg; }
export function _setWorkspace(ws, logs) { workspace = ws; logsDir = logs; fs.mkdirSync(path.join(ws, '.agents', 'agents'), { recursive: true }); fs.mkdirSync(logs, { recursive: true }); }
export function _setModels(list) { models.list = list; models.at = list.length ? Date.now() : 0; models.error = null; }
export function _state() { return { requestCount, busy: current !== null, lastTurn, resumeKeys: [...resumeStore.keys()] }; }
