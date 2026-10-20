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

import { loadConfig, applyRuntimePatch, publicConfig, isLoopback } from './lib/config.mjs';
import { parseMessages, textOf } from './lib/parse.mjs';
import { planTurn, agentNameFor, renderAgentFile } from './lib/agent-file.mjs';
import { humanError } from './lib/errors.mjs';
import { runTurn, fetchModels, agyVersion, readAgySettings, cleanupConversation, resolveAgyPath } from './lib/agy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ID = 'mint-agy-bridge';
const TAG = `[${PLUGIN_ID}]`;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MODELS_TTL_MS = 10 * 60 * 1000;
const MODELS_RETRY_MS = 60 * 1000;
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
let baseDir = null;             // this process's own temp folder (mkdtemp), removed on exit
let workspace = null;           // <baseDir>/ws  (contains .agents/agents/)
let logsDir = null;
const running = new Map();      // chatKey → ticket being generated (or waiting for one) in that chat
let requestCount = 0;
let lastTurn = null;            // token counts and timing of the last reply (no content)
let agyInfo = { path: null, version: null, versionTested: null, settings: null };
const models = { list: [], at: 0, error: null, failAt: 0, inflight: null };

// ── models: stale-while-revalidate, with a back-off after failures ─────────
function refreshModels() {
  if (models.inflight) return models.inflight;
  models.inflight = (async () => {
    const { models: list, error } = await fetchModels(cfg);
    if (list.length) { models.list = list; models.at = Date.now(); models.error = null; models.failAt = 0; }
    else { models.error = humanError(error); models.failAt = Date.now(); console.error(`${TAG} 模型清單拿不到：${models.error}`); }
    return models.list;   // keep the old list when a refresh fails
  })().finally(() => { models.inflight = null; });
  return models.inflight;
}

export async function listModels({ refresh = false } = {}) {
  if (refresh) return refreshModels();
  if (models.list.length) {
    if (Date.now() - models.at >= MODELS_TTL_MS && !(models.failAt && Date.now() - models.failAt < MODELS_RETRY_MS)) refreshModels().catch(() => {});
    return models.list;
  }
  if (models.failAt && Date.now() - models.failAt < MODELS_RETRY_MS) return models.list;
  return refreshModels();
}

// ── resume: SillyTavern disconnected mid-reply → finish anyway, hand it over on regenerate ─
const resumeStore = new Map();   // key → { ok, text, usage, at }
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

/** Which chat a request belongs to: the card/preset header plus the chat's first turn. Swipes share it. */
function chatKeyOf(parsed) {
  const first = parsed.history[0]?.content ?? parsed.current?.content ?? '';
  return createHash('sha256').update(`${parsed.systemPrompt.slice(0, 20000)}\u0000${String(first).slice(0, 4000)}`).digest('hex').slice(0, 16);
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
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
const errorBody = (message, type = 'server_error') => ({ error: { message, type } });

/**
 * An error after the stream has started. Sent as its own `{"error":…}` event, never as reply text:
 * SillyTavern shows it as a red notice and keeps it out of the message (text appended to the reply
 * could land in the "thinking" box through reasoning auto-parse, or be saved as part of the story).
 */
function writeStreamError(res, message) {
  res.write(`data: ${JSON.stringify(errorBody(message))}\n\n`);
}

/** max_tokens / max_completion_tokens from the request, when the bridge should honour it. */
function requestMaxTokens(body) {
  if (!cfg.honorMaxTokens) return 0;
  for (const k of ['max_completion_tokens', 'max_tokens']) {
    const v = body[k];
    if (Number.isInteger(v) && v > 0) return v;
  }
  return 0;
}

function makeChunk(id, model, delta, finishReason) {
  return { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

/** Stop whatever is running in this chat (a swipe or a new message replaces it). */
function releaseChat(chatKey, reason) {
  const t = running.get(chatKey);
  if (!t) return;
  running.delete(chatKey);
  t.aborted = true;
  console.log(`${TAG} 同一段對話的前一則讓位（${reason}）`);
  t.handle?.kill();
  if (t.joined) { t.joined.aborted = true; t.joined.handle?.kill(); }   // a waiter: stop the reply it was waiting for too
}

function removeQuietly(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }

// ── /v1/chat/completions ──────────────────────────────────────────────────
export async function handleChatCompletions(req, res) {
  const ticket = { chatKey: null, aborted: false, orphaned: false, handle: null, joined: null, fp: null, done: null, result: null };
  let resolveDone; ticket.done = new Promise(r => { resolveDone = r; });
  let finished = false;
  const completionId = `chatcmpl-${randomUUID().slice(0, 8)}`;
  let modelId = null;
  const alive = () => !res.writableEnded && !res.destroyed;

  // SillyTavern closed the connection (phone locked, timeout, Stop button — indistinguishable).
  // Before agy started: drop it. After: keep going and store the reply (keepOnDisconnect), or stop.
  res.on('close', () => {
    if (finished || ticket.aborted || ticket.orphaned) return;
    if (!ticket.handle) { ticket.aborted = true; return; }
    if (cfg.keepOnDisconnect) {
      ticket.orphaned = true;
      console.log(`${TAG} 酒館端斷線，這一則照樣生完先存著；按重新生成就拿整段。`);
    } else {
      ticket.aborted = true;
      ticket.handle.kill();
      console.log(`${TAG} 酒館端斷線，這一則停掉（keepOnDisconnect 關著）。`);
    }
  });

  const agentFiles = [];
  try {
    if (!workspace) return sendJson(res, 503, errorBody('薄荷橋還沒初始化完成（看酒館主控台的錯誤）。'));
    let body;
    try { body = await readBody(req); }
    catch { return sendJson(res, 413, errorBody(`請求太大（上限 ${MAX_BODY_BYTES / 1024 / 1024} MB）`, 'invalid_request')); }
    if (body === null) return;
    let parsed;
    try { parsed = JSON.parse(body); body = null; }
    catch { return sendJson(res, 400, errorBody('Invalid JSON', 'invalid_request')); }
    const isObj = parsed && typeof parsed === 'object' && !Array.isArray(parsed);
    const { messages, model: requestModel } = isObj ? parsed : {};
    const isStream = isObj && parsed.stream === true;   // OpenAI default is non-streaming
    if (!isObj || !Array.isArray(messages)) return sendJson(res, 400, errorBody('messages must be an array', 'invalid_request'));
    const maxTokens = requestMaxTokens(parsed);
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

    const p = parseMessages(messages);
    const plan = planTurn(p, { stdinLimitBytes: cfg.stdinLimitBytes, framing: cfg.framing });
    ticket.chatKey = chatKeyOf(p);
    ticket.fp = resumeKey(modelId, messages);
    pruneResume();

    // ── same request again while/after a disconnected reply → hand over that reply
    let resumed = null;
    const inChat = running.get(ticket.chatKey);
    if (inChat && inChat.orphaned && !inChat.aborted && inChat.fp === ticket.fp) {
      console.log(`${TAG} 續盤：同一題，等斷線那則生完一起給`);
      ticket.joined = inChat;
      running.set(ticket.chatKey, ticket);          // register as the chat's current request: a newer one can cancel us
      resumed = await inChat.done;
      ticket.joined = null;
      resumeStore.delete(ticket.fp);
      if (ticket.aborted) return replySuperseded(res, false, completionId, modelId);
    } else if (resumeStore.has(ticket.fp)) {
      resumed = resumeStore.get(ticket.fp); resumeStore.delete(ticket.fp);
    }
    if (resumed && resumed.ok && resumed.text) {
      const no = ++requestCount;
      console.log(`${TAG}[${no}] ← 續盤，直接給存好的 ${resumed.text.length} 字`);
      if (running.get(ticket.chatKey) === ticket) running.delete(ticket.chatKey);
      if (!alive()) return;
      return replyWhole(res, isStream, completionId, modelId, resumed.text, resumed.usage, resumed.finishReason);
    }

    // ── take this chat's slot; other chats may run in parallel up to maxConcurrent
    if (running.get(ticket.chatKey) !== ticket) releaseChat(ticket.chatKey, '新請求進來');
    const others = [...running.keys()].filter(k => k !== ticket.chatKey).length;
    if (others >= cfg.maxConcurrent) {
      return sendJson(res, 429, errorBody(`同時在生的已經有 ${others} 則（上限 maxConcurrent=${cfg.maxConcurrent}），等前面的生完再送。`, 'rate_limit'));
    }
    running.set(ticket.chatKey, ticket);

    const agentName = agentNameFor(plan.body);
    const agentFile = path.join(workspace, '.agents', 'agents', `${agentName}.md`);
    const logFile = path.join(logsDir, `${agentName}.log`);
    agentFiles.push(agentFile, logFile);
    fs.mkdirSync(path.dirname(agentFile), { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(agentFile, renderAgentFile(agentName, plan.body), 'utf8');
    if (ticket.aborted) return;   // SillyTavern left before agy started: nobody wants this one

    const no = ++requestCount;
    const shape = `msgs=${messages.length} agentFile=${plan.bytes.agentFile}B stdin=${plan.bytes.stdin}B${maxTokens ? ` max_tokens=${maxTokens}` : ''}${plan.movedToAgentFile ? ' (最新一則太長，已移進代理檔)' : ''}${plan.continuation ? ' (接續寫)' : ''}${p.imageCount ? ` 圖${p.imageCount}張未帶` : ''}`;
    console.log(`${TAG}[${no}] → ${modelId} ${shape} ${isStream ? 'stream' : 'json'}`);

    // Streaming headers go out with the first piece of text, so an error before that can still be a
    // proper HTTP error (SillyTavern shows it as a notice instead of saving it as the character's reply).
    let sentText = false;
    const writeText = t => {
      if (!isStream || ticket.aborted || !alive()) return;
      if (!res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`data: ${JSON.stringify(makeChunk(completionId, modelId, { role: 'assistant', content: '' }, null))}\n\n`);
      }
      sentText = true;
      res.write(`data: ${JSON.stringify(makeChunk(completionId, modelId, { content: t }, null))}\n\n`);
    };

    ticket.handle = runTurn({ cfg, workspace, agentName, model: modelId, stdinText: plan.stdinText, logFile, maxTokens, onText: writeText });
    const r = await ticket.handle.done;
    ticket.result = r;

    // ── bookkeeping
    if (cfg.cleanupConversations) {
      if (!r.conversationId) { if (!r.killed) console.warn(`${TAG}[${no}] 沒拿到 agy 對話編號，這一則的本機紀錄沒清到`); }
      else {
        const c = cleanupConversation(cfg, r.conversationId);
        if (c.failed || !c.removed) console.warn(`${TAG}[${no}] 清 agy 本機紀錄：刪 ${c.removed} 個、失敗 ${c.failed} 個（對話 ${r.conversationId}）`);
      }
    }
    const u = r.usage || {};
    const alarm = (r.unexpectedSteps.length || r.deniedActions) ? { unexpectedSteps: r.unexpectedSteps, deniedActions: r.deniedActions } : null;
    if (alarm) console.warn(`${TAG}[${no}] ⚠ agy 出現非對話步驟或被拒動作：${JSON.stringify(alarm).slice(0, 400)}`);
    const stopNote = r.capped ? `(到 max_tokens=${maxTokens} 收尾)` : r.contentBlocked ? '(內容過濾擋下，已停)' : r.timedOut ? '(逾時，橋停掉)' : '';
    console.log(`${TAG}[${no}] ← ${r.ok ? 'ok' : 'fail'}${stopNote}${ticket.aborted ? '(讓位／停止)' : ticket.orphaned ? '(斷線後生完)' : ''} in=${u.input_tokens ?? 'n/a'} out=${u.output_tokens ?? 'n/a'} think=${u.thinking_tokens ?? 'n/a'} cacheR=${u.cache_read_tokens ?? 'n/a'} ttft=${r.ttftMs ?? 'n/a'}ms total=${r.ms}ms exit=${r.exitCode}`);
    if (!r.ok && !ticket.aborted) console.error(`${TAG}[${no}] error: ${String(r.error?.message || r.error).slice(0, 500)}`);
    const stop = { maxTokens: maxTokens || null, capped: r.capped, contentBlocked: r.contentBlocked, timedOut: r.timedOut, exitCode: r.exitCode, ...(r.ok ? {} : { error: String(r.error?.message || r.error || '').slice(0, 300) }) };
    lastTurn = { model: modelId, ok: r.ok, usage: r.usage, ttftMs: r.ttftMs, ms: r.ms, at: new Date().toISOString(), movedToAgentFile: plan.movedToAgentFile, ...stop, ...(alarm ? { alarm } : {}) };
    appendUsageLog({ t: lastTurn.at, n: no, model: modelId, ok: r.ok, aborted: ticket.aborted, orphaned: ticket.orphaned, maxTokens: maxTokens || null, capped: r.capped, contentBlocked: r.contentBlocked, timedOut: r.timedOut, usage: r.usage, ttftMs: r.ttftMs, ms: r.ms, agentFileBytes: plan.bytes.agentFile, stdinBytes: plan.bytes.stdin, movedToAgentFile: plan.movedToAgentFile, continuation: plan.continuation, msgs: messages.length, ...(alarm ? { alarm } : {}) });

    if (ticket.orphaned && !ticket.aborted && r.ok) {
      resumeStore.set(ticket.fp, { ok: true, text: r.text, usage: r.usage, finishReason: r.finishReason, at: Date.now() });
      console.log(`${TAG}[${no}] 斷線那則已存好 ${r.text.length} 字，等重新生成來拿`);
    }
    if (!alive()) return;
    if (ticket.aborted) return replySuperseded(res, isStream, completionId, modelId);

    const errText = r.ok ? null : humanError(r.error, { timedOut: r.timedOut, contentBlocked: r.contentBlocked, timeoutSec: cfg.printTimeoutSec, elapsedSec: Math.round(r.ms / 1000) });
    if (!r.ok && !sentText) return sendJson(res, 502, errorBody(`薄荷橋：${errText}`));
    if (!isStream) return replyWhole(res, false, completionId, modelId, r.text, r.usage, r.finishReason);
    // Part of the reply already went out: keep it, and send the error as an error event (red notice).
    if (!r.ok) writeStreamError(res, `薄荷橋：${errText}`);
    else if (!sentText) return replyWhole(res, true, completionId, modelId, r.text, r.usage, r.finishReason);
    res.write(`data: ${JSON.stringify(makeChunk(completionId, modelId, {}, r.ok ? r.finishReason : 'stop'))}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error(`${TAG} 拋錯：${String(err?.stack || err).slice(0, 600)}`);
    if (!res.headersSent) sendJson(res, 500, errorBody(`薄荷橋：${humanError(err)}`));
    else if (alive()) {
      writeStreamError(res, `薄荷橋：${humanError(err)}`);
      res.write('data: [DONE]\n\n'); res.end();
    }
  } finally {
    finished = true;
    if (res.headersSent && alive()) { try { res.end(); } catch { /* already closed */ } }   // never leave a stream open
    if (ticket.chatKey && running.get(ticket.chatKey) === ticket) running.delete(ticket.chatKey);
    resolveDone(ticket.result);
    for (const f of agentFiles) removeQuietly(f);
  }
}

/** Superseded by a newer request in the same chat: close this one cleanly so the client is not left hanging. */
function replySuperseded(res, isStream, id, model) {
  if (!res.headersSent || !isStream) return sendJson(res, 409, errorBody('這一則被同一段對話的新請求取代了（重新生成或又送了一句）。', 'superseded'));
  res.write(`data: ${JSON.stringify(makeChunk(id, model, {}, 'length'))}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function replyWhole(res, isStream, id, model, text, usage, finishReason = 'stop') {
  const u = usage || {};
  if (!isStream) {
    return sendJson(res, 200, {
      id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finishReason }],
      usage: { prompt_tokens: u.input_tokens ?? 0, completion_tokens: u.output_tokens ?? 0, total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) },
    });
  }
  if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(`data: ${JSON.stringify(makeChunk(id, model, { role: 'assistant', content: '' }, null))}\n\n`);
  res.write(`data: ${JSON.stringify(makeChunk(id, model, { content: text }, null))}\n\n`);
  res.write(`data: ${JSON.stringify(makeChunk(id, model, {}, finishReason))}\n\n`);
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
    bridge: server ? { running: true, url: `http://${cfg.host}:${cfg.port}/v1`, busy: running.size, requestCount, last: lastTurn } : { running: false },
    agy: { path: agyInfo.path, version: agyInfo.version, versionTested: agyInfo.versionTested, cloudProjectSignIn: agyInfo.settings?.cloudProjectSignIn ?? null, allowNonWorkspaceAccess: agyInfo.settings?.allowNonWorkspaceAccess ?? null },
    models: models.list.map(m => m.id),
    warnings,
  };
}

// ── HTTP server ───────────────────────────────────────────────────────────
/**
 * Checks every request must pass. Against web pages in your browser poking the local port:
 * POST must be application/json (forces a CORS preflight, which this server never approves), and
 * on loopback the Host header must be a loopback name (defeats DNS rebinding).
 */
function guard(req) {
  if (isLoopback(cfg.host)) {
    const host = String(req.headers.host || '').toLowerCase();
    const port = req.socket.localPort;
    if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) return [403, 'Host 不是本機位址，拒絕（防網頁偷連）。'];
  }
  if (req.method === 'POST' && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return [415, 'POST 只收 Content-Type: application/json。'];
  if (cfg.apiKey && (req.headers.authorization || '') !== `Bearer ${cfg.apiKey}`) return [401, 'API key 不對（config.json 的 apiKey）。'];
  return null;
}

export function createServer() {
  const s = http.createServer(async (req, res) => {
    req.on('error', () => {}); res.on('error', () => {});
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname.replace(/\/+$/, '') || '/';
      if (req.method === 'GET' && (p === '/health' || p === '/healthz')) {
        return sendJson(res, 200, { status: 'ok', busy: running.size, requestCount, agyVersion: agyInfo.version });
      }
      const denied = guard(req);
      if (denied) return sendJson(res, denied[0], errorBody(denied[1], 'invalid_request'));
      if (req.method === 'GET' && (p === '/v1/models' || p === '/models')) {
        const list = await listModels({ refresh: url.searchParams.get('refresh') === '1' });
        return sendJson(res, 200, { object: 'list', data: list.map(m => ({ id: m.id, object: 'model', created: 0, owned_by: 'antigravity', name: m.label })) });
      }
      if (req.method === 'GET' && (p === '/status' || p === '/')) return sendJson(res, 200, statusPayload());
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
  return s;
}

function listen(s) {
  return new Promise((resolve, reject) => {
    s.once('error', reject);
    s.listen(cfg.port, cfg.host, () => { s.off('error', reject); resolve(s); });
  });
}

/** This process's own temp folder: two bridges never share or delete each other's files. */
function prepareWorkspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `${PLUGIN_ID}-`));
  const ws = path.join(base, 'ws');
  fs.mkdirSync(path.join(ws, '.agents', 'agents'), { recursive: true });
  const logs = path.join(base, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  return { base, ws, logs };
}

// ── SillyTavern plugin hooks ──────────────────────────────────────────────
export async function init(router) {
  ({ cfg, fileError: configFileError } = loadConfig(__dirname));
  if (configFileError) console.warn(`${TAG} ${configFileError}`);

  if (!isLoopback(cfg.host) && !cfg.apiKey) {
    console.error(`${TAG} host 設成 ${cfg.host}（不只本機）卻沒設 apiKey：任何連得到這台電腦的人都能用你的額度。橋沒啟動——先在 config.json 設 apiKey。`);
  } else {
    try {
      server = await listen(createServer());
      console.log(`${TAG} 在 http://${cfg.host}:${cfg.port}/v1 待命`);
    } catch (err) {
      server = null;
      console.error(err.code === 'EADDRINUSE' ? `${TAG} 埠 ${cfg.port} 被佔用了，橋沒啟動（可能已經有一座在跑；要再開一座就改 config.json 的 port）。` : `${TAG} 橋啟動失敗：${err.message}`);
    }
  }
  if (server) {
    try { ({ base: baseDir, ws: workspace, logs: logsDir } = prepareWorkspace()); }
    catch (err) { console.error(`${TAG} 建不了暫存工作夾：${err.message}`); }
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
  if (server) {
    (async () => {
      agyInfo.version = await agyVersion(cfg);
      agyInfo.versionTested = agyInfo.version ? TESTED_AGY_VERSIONS.includes(agyInfo.version) : null;
      const list = await listModels({ refresh: true });
      console.log(`${TAG} agy ${agyInfo.version ?? '（找不到）'}｜模型 ${list.length} 個${list.length ? `：${list.map(m => m.id).join(', ')}` : ''}`);
      for (const w of statusPayload().warnings) console.warn(`${TAG} ⚠ ${w}`);
    })().catch(err => console.error(`${TAG} 啟動檢查失敗：${err.message}`));
  }
  console.log(`${TAG} Plugin initialized.`);
}

export async function exit() {
  for (const k of [...running.keys()]) releaseChat(k, '外掛關閉');
  if (server) { await new Promise(r => server.close(() => r())); server = null; }
  if (baseDir) { removeQuietly(baseDir); baseDir = null; workspace = null; logsDir = null; }
}

// test hooks
export function _setConfig(patch) { cfg = { ...cfg, ...patch }; return cfg; }
export function _setWorkspace(ws, logs) { workspace = ws; logsDir = logs; fs.mkdirSync(path.join(ws, '.agents', 'agents'), { recursive: true }); fs.mkdirSync(logs, { recursive: true }); }
export function _setModels(list) { models.list = list; models.at = list.length ? Date.now() : 0; models.error = null; models.failAt = 0; }
export function _state() { return { requestCount, busy: running.size, lastTurn, resumeKeys: [...resumeStore.keys()] }; }
