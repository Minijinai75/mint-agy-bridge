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
import { runTurn, fetchModels, agyVersion, readAgySettings, cleanupConversation, resolveAgyPath, agyMissLine, leadingThinkStripper, redactAgyLog, maskHome } from './lib/agy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ID = 'mint-agy-bridge';
const TAG = `[${PLUGIN_ID}]`;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MODELS_TTL_MS = 10 * 60 * 1000;
const MODELS_RETRY_MS = 60 * 1000;
const SMALL_MAX_TOKENS = 400;   // SillyTavern's default "max response length" is 300
// Between the stalled half and the retry's reply in a stream (same wording style as the Cursor bridge 0.2.1).
export const STALL_RETRY_NOTE = '\n\n〔前一發卡住，重來〕\n\n';
const AGY_INIT_RETRIES = 3, AGY_INIT_RETRY_MS = 5000, STATUS_RECHECK_MS = 5000, STATUS_WAIT_MS = 3000;
let warnedSmallMaxTokens = false;
export const TESTED_AGY_VERSIONS = ['1.4.2', '1.4.3'];

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
let agyInfo = { path: null, version: null, versionTested: null, settings: null, error: null, checkedAt: 0 };
const models = { list: [], at: 0, error: null, failAt: 0, inflight: null };
let agyCheckInflight = null;

/**
 * Look for agy again: path, version, settings, and (when agy answers) the model list.
 * Run at startup (with retries) and whenever /status is opened while something is missing, so a
 * one-off failure at SillyTavern's startup does not stick until the next restart.
 */
function checkAgy() {
  if (agyCheckInflight) return agyCheckInflight;
  agyCheckInflight = (async () => {
    const misses = [];
    agyInfo.path = resolveAgyPath(cfg, misses);
    const fellBack = !cfg.agyPath && misses.length && agyInfo.path === path.basename(agyInfo.path);
    if (fellBack) console.warn(`${TAG} ${agyMissLine(misses)}`);
    agyInfo.settings = readAgySettings(cfg);
    const diag = {};
    agyInfo.version = await agyVersion(cfg, diag);
    agyInfo.versionTested = agyInfo.version ? TESTED_AGY_VERSIONS.includes(agyInfo.version) : null;
    agyInfo.error = agyInfo.version ? null : `${diag.error || 'unknown'}${fellBack ? `｜${agyMissLine(misses)}` : ''}`;
    if (!agyInfo.version) console.warn(`${TAG} 叫不動 agy（${agyInfo.path}）：${agyInfo.error}`);
    else if (!models.list.length || models.error) await listModels({ refresh: true });
    agyInfo.checkedAt = Date.now();
  })().finally(() => { agyCheckInflight = null; });
  return agyCheckInflight;
}

/**
 * /status: when agy or the model list is missing, look again first (at most every few seconds), but wait
 * for it only briefly — `agy models` alone takes ~8 s and the player opened this page because something
 * is wrong. A slow check keeps running and the next refresh shows its result.
 */
export async function freshStatus() {
  const missing = !agyInfo.version || !models.list.length;
  const modelsBackingOff = agyInfo.version && models.failAt && Date.now() - models.failAt < MODELS_RETRY_MS;
  if (missing && !modelsBackingOff && (agyCheckInflight || Date.now() - agyInfo.checkedAt >= (cfg.statusRecheckMs ?? STATUS_RECHECK_MS))) {
    await Promise.race([checkAgy(), new Promise(r => setTimeout(r, cfg.statusWaitMs ?? STATUS_WAIT_MS))]);
  }
  return statusPayload();
}

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
  const ticket = { chatKey: null, aborted: false, orphaned: false, answered: false, handle: null, joined: null, fp: null, done: null, result: null };
  let resolveDone; ticket.done = new Promise(r => { resolveDone = r; });
  let finished = false;
  const completionId = `chatcmpl-${randomUUID().slice(0, 8)}`;
  let modelId = null;
  const alive = () => !res.writableEnded && !res.destroyed;

  // SillyTavern closed the connection (phone locked, timeout, Stop button — indistinguishable).
  // Before agy started: drop it. After: keep going and store the reply (keepOnDisconnect), or stop.
  res.on('close', () => {
    if (finished || ticket.answered || ticket.aborted || ticket.orphaned) return;   // answered: we closed it ourselves
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
    // Failures of a non-streaming request go out as HTTP 200 + {"error":…}: SillyTavern's backend passes
    // only the status text ("Bad Gateway") of a non-2xx non-streaming reply to the browser, so the
    // readable message would be lost. Streaming failures keep their real status (SillyTavern forwards the body).
    const fail = (code, message, type) => sendJson(res, isStream ? code : 200, errorBody(message, type));
    if (maxTokens && maxTokens <= SMALL_MAX_TOKENS && !warnedSmallMaxTokens) {
      warnedSmallMaxTokens = true;
      console.warn(`${TAG} 酒館送來的最大回覆長度是 ${maxTokens} token，回覆會在這附近被切掉（0.1.1 起照這個設定停）。嫌短就把酒館「最大回覆長度」調大，或在 config.json 設 honorMaxTokens: false。`);
    }
    if (ticket.aborted) return;

    // Which model: the request's → config.defaultModel → the first one agy lists.
    modelId = (typeof requestModel === 'string' && requestModel.trim()) || cfg.defaultModel || '';
    let list = await listModels();
    if (!modelId) modelId = list[0]?.id || '';
    if (!modelId) return fail(503, `還拿不到 agy 的模型清單，沒辦法挑預設模型。${models.error || ''}`);
    if (list.length && !list.some(m => m.id === modelId)) {
      list = await listModels({ refresh: true });   // maybe the player signed in differently since
      if (list.length && !list.some(m => m.id === modelId)) {
        const msg = `模型「${modelId}」不在你 agy 帳號的清單裡（每個帳號、每種登入方式看到的模型不同）。現在能用的：${list.map(m => m.id).join('、')}。在酒館重新整理模型清單再選一次。`;
        return fail(400, msg, 'invalid_request');
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
      return fail(429, `同時在生的已經有 ${others} 則（上限 maxConcurrent=${cfg.maxConcurrent}），等前面的生完再送。`, 'rate_limit');
    }
    running.set(ticket.chatKey, ticket);

    const agentName = agentNameFor(plan.body);
    const agentFile = path.join(workspace, '.agents', 'agents', `${agentName}.md`);
    const logFileFor = attempt => path.join(logsDir, `${agentName}-${attempt}.log`);   // one per run: a retry must not overwrite the stalled run's log
    agentFiles.push(agentFile, logFileFor(1), logFileFor(2));
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

    // The reply is complete: answer SillyTavern now, without waiting for agy to exit (it may not —
    // 26-10-20 two finished replies sat until the timeout). agy gets a few seconds more, then is stopped.
    let flush = null;
    const flushHeld = () => { if (flush) { const t = flush(); flush = null; if (t) writeText(t); } };
    const onDone = d => {
      if (ticket.answered || ticket.aborted || !alive()) return;
      ticket.answered = true;
      flushHeld();
      if (isStream && sentText) {
        res.write(`data: ${JSON.stringify(makeChunk(completionId, modelId, {}, d.finishReason))}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } else replyWhole(res, isStream, completionId, modelId, d.text, d.usage, d.finishReason);
    };
    const runOnce = (attempt, onText = writeText) => {
      ticket.handle = runTurn({ cfg, workspace, agentName, model: modelId, stdinText: plan.stdinText, logFile: logFileFor(attempt), maxTokens, onText, onDone });
      return ticket.handle.done;
    };
    const canRetry = r1 => r1.stalled && cfg.stallRetry && !ticket.aborted && (alive() || ticket.orphaned);
    let r = await runOnce(1);
    bookkeep(r, { no, modelId, maxTokens, plan, msgs: messages.length, ticket, logFile: logFileFor(1), willRetry: canRetry(r) });

    // ── stalled → send the same request once more. The half that already went out cannot be taken back
    // (a stream only appends), so a marked line separates it from the new reply. If that half already
    // held a finished thinking block, the retry's own thinking block is left out of the stream.
    let retried = false;
    if (canRetry(r)) {
      retried = true;
      console.warn(`${TAG}[${no}] 模型那頭 ${r.stallSec} 秒沒出字（已出 ${r.text.length} 字），自動重送一次（會再算一發額度）`);
      let onText = writeText;
      if (sentText) {
        writeText(STALL_RETRY_NOTE);
        if (/<\/(think|thinking|reasoning)>/i.test(r.text)) {
          const strip = leadingThinkStripper();
          onText = t => { const o = strip.push(t); if (o) writeText(o); };
          flush = () => strip.end();
        }
      }
      r = await runOnce(2, onText);
      r.retriedAfterStall = true;
      bookkeep(r, { no, modelId, maxTokens, plan, msgs: messages.length, ticket, logFile: logFileFor(2) });
    }
    flushHeld();
    ticket.result = r;

    if (ticket.orphaned && !ticket.aborted && r.ok) {
      resumeStore.set(ticket.fp, { ok: true, text: r.text, usage: r.usage, finishReason: r.finishReason, at: Date.now() });
      console.log(`${TAG}[${no}] 斷線那則已存好 ${r.text.length} 字，等重新生成來拿`);
    }
    if (!alive()) return;
    if (ticket.aborted) return replySuperseded(res, isStream, completionId, modelId);

    const errText = r.ok ? null : humanError(r.error, { timedOut: r.timedOut, contentBlocked: r.contentBlocked, stalled: r.stalled, stallSec: r.stallSec, stalledBeforeText: r.stalledBeforeText, retried, timeoutSec: cfg.printTimeoutSec, elapsedSec: Math.round(r.ms / 1000) });
    if (!r.ok && !sentText) return fail(502, `薄荷橋：${errText}`);
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

// ── agy's own log of a run that went wrong, kept so the next report can show what agy was waiting for ──
const KEEP_AGY_LOGS = 5;

/** Copy (redacted) into <plugin>/logs/, keep the newest few. Returns the kept name, or null. */
function keepAgyLog(logFile, no, why) {
  try {
    if (!logFile || !fs.existsSync(logFile)) return null;
    const dir = cfg.keptLogsDir || path.join(__dirname, 'logs');   // keptLogsDir: tests only
    fs.mkdirSync(dir, { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}_${no}_${why}.log`;
    fs.writeFileSync(path.join(dir, name), redactAgyLog(fs.readFileSync(logFile, 'utf8'), { known: [agyInfo.settings?.project] }), 'utf8');
    const kept = fs.readdirSync(dir).filter(f => f.endsWith('.log')).sort();
    for (const f of kept.slice(0, Math.max(0, kept.length - KEEP_AGY_LOGS))) fs.rmSync(path.join(dir, f), { force: true });
    return `logs/${name}`;
  } catch { return null; }
}

/** After each agy run: keep agy's log if it went wrong, clean agy's local copy, log one line, update /status and the usage log. */
function bookkeep(r, { no, modelId, maxTokens, plan, msgs, ticket, logFile, willRetry = false }) {
  // agy's log first (the temp copy is deleted when the request ends), then agy's local conversation files.
  const why = r.lingered ? 'lingered' : r.stalled ? 'stalled' : r.timedOut ? 'timeout' : (!r.ok && !ticket.aborted && !r.contentBlocked) ? 'failed' : null;
  const agyLog = why ? keepAgyLog(logFile, no, why) : null;
  if (cfg.cleanupConversations) {
    if (!r.conversationId) { if (!r.killed) console.warn(`${TAG}[${no}] 沒拿到 agy 對話編號，這一則的本機紀錄沒清到`); }
    else {
      const c = cleanupConversation(cfg, r.conversationId);
      // A just-stopped agy (Windows) may still hold its files for a moment: try once more a little later.
      if (c.failed) setTimeout(() => {
        const c2 = cleanupConversation(cfg, r.conversationId);
        if (c2.failed) console.warn(`${TAG}[${no}] 清 agy 本機紀錄：還有 ${c2.failed} 個刪不掉（對話 ${r.conversationId}）`);
      }, cfg.cleanupRetryMs ?? 5000).unref?.();
      else if (!c.removed) console.warn(`${TAG}[${no}] 清 agy 本機紀錄：一個都沒找到（對話 ${r.conversationId}）`);
    }
  }
  const u = r.usage || {};
  const alarm = (r.unexpectedSteps.length || r.deniedActions) ? { unexpectedSteps: r.unexpectedSteps, deniedActions: r.deniedActions } : null;
  if (alarm) console.warn(`${TAG}[${no}] ⚠ agy 出現非對話步驟或被拒動作：${JSON.stringify(alarm).slice(0, 400)}`);
  const stopNote = r.capped ? `(到 max_tokens=${maxTokens} 收尾)` : r.contentBlocked ? '(內容過濾擋下，已停)' : r.stalled ? `(${r.stallSec} 秒沒出字，橋停掉)` : r.lingered ? "(回覆已完成、agy 沒自己退出，橋收掉)" : r.timedOut ? '(逾時，橋停掉)' : '';
  console.log(`${TAG}[${no}] ← ${r.ok ? 'ok' : 'fail'}${stopNote}${r.retriedAfterStall ? '(重送那發)' : ''}${ticket.aborted ? '(讓位／停止)' : ticket.orphaned ? '(斷線後生完)' : ''} in=${u.input_tokens ?? 'n/a'} out=${u.output_tokens ?? 'n/a'} think=${u.thinking_tokens ?? 'n/a'} cacheR=${u.cache_read_tokens ?? 'n/a'} ttft=${r.ttftMs ?? 'n/a'}ms total=${r.ms}ms ${r.tokPerSec ?? 'n/a'}tok/s exit=${r.exitCode}`);
  if (!r.ok && !ticket.aborted) (willRetry ? console.warn : console.error)(`${TAG}[${no}] ${willRetry ? '（這發會重送）' : 'error: '}${String(r.error?.message || r.error).slice(0, 500)}`);
  const stop = {
    maxTokens: maxTokens || null, capped: r.capped, contentBlocked: r.contentBlocked, timedOut: r.timedOut,
    stalled: r.stalled, ...(r.stalledBeforeText ? { stalledBeforeText: true } : {}), tokPerSec: r.tokPerSec, doneAtMs: r.doneAtMs, ...(r.textAfterDone ? { textAfterDone: true } : {}),
    ...(r.lingered ? { lingered: true, sawResult: r.sawResult, postDoneHangSec: Math.round((r.ms - (r.sawDoneAtMs ?? r.doneAtMs ?? r.ms)) / 100) / 10 } : {}), ...(r.retriedAfterStall ? { retriedAfterStall: true } : {}),
    exitCode: r.exitCode, ...(agyLog ? { agyLog } : {}), ...(r.ok ? {} : { error: String(r.error?.message || r.error || '').slice(0, 300) }),
  };
  lastTurn = { model: modelId, ok: r.ok, usage: r.usage, ttftMs: r.ttftMs, ms: r.ms, at: new Date().toISOString(), movedToAgentFile: plan.movedToAgentFile, ...stop, ...(alarm ? { alarm } : {}) };
  const { error: _e, exitCode: _x, ...logStop } = stop;
  appendUsageLog({ t: lastTurn.at, n: no, model: modelId, ok: r.ok, aborted: ticket.aborted, orphaned: ticket.orphaned, ...logStop, usage: r.usage, ttftMs: r.ttftMs, ms: r.ms, agentFileBytes: plan.bytes.agentFile, stdinBytes: plan.bytes.stdin, movedToAgentFile: plan.movedToAgentFile, continuation: plan.continuation, msgs, ...(alarm ? { alarm } : {}) });
}

/** Superseded by a newer request in the same chat: close this one cleanly so the client is not left hanging. */
function replySuperseded(res, isStream, id, model) {
  if (!res.headersSent || !isStream) return sendJson(res, isStream ? 409 : 200, errorBody('這一則被同一段對話的新請求取代了（重新生成或又送了一句）。', 'superseded'));
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
  if (!agyInfo.version) warnings.push('找不到 agy 或讀不到版本：把 agy.exe 的完整路徑填進 config.json 的 agyPath（通常是 %LOCALAPPDATA%\\agy\\bin\\agy.exe），再重啟酒館；真的還沒裝才照 README 第 1 步裝。');
  else if (!agyInfo.versionTested) warnings.push(`agy ${agyInfo.version} 不在驗過的版本（${TESTED_AGY_VERSIONS.join('、')}）裡：大多照樣能用，有怪狀況請回報。`);
  if (configFileError) warnings.push(configFileError);
  if (models.error && !models.list.length) warnings.push(models.error);
  if (agyInfo.settings?.useG1Credits) warnings.push('agy 全域設定 useG1Credits 是開的：免費額度用完會自動扣付費 AI 點數（要關請自己改 agy 的 settings.json，橋不會動它）。');
  // Players paste this page in public: the home folder (it carries the Windows user name) becomes "~".
  return JSON.parse(maskHome(JSON.stringify({
    ok: true, plugin: PLUGIN_ID, version: readOwnVersion(),
    bridge: server ? { running: true, url: `http://${cfg.host}:${cfg.port}/v1`, busy: running.size, requestCount, last: lastTurn } : { running: false },
    agy: { path: agyInfo.path, version: agyInfo.version, versionTested: agyInfo.versionTested, ...(agyInfo.error ? { error: agyInfo.error } : {}), cloudProjectSignIn: agyInfo.settings?.cloudProjectSignIn ?? null, allowNonWorkspaceAccess: agyInfo.settings?.allowNonWorkspaceAccess ?? null },
    models: models.list.map(m => m.id),
    warnings,
  })));
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
      if (req.method === 'GET' && (p === '/status' || p === '/')) return sendJson(res, 200, await freshStatus());
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
    router.get('/status', async (_req, res) => res.json(await freshStatus()));
    router.get('/config', (_req, res) => res.json(publicConfig(cfg)));
    router.post('/config', (req, res) => res.json(publicConfig(applyRuntimePatch(cfg, req.body))));
    router.get('/models', async (req, res) => res.json(await listModels({ refresh: req.query?.refresh === '1' })));
  }

  // Slow checks run in the background so SillyTavern's startup is not held up (agy models ≈ 8 s).
  agyInfo.path = resolveAgyPath(cfg);
  agyInfo.settings = readAgySettings(cfg);
  if (server) {
    (async () => {
      // Not found at startup → try again a few times: twice a player's agy could not be read right as
      // SillyTavern started, and could a minute later.
      const tries = cfg.agyInitRetries ?? AGY_INIT_RETRIES, waitMs = cfg.agyInitRetryMs ?? AGY_INIT_RETRY_MS;
      for (let i = 0; ; i++) {
        await checkAgy();
        if (agyInfo.version || i >= tries) break;
        console.warn(`${TAG} 第 ${i + 1} 次叫不動 agy，${waitMs / 1000} 秒後再試（最多再試 ${tries} 次）`);
        await new Promise(r => setTimeout(r, waitMs));
      }
      const list = models.list;
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
