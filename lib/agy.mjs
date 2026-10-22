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
const DONE_GRACE_MS = 10000;   // after the reply is complete, how long agy may take to exit before it is stopped (normally 0.2 s)
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

// A thinking block the model writes into its own reply (presets ask for it; SillyTavern's reasoning
// auto-parse moves it into the "thinking" box). agy's built-in thinking is never streamed at all —
// measured with agy 1.4.2 / argon-high: 862 thinking tokens, silent until the first visible word.
const THINK_BLOCK_RE = /<(think|thinking|reasoning)>[\s\S]*?(<\/\1>|$)/gi;

/** The reply without its thinking blocks: what max_tokens is about. An unclosed block counts as still thinking. */
export function withoutThinking(text) { return String(text || '').replace(THINK_BLOCK_RE, ''); }

const THINK_OPEN_RE = /<(think|thinking|reasoning)>/gi;
const THINK_TAGS = ['think', 'thinking', 'reasoning'].flatMap(n => [`<${n}>`, `</${n}>`]);
const mayBeTagStart = tail => { const s = tail.toLowerCase(); return THINK_TAGS.some(tag => s.length < tag.length && tag.startsWith(s)); };

/**
 * withoutThinking + tokenWeight while streaming, looking at each piece once (recounting the whole reply
 * on every piece grows with the square of its length). A tag cut between two pieces is held back.
 */
export function visibleCounter(thinkLimit = Infinity) {
  let carry = '', inThink = null, weight = 0, hasVisible = false, thinkWeight = 0, gaveUp = false;
  const visible = s => { if (s) { weight += tokenWeight(s); hasVisible ||= s.trim() !== ''; } };
  return {
    push(piece) {
      if (gaveUp) { visible(carry + piece); carry = ''; return; }
      let t = carry + piece; carry = '';
      const lt = t.lastIndexOf('<');
      if (lt >= 0 && mayBeTagStart(t.slice(lt))) { carry = t.slice(lt); t = t.slice(0, lt); }
      let i = 0;
      while (i < t.length) {
        if (inThink) {
          const close = new RegExp(`</${inThink}>`, 'gi'); close.lastIndex = i;
          const m = close.exec(t);
          // A thinking block that never closes (or closes with another name) would switch max_tokens off
          // for good: past thinkLimit, everything counts again.
          if (!m) {
            thinkWeight += tokenWeight(t.slice(i));
            if (thinkWeight > thinkLimit) { gaveUp = true; visible(t.slice(i) + carry); carry = ''; }
            break;
          }
          thinkWeight += tokenWeight(t.slice(i, m.index));
          i = m.index + m[0].length; inThink = null;
        } else {
          THINK_OPEN_RE.lastIndex = i;
          const m = THINK_OPEN_RE.exec(t);
          if (!m) { visible(t.slice(i)); break; }
          visible(t.slice(i, m.index));
          i = m.index + m[0].length; inThink = m[1].toLowerCase();
        }
      }
    },
    get weight() { return weight; },
    get hasVisible() { return hasVisible; },
  };
}

/**
 * Drops a thinking block at the very start of a stream (whitespace before it allowed); everything else
 * passes through. For the retry after a stall: the first try's thinking already went out, and SillyTavern
 * only lifts the thinking at the start of a message, so a second one would show up in the story.
 * Each piece is searched once (plus a tag's length of overlap), not the whole held text again.
 */
export function leadingThinkStripper() {
  let state = 'start', buf = '', close = null, scanned = 0;
  return {
    push(piece) {
      if (state === 'pass') return piece;
      buf += piece;
      if (state === 'start') {
        const s = buf.trimStart();
        const m = /^<(think|thinking|reasoning)>/i.exec(s);
        if (m) { state = 'in'; close = new RegExp(`</${m[1]}>`, 'gi'); scanned = buf.length - s.length + m[0].length; }
        else if (s === '' || mayBeTagStart(s)) return '';
        else { state = 'pass'; const out = buf; buf = ''; return out; }
      }
      close.lastIndex = Math.max(scanned, buf.length - piece.length - 12);
      const m = close.exec(buf);
      if (!m) return '';
      state = 'pass';
      const out = buf.slice(m.index + m[0].length).replace(/^\s+/, ''); buf = '';
      return out;
    },
    /** End of the stream: whatever is still held back (a block that never closed is shown, not hidden). */
    end() { const out = state === 'pass' ? '' : buf; buf = ''; state = 'pass'; return out; },
  };
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The home folder (it carries the Windows user name) as "~", however it is written: back or forward
 * slashes, doubled backslashes (JSON), any case.
 */
export function maskHome(text, home = os.homedir()) {
  let s = String(text);
  if (!home || home.length < 4) return s;
  const sep = String.raw`(?:\\\\|\\|/)+`;
  const parts = home.split(/[\\/]+/).filter(Boolean).map(escapeRe);
  // A POSIX home starts with the separator (/home/name): it belongs to the match, or "/~/x" would be left.
  // The folder name must end there: /home/name2 is someone else's, and "root" inside a word is not /root.
  const lead = /^[\\/]/.test(home) ? sep : '';
  return s.replace(new RegExp(`${lead}${parts.join(sep)}(?![\\w-])`, 'gi'), '~');
}

/**
 * Account details out of an agy log before the bridge keeps it: players paste these in public.
 * agy 1.4.3 logs the sign-in e-mail, the Google Cloud project id (also inside API URLs), full paths and the
 * player's own permission rules. Paths keep everything after the home folder: "~\…\x.db: database is
 * locked" is exactly what a report needs. `known` = values to mask wherever they appear (the project id
 * from agy's settings).
 */
export function redactAgyLog(text, { home = os.homedir(), known = [] } = {}) {
  let s = maskHome(text, home);
  for (const k of known) if (k && String(k).length >= 4) s = s.split(String(k)).join('<private>');
  return s
    .replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+/gi, '~')              // someone else's home folder
    .replace(/\/(?:home|Users)\/[^/\s"']+/g, '~')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\b(quotaProject|projectId|project_id|quota_project_id|project)(=|"?\s*:\s*")([A-Za-z0-9._-]{4,})/gi, '$1$2<project>')
    .replace(/\b(x-goog-user-project:\s*)\S+/gi, '$1<project>')
    .replace(/projects\/[A-Za-z0-9._-]+/g, 'projects/<project>')
    .replace(/(project ID\b[^:\n]*:\s*)[^\s,)]+/gi, '$1<project>')
    .replace(/\bya29\.[\w.-]+|\bBearer\s+[\w.~+/-]+=*|\bAIza[\w-]{20,}|\b1\/\/[\w-]{20,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<token>')
    .replace(/(permissions=&\{)[^\n]*/g, '$1<permission rules>}');
}

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

/**
 * The platform the lookup logic runs for. `cfg.platform` is not a config.json key (loadConfig drops
 * unknown keys): the test suite sets it to walk every platform's branch on one machine.
 */
export function platformOf(cfg) { return (cfg && cfg.platform) || process.platform; }

/** The bare command name: what is spawned when agy was found nowhere, so the OS searches PATH once more itself. */
export function agyCommandName(platform = process.platform) { return platform === 'win32' ? 'agy.exe' : 'agy'; }

/**
 * Where each platform's installer puts agy, tried in this order after PATH:
 *   Windows  %LOCALAPPDATA%\agy\bin\agy.exe (install.ps1)
 *   Linux    ~/.local/bin/agy (install.sh), /usr/local/bin/agy, ~/.antigravity/bin/agy
 *   macOS    ~/.local/bin/agy (install.sh), /opt/homebrew/bin/agy and /usr/local/bin/agy (Homebrew on
 *            Apple silicon / Intel), ~/.antigravity/bin/agy
 */
export function agyCandidates(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return [path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')];
  const local = path.join(home, '.local', 'bin', 'agy'), own = path.join(home, '.antigravity', 'bin', 'agy');
  if (platform === 'darwin') return [local, '/opt/homebrew/bin/agy', '/usr/local/bin/agy', own];
  return [local, '/usr/local/bin/agy', own];
}

const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/**
 * agy on PATH: the full path in the first PATH folder that has it (the status page then shows where),
 * or null. Windows looks for agy.exe; elsewhere for an executable file named agy. The PATH of `env` is
 * searched — SillyTavern's own, the one spawn would search too.
 */
export function findOnPath(platform = process.platform, env = process.env) {
  const win = platform === 'win32';
  const name = agyCommandName(platform);
  for (const dir of String(env.PATH ?? env.Path ?? '').split(win ? ';' : ':')) {
    if (!dir) continue;
    const p = path.join(win ? dir.replace(/^"(.*)"$/, '$1') : dir, name);
    if (!isFile(p)) continue;
    if (!win) { try { fs.accessSync(p, fs.constants.X_OK); } catch { continue; } }
    return p;
  }
  return null;
}

/** `%VAR%` (on every platform: the printed Windows advice uses it) and a leading `~` → the home folder. Unknown variables stay. */
export function expandPath(p, env = process.env, home = os.homedir()) {
  let s = String(p).replace(/%([A-Za-z_][\w()]*)%/g, (m, v) => env[v] ?? m);
  if (s === '~' || /^~[\\/]/.test(s)) s = home + s.slice(1);
  return s;
}

/**
 * Where is agy? config.agyPath → agy on PATH → the installer's default locations for this platform
 * (agyCandidates) → the bare command name. `%VAR%` and a leading `~` in agyPath are expanded: the
 * advice the bridge prints uses them, and players copy it as is.
 * Pass `misses` (an array) to learn why a default location was skipped: [{ path, code }] — PATH folders
 * are not listed, there are dozens. (26-10-20: a player's SillyTavern, started from Start.bat, could not
 * stat the default location at startup although the file was there a minute later; the code tells
 * ENOENT / EBUSY / EPERM apart.)
 * `opts` = { platform, env, home } for the test suite; normally this process's own.
 */
export function resolveAgyPath(cfg, misses, opts = {}) {
  const platform = opts.platform || platformOf(cfg), env = opts.env || process.env, home = opts.home || os.homedir();
  if (cfg.agyPath) return expandPath(cfg.agyPath, env, home);
  const onPath = findOnPath(platform, env);
  if (onPath) return onPath;
  for (const c of agyCandidates(platform, env, home)) {
    try { if (fs.statSync(c).isFile()) return c; misses?.push({ path: c, code: 'NOT_A_FILE' }); }
    catch (err) { misses?.push({ path: c, code: err.code || String(err.message || err) }); }
  }
  return agyCommandName(platform);
}

/**
 * An agy that an MSIX-packaged app (the Claude desktop app, say) installed into its own drawer:
 * %LOCALAPPDATA%\Packages\<app>\LocalCache\Local\agy\bin\agy.exe — Windows redirects that app's writes
 * under %LOCALAPPDATA% there, and only the app and its children see them at the normal path. The drawer
 * itself is an ordinary folder, so the bridge can look. Returns { package, path } or null. Only called
 * once agy is missing, so a few hundred stats are fine. Windows only: file-system virtualization is an
 * MSIX thing, so on macOS / Linux there is nothing to look for and the answer is null at once.
 */
export function findVirtualizedAgy(env = process.env, platform = process.platform) {
  if (platform !== 'win32' || !env.LOCALAPPDATA) return null;
  const packages = path.join(env.LOCALAPPDATA, 'Packages');
  let names;
  try { names = fs.readdirSync(packages); } catch { return null; }
  for (const name of names) {
    const candidate = path.join(packages, name, 'LocalCache', 'Local', 'agy', 'bin', 'agy.exe');
    try { if (fs.statSync(candidate).isFile()) return { package: name, path: candidate }; } catch { /* not this app */ }
  }
  return null;
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

/**
 * `agy --version` → "1.4.2" (or null; then `diag.error` says why, when a diag object is passed, and
 * `diag.code` / `diag.path` carry the error code and the file that was tried — the MSIX hint needs both).
 */
export function agyVersion(cfg, diag) {
  return new Promise(resolve => {
    const [cmd, args] = commandFor(resolveAgyPath(cfg), ['--version']);
    execFile(cmd, args, { timeout: 20000, env: agyEnv(cfg), windowsHide: true }, (err, stdout) => {
      const m = /\d+\.\d+\.\d+/.exec(String(stdout || ''));
      if (!m && diag) {
        diag.error = err ? [err.code, err.syscall, err.path && !String(err.syscall || '').includes(err.path) ? err.path : null].filter(Boolean).join(' ') || String(err.message || err) : `no version in output: ${String(stdout || '').trim().slice(0, 200)}`;
        diag.code = err?.code ?? null;
        diag.path = err?.path ?? cmd;
      }
      resolve(m ? m[0] : null);
    });
  });
}

/** One log line for "not on PATH, and the default location could not be read": every code, plus LOCALAPPDATA (Windows) or HOME, and cwd at that moment. */
export function agyMissLine(misses, env = process.env, cwd = process.cwd(), platform = process.platform) {
  const where = platform === 'win32' ? `LOCALAPPDATA=${env.LOCALAPPDATA ?? '（沒設）'}` : `HOME=${env.HOME ?? '（沒設）'}`;
  return `預設位置讀不到 agy（PATH 裡也沒有）：${misses.map(m => `${m.path}（${m.code}）`).join('、')}｜${where}｜cwd=${cwd}`;
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
      project: (s.gcp && s.gcp.project) || null,   // only for masking it in kept logs; never shown
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

/**
 * Kill agy and anything it started. child.kill() alone ends only agy itself: Windows uses taskkill /T;
 * elsewhere agy is started as the leader of its own process group (spawn detached) and the whole group
 * is signalled, so a helper it left behind cannot keep the turn's pipes open or run on after a stall.
 */
export function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, err => { if (err) { try { child.kill(); } catch {} } });
  } else {
    let signalled = false;
    if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); signalled = true; } catch { /* not a group leader, or already gone */ } }
    if (!signalled) { try { child.kill('SIGTERM'); } catch {} }
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
 * @param {number} [p.maxTokens]   stop once the reply is about this long (the request's max_tokens; thinking blocks not counted)
 * @param {(t:string)=>void} [p.onText]
 * @param {(r:Result)=>void} [p.onDone]   the reply is complete (agy may still be running): answer the client now
 * @returns {{ kill():void, done: Promise<Result> }}
 *
 * Result: { ok, text, usage, conversationId, exitCode, error, agyError, deniedActions, unexpectedSteps,
 *           ttftMs, ms, timedOut, killed, capped, contentBlocked, stalled, stalledBeforeText, completed,
 *           doneAtMs, lingered, tokPerSec, finishReason }
 *
 * Stall: before the first piece, cfg.stallFirstSec seconds of silence stops agy (the model may be thinking
 * silently, so this one is generous); once text has started, cfg.stallSec seconds without a new piece.
 * Either way stalled: true. After the reply is complete (DONE) there is no stall check.
 */
export function runTurn({ cfg, workspace, agentName, model, stdinText, logFile, maxTokens, onText, onDone }) {
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
    stalled: false, stalledBeforeText: false, stallSec: null, tokPerSec: null, completed: false, doneAtMs: null, sawDoneAtMs: null, sawResult: false, lingered: false,
  };
  const cap = Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : 0;
  let stallTimer = null, firstTextAt = null, lastTextAt = null;
  const counter = visibleCounter(cap ? Math.max(4000, cap * 3) : Infinity);

  const done = new Promise(resolve => {
    try {
      child = spawn(cmd, cmdArgs, { cwd: workspace, env: agyEnv(cfg), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });   // detached: its own process group, so killTree can end its helpers too (see killTree)
    } catch (err) {
      r.error = err; r.ms = Date.now() - t0; resolve(r); return;
    }
    let buf = '', stderr = '';
    let settled = false, graceTimer = null;
    const stopping = () => r.killed || r.capped || r.contentBlocked || r.timedOut || r.stalled;

    // Safety net: text started, then nothing for stallSec — the model side went quiet half-way.
    // Stop now instead of waiting for the overall timeout; the caller decides whether to send it again.
    const armStall = (sec, beforeText) => {
      clearTimeout(stallTimer);
      if (!(sec > 0) || r.sawDone) return;
      stallTimer = setTimeout(() => {
        if (stopping() || r.sawDone) return;
        r.stalled = true; r.stallSec = sec; r.stalledBeforeText = beforeText;
        killTree(child);
      }, sec * 1000);
    };

    // The reply is complete and good: tell the caller once, so it can answer the client without waiting for agy to exit.
    const markDone = () => {
      if (r.completed || stopping() || !r.text.trim() || !(r.sawDone || r.resultStatus === 'SUCCESS')) return;
      r.completed = true; r.doneAtMs = Date.now() - t0;
      onDone?.(r);
    };

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
            // More text after a DONE (a second reply step): not finished after all, start over.
            if (r.sawDone && !r.completed && su.text_delta.trim()) {
              r.textAfterDone = true; r.sawDone = false; r.sawDoneAtMs = null;
              clearTimeout(wrapTimer); wrapTimer = null;
            }
            if (r.ttftMs === null && su.text_delta.trim()) r.ttftMs = Date.now() - t0;
            lastTextAt = Date.now(); firstTextAt ??= lastTextAt;
            r.text += su.text_delta;
            onText?.(su.text_delta);
            if (su.state !== 'DONE' && r.text.trim()) armStall(cfg.stallSec, false);
            // max_tokens: agy cannot be told, so count and stop it ourselves. Thinking blocks written into
            // the reply don't count (a player's 2,000 cut the thinking off before the story began).
            // Not on the DONE piece (the reply is complete anyway), and not before any visible text.
            if (cap) {
              counter.push(su.text_delta);
              r.tokenWeight = counter.weight;
              if (su.state !== 'DONE' && r.tokenWeight >= cap && counter.hasVisible) { r.capped = true; r.finishReason = 'length'; killTree(child); }
            }
          }
          if (su.state === 'DONE') {
            r.sawDone = true; r.sawDoneAtMs ??= Date.now() - t0; clearTimeout(stallTimer); if (su.usage) r.usage = su.usage;
            armWrapUp();   // no early answer on DONE alone: a second reply step may follow; agy's result event ends the turn
          }
        }
        return;
      }
      if (ev.event === 'result' && ev.result) {
        const res = ev.result;
        r.resultStatus = res.status || null; r.sawResult = true;
        r.conversationId ||= res.conversation_id || null;
        if (res.usage && (!r.usage || !r.sawDone)) r.usage = res.usage;
        if (res.error) r.resultError = String(res.error);
        if (Array.isArray(res.denied_actions) && res.denied_actions.length) r.deniedActions = res.denied_actions;
        if (!r.text && typeof res.response === 'string') r.text = res.response;
        clearTimeout(stallTimer);
        armWrapUp(); markDone();
      }
    };

    // The reply is complete (DONE / result), but agy may not exit: 26-10-20 two finished replies (usage
    // 3,961 / 2,653 out) sat until the 930 s timeout. The client is answered already (onDone); agy gets a
    // few seconds to exit by itself, then is stopped. The turn finishes once it has really exited, so its
    // local files are no longer held open when the caller cleans them up.
    let wrapTimer = null;
    const armWrapUp = () => {
      if (wrapTimer) return;
      wrapTimer = setTimeout(() => {
        if (settled) return;
        r.lingered = true;
        killTree(child);
        setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(); }, CLOSE_GRACE_MS * 2);   // if the exit never comes
      }, cfg.doneGraceMs ?? DONE_GRACE_MS);
    };

    const finish = () => {
      if (settled) return; settled = true;
      clearTimeout(watchdog); clearTimeout(graceTimer);
      if (buf) { handleLine(buf); buf = ''; }   // a last line without a trailing newline
      clearTimeout(stallTimer); clearTimeout(wrapTimer);
      r.ms = Date.now() - t0;
      // Output speed while text was arriving (estimated tokens, thinking blocks included: it is the model's pace).
      if (lastTextAt - firstTextAt >= 1000) r.tokPerSec = Math.round(tokenWeight(r.text) / ((lastTextAt - firstTextAt) / 1000) * 10) / 10;
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
      // A reply already completed (and handed to the client) stays a success, even if agy had to be stopped after.
      r.ok = hasText && (r.capped || r.completed || (!r.killed && !r.timedOut && !r.stalled && !r.contentBlocked && (r.sawDone || r.resultStatus === 'SUCCESS')));
      if (!r.ok && !r.error) {
        let msg;
        if (r.contentBlocked) msg = r.blockedText || 'blocked by content safety filters';
        else if (r.stalled) msg = r.stalledBeforeText ? `bridge stopped agy: no text at all for ${r.stallSec} s` : `bridge stopped agy: no new text for ${r.stallSec} s after ${r.text.length} characters`;
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
    armStall(cfg.stallFirstSec, true);
  });

  return {
    kill() { r.killed = true; killTree(child); },
    done,
  };
}
