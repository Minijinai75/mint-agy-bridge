// Everything that touches the agy CLI: finding it, listing models, running one turn, cleaning up.
//
// One process per request (measured: ~5.5 s to first token for a short chat). A long-lived process
// is faster (~2 s) but can only append — SillyTavern's swipe / edit needs to rewind, so v1 is
// stateless. Tools are off at three levels: the agent file (`tools: []`, no default components),
// `--sandbox`, and headless mode auto-denying anything that asks for permission.

import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseAgyError } from './errors.mjs';
import { stdinLine } from './agent-file.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const KNOWN_STEP_TYPES = new Set(['user_input', 'system_message', 'agent_response', 'error_message']);
const CLOSE_GRACE_MS = 2000;   // after the process exits, how long to wait for its pipes to close
// Google's output filter, as agy 1.4.2 prints it on stderr: "Your previous response was blocked by
// content safety filters: … Generative AI Prohibited Use policy … Retries remaining: 3". agy then
// re-asks the model up to 3 more times; each try is blocked again, so the turn only ends at the timeout.
export const CONTENT_FILTER_RE = /blocked by content safety filters|Generative AI Prohibited Use policy/i;
const WATCHDOG_EXTRA_SEC = 30;   // our own kill comes this long after agy's --print-timeout

// Characters counted as "wide" (about one token each): CJK, kana, hangul, full-width forms, and the
// general punctuation block (curly quotes, ellipsis and dashes are common in Chinese roleplay).
const WIDE_RE = /[\u2010-\u205F\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/g;
const ASTRAL_RE = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;   // emoji and rare CJK: two code units, one token or more

/**
 * Rough token weight of model output (a fraction), for honouring max_tokens: agy has no output-limit
 * option. Measured with agy 1.4.2 / gemini-3.8-flash: 1.18 CJK characters per token, 4.56 Latin
 * characters per token; the formula uses 1.15 / 4.4 so it stops a little early rather than late.
 * Fractions are kept so it can be summed piece by piece while streaming.
 */
export function tokenWeight(text) {
  const s = String(text || '');
  const wide = (s.match(WIDE_RE) || []).length;
  const astral = (s.match(ASTRAL_RE) || []).length;
  return wide / 1.15 + astral + (s.length - wide - 2 * astral) / 4.4;
}
export function estimateTokens(text) { return Math.ceil(tokenWeight(text)); }

/** The filter message out of agy's stderr: from "Your previous response" up to "Retries remaining". */
function filterExcerpt(text) {
  const s = String(text || '');
  const i = s.search(/Your previous response|blocked by content safety filters/i);
  const from = i >= 0 ? s.slice(i) : s;
  const j = from.search(/Retries remaining:?\s*\d+/i);
  return (j >= 0 ? from.slice(0, j + from.slice(j).match(/Retries remaining:?\s*\d+/i)[0].length) : from).trim().slice(0, 1200);
}

/** agy's data folder (conversations, brain, settings.json). */
export function agyDataDir(cfg) {
  return cfg.agyDataDir || path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

/** Where is agy? config.agyPath → the installer's default location → `agy` on PATH. */
export function resolveAgyPath(cfg) {
  if (cfg.agyPath) return cfg.agyPath;
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')]
    : [path.join(os.homedir(), '.local', 'bin', 'agy'), '/usr/local/bin/agy', '/opt/homebrew/bin/agy'];
  for (const c of candidates) { try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ } }
  return process.platform === 'win32' ? 'agy.exe' : 'agy';
}

/** A .mjs/.js agyPath runs under node (used by the test suite's fake agy). */
function commandFor(agyPath, args) {
  return /\.(mjs|cjs|js)$/i.test(agyPath) ? [process.execPath, [agyPath, ...args]] : [agyPath, args];
}

/**
 * Environment for agy. AGY_ADC_AUTH you set yourself is passed through untouched;
 * adcAuth:true only adds it for setups (scheduled tasks, shortcuts) that start SillyTavern without it.
 */
export function agyEnv(cfg) {
  return {
    ...process.env,
    AGY_CLI_DISABLE_AUTO_UPDATE: '1',
    // agy retries 429s by itself for ~140 s by default; 0 makes it fail in seconds so the player
    // gets a readable error instead of a frozen chat. Raise it in config.json if you prefer waiting.
    AGY_CLI_MODEL_API_MAX_RETRIES: String(cfg.maxRetries),
    ...(cfg.adcAuth ? { AGY_ADC_AUTH: 'true' } : {}),
  };
}

/** `agy --version` → "1.4.2" (or null). */
export function agyVersion(cfg) {
  return new Promise(resolve => {
    const [cmd, args] = commandFor(resolveAgyPath(cfg), ['--version']);
    execFile(cmd, args, { timeout: 20000, env: agyEnv(cfg), windowsHide: true }, (err, stdout) => {
      const m = /\d+\.\d+\.\d+/.exec(String(stdout || ''));
      resolve(m ? m[0] : null);
    });
  });
}

/** Parse `agy models` output: lines of "<id>\t<label>". */
export function parseModelList(stdout) {
  const out = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = /^([A-Za-z0-9][\w.\-]*)\t+(.+)$/.exec(line.trim());
    if (m) out.push({ id: m[1], label: m[2].trim() });
  }
  return out;
}

/** Run `agy models`. Resolves { models, error }. */
export function fetchModels(cfg) {
  return new Promise(resolve => {
    const [cmd, args] = commandFor(resolveAgyPath(cfg), ['models']);
    execFile(cmd, args, { timeout: 60000, env: agyEnv(cfg), windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const models = parseModelList(stdout);
      if (models.length) return resolve({ models, error: null });
      resolve({ models: [], error: err || new Error(String(stderr || stdout || 'agy models returned nothing').trim()) });
    });
  });
}

/** Read the few global agy settings worth showing. Never writes. */
export function readAgySettings(cfg) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(agyDataDir(cfg), 'settings.json'), 'utf8'));
    return {
      useG1Credits: s.useG1Credits === true,
      allowNonWorkspaceAccess: s.allowNonWorkspaceAccess === true,
      cloudProjectSignIn: Boolean(s.gcp && s.gcp.project),
    };
  } catch {
    return null;
  }
}

/**
 * Delete what agy stored for one conversation. Only exact, UUID-shaped ids are touched.
 * Returns { removed, failed }. agy's shared summary files (conversation_summaries.db,
 * jetbox_summaries_proto.pb) also mention each conversation; they are shared with your other agy
 * use, so the bridge leaves them alone.
 */
export function cleanupConversation(cfg, conversationId) {
  const res = { removed: 0, failed: 0 };
  if (!UUID_RE.test(String(conversationId || ''))) return res;
  const root = agyDataDir(cfg);
  const targets = [
    path.join(root, 'conversations', `${conversationId}.db`),
    path.join(root, 'conversations', `${conversationId}.db-wal`),
    path.join(root, 'conversations', `${conversationId}.db-shm`),
    path.join(root, 'brain', conversationId),
    path.join(root, 'annotations', `${conversationId}.pbtxt`),
    path.join(root, 'presence', `${conversationId}.lock`),
  ];
  for (const t of targets) {
    try { if (fs.existsSync(t)) { fs.rmSync(t, { recursive: true, force: true }); res.removed++; } } catch { res.failed++; }
  }
  return res;
}

/** Kill agy and anything it started. On Windows child.kill() only ends agy.exe itself. */
export function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, err => { if (err) { try { child.kill(); } catch {} } });
  } else {
    try { child.kill('SIGTERM'); } catch {}
  }
}

/**
 * Run one turn.
 * @param {object} p
 * @param {object} p.cfg
 * @param {string} p.workspace   folder that contains .agents/agents/<agentName>.md
 * @param {string} p.agentName
 * @param {string} p.model
 * @param {string} p.stdinText
 * @param {string} [p.logFile]
 * @param {number} [p.maxTokens]   stop once the reply is about this long (the request's max_tokens)
 * @param {(t:string)=>void} [p.onText]
 * @returns {{ kill():void, done: Promise<Result> }}
 *
 * Result: { ok, text, usage, conversationId, exitCode, error, agyError, deniedActions, unexpectedSteps,
 *           ttftMs, ms, timedOut, killed, capped, contentBlocked, finishReason }
 */
export function runTurn({ cfg, workspace, agentName, model, stdinText, logFile, maxTokens, onText }) {
  const args = [
    '--print=', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--agent', agentName, '--sandbox', '--disable-slash-commands',
    '--print-timeout', `${cfg.printTimeoutSec}s`,
  ];
  if (model) args.push('--model', model);
  if (logFile) args.push('--log-file', logFile);

  const t0 = Date.now();
  const [cmd, cmdArgs] = commandFor(resolveAgyPath(cfg), args);
  let child = null;
  const r = {
    ok: false, text: '', usage: null, conversationId: null, exitCode: null, error: null, agyError: null,
    deniedActions: null, unexpectedSteps: [], ttftMs: null, ms: 0, timedOut: false, killed: false,
    sawDone: false, resultStatus: null,
    capped: false, contentBlocked: false, blockedText: null, finishReason: 'stop', tokenWeight: 0,
  };
  const cap = Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : 0;

  const done = new Promise(resolve => {
    try {
      child = spawn(cmd, cmdArgs, { cwd: workspace, env: agyEnv(cfg), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      r.error = err; r.ms = Date.now() - t0; resolve(r); return;
    }
    let buf = '', stderr = '';
    let settled = false, graceTimer = null;
    const stopping = () => r.killed || r.capped || r.contentBlocked || r.timedOut;

    // Google's filter said no: agy would retry until the timeout, so stop it now.
    const onFiltered = text => {
      if (r.contentBlocked || r.capped) return;
      r.contentBlocked = true;
      r.blockedText = filterExcerpt(text);
      killTree(child);
    };

    const handleLine = (raw) => {
      const line = raw.trim();
      if (!line) return;
      let ev; try { ev = JSON.parse(line); } catch { if (CONTENT_FILTER_RE.test(line)) onFiltered(line); return; }   // not JSON: agy talking
      if (ev.event === 'init') { r.conversationId = ev.conversation_id || r.conversationId; r.initModel = ev.init?.model; return; }
      const su = ev.step_update;
      // Only agy's own messages are checked for the filter, never the model's words: those are in
      // agent_response steps and again in result.response, and a story may quote anything.
      const agyText = su ? (su.step_type === 'agent_response' ? '' : [su.text, su.text_delta, su.error].filter(Boolean).join('\n')) : String(ev.result?.error || '');
      if (CONTENT_FILTER_RE.test(agyText)) onFiltered(agyText);
      if (su) {
        if (su.conversation_id) r.conversationId ??= su.conversation_id;
        if (su.step_type && !KNOWN_STEP_TYPES.has(su.step_type) && !r.unexpectedSteps.includes(su.step_type)) r.unexpectedSteps.push(su.step_type);
        if (su.step_type === 'agent_response') {
          if (typeof su.text_delta === 'string' && su.text_delta && !stopping()) {
            if (r.ttftMs === null && su.text_delta.trim()) r.ttftMs = Date.now() - t0;
            r.text += su.text_delta;
            r.tokenWeight += tokenWeight(su.text_delta);
            onText?.(su.text_delta);
            // max_tokens: agy cannot be told, so count and stop it ourselves. Not on the DONE piece
            // (the reply is complete anyway), and not before any visible text.
            if (cap && su.state !== 'DONE' && r.tokenWeight >= cap && r.text.trim()) { r.capped = true; r.finishReason = 'length'; killTree(child); }
          }
          if (su.state === 'DONE') { r.sawDone = true; if (su.usage) r.usage = su.usage; }
        }
        return;
      }
      if (ev.event === 'result' && ev.result) {
        const res = ev.result;
        r.resultStatus = res.status || null;
        r.conversationId ||= res.conversation_id || null;
        if (res.usage && (!r.usage || !r.sawDone)) r.usage = res.usage;
        if (res.error) r.resultError = String(res.error);
        if (Array.isArray(res.denied_actions) && res.denied_actions.length) r.deniedActions = res.denied_actions;
        if (!r.text && typeof res.response === 'string') r.text = res.response;
      }
    };

    const finish = () => {
      if (settled) return; settled = true;
      clearTimeout(watchdog); clearTimeout(graceTimer);
      if (buf) { handleLine(buf); buf = ''; }   // a last line without a trailing newline
      r.ms = Date.now() - t0;
      r.agyError = parseAgyError(stderr);
      r.stderrTail = stderr.trim().split('\n').slice(-4).join('\n').slice(-1200);
      // Re-read the filter message from the whole stderr: the chunk that tripped it may have been cut short.
      if (!r.capped && CONTENT_FILTER_RE.test(`${r.resultError || ''}\n${stderr}`)) {
        r.contentBlocked = true; r.blockedText = filterExcerpt(CONTENT_FILTER_RE.test(stderr) ? stderr : r.resultError);
      }
      // Success = the model actually answered. agy's overall status can stick to ERROR on resumed
      // conversations even when the reply is fine, so it is not trusted on its own.
      // A reply stopped at max_tokens is a normal, complete answer (finish_reason "length").
      const hasText = r.text.trim() !== '';
      r.ok = hasText && (r.capped || (!r.killed && !r.timedOut && !r.contentBlocked && (r.sawDone || r.resultStatus === 'SUCCESS')));
      if (!r.ok && !r.error) {
        let msg;
        if (r.contentBlocked) msg = r.blockedText || 'blocked by content safety filters';
        // The exit code after our own kill is taskkill's (1 on Windows), not agy's: don't report it.
        else if (r.timedOut) msg = `bridge stopped agy after ${Math.round(r.ms / 1000)} s without a finished reply${r.stderrTail ? ` | agy stderr: ${r.stderrTail}` : ''}`;
        else msg = r.resultError || r.agyError?.short_error || r.stderrTail || (r.exitCode != null ? `agy exited with code ${r.exitCode}` : 'agy produced no reply');
        r.error = new Error(msg);
      }
      resolve(r);
    };
    // Our own watchdog on top of --print-timeout, in case agy itself hangs.
    // (watchdogExtraSec is not a config.json key; the test suite sets it to keep timeout tests short.)
    // It fires even after an earlier stop (max_tokens, filter, superseded): if that kill did not take,
    // this one kills again, and the turn is finished regardless so the chat's slot is never held forever.
    const watchdog = setTimeout(() => {
      if (!stopping()) r.timedOut = true;
      killTree(child);
      setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(); }, CLOSE_GRACE_MS * 2);
    }, (cfg.printTimeoutSec + (cfg.watchdogExtraSec ?? WATCHDOG_EXTRA_SEC)) * 1000);

    child.on('error', err => { r.error = err; finish(); });
    // 'close' waits for the pipes; a leftover grandchild holding them would keep it from ever firing.
    child.on('exit', code => {
      r.exitCode = code;
      graceTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(); }, CLOSE_GRACE_MS);
    });
    child.on('close', code => { if (r.exitCode === null) r.exitCode = code; finish(); });
    child.stdout.setEncoding('utf8');   // keep multi-byte characters intact across chunks
    child.stderr.setEncoding('utf8');
    let stderrCarry = '';   // the end of the previous chunk, so a phrase split across two chunks still matches
    child.stderr.on('data', d => {
      stderr += d; if (stderr.length > 200000) stderr = stderr.slice(-100000);
      const scan = stderrCarry + d;
      stderrCarry = scan.slice(-300);
      if (!r.contentBlocked && CONTENT_FILTER_RE.test(scan)) onFiltered(scan);
    });
    child.stdout.on('data', d => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); handleLine(line); }
    });

    child.stdin.on('error', () => {});
    child.stdin.end(stdinLine(stdinText), 'utf8');
  });

  return {
    kill() { r.killed = true; killTree(child); },
    done,
  };
}
