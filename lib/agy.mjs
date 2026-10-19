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

export function agyEnv(cfg) {
  return {
    ...process.env,
    AGY_CLI_DISABLE_AUTO_UPDATE: '1',
    // agy retries 429s by itself for ~140 s by default; 0 makes it fail in seconds so the player
    // gets a readable error instead of a frozen chat. Raise it in config.json if you prefer waiting.
    AGY_CLI_MODEL_API_MAX_RETRIES: String(cfg.maxRetries),
  };
}

/** `agy --version` → "1.4.2" (or null). */
export function agyVersion(cfg) {
  return new Promise(resolve => {
    const [cmd, args] = commandFor(resolveAgyPath(cfg), ['--version']);
    execFile(cmd, args, { timeout: 20000, env: agyEnv(cfg), windowsHide: true }, (err, stdout) => {
      const m = /\d+\.\d+\.\d+/.exec(String(stdout || ''));
      resolve(err && !m ? null : (m ? m[0] : null));
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

/** Read the few global agy settings worth warning about. Never writes. */
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

/** Delete what agy stored for one conversation. Only exact, UUID-shaped ids are touched. */
export function cleanupConversation(cfg, conversationId) {
  if (!UUID_RE.test(String(conversationId || ''))) return 0;
  const root = agyDataDir(cfg);
  const targets = [
    path.join(root, 'conversations', `${conversationId}.db`),
    path.join(root, 'conversations', `${conversationId}.db-wal`),
    path.join(root, 'conversations', `${conversationId}.db-shm`),
    path.join(root, 'brain', conversationId),
    path.join(root, 'annotations', `${conversationId}.pbtxt`),
    path.join(root, 'presence', `${conversationId}.lock`),
  ];
  let removed = 0;
  for (const t of targets) {
    try { if (fs.existsSync(t)) { fs.rmSync(t, { recursive: true, force: true }); removed++; } } catch { /* locked: leave it */ }
  }
  return removed;
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
 * @param {(t:string)=>void} [p.onText]
 * @returns {{ child, done: Promise<Result> }}
 *
 * Result: { ok, text, usage, conversationId, exitCode, error, agyError, deniedActions, unexpectedSteps,
 *           ttftMs, ms, timedOut, killed }
 */
export function runTurn({ cfg, workspace, agentName, model, stdinText, logFile, onText }) {
  const args = [
    '--print=', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--agent', agentName, '--sandbox', '--disable-slash-commands',
    '--print-timeout', `${cfg.printTimeoutSec}s`,
  ];
  if (model) args.push('--model', model);
  if (logFile) args.push('--log-file', logFile);

  const t0 = Date.now();
  const [cmd, cmdArgs] = commandFor(resolveAgyPath(cfg), args);
  let child;
  const r = {
    ok: false, text: '', usage: null, conversationId: null, exitCode: null, error: null, agyError: null,
    deniedActions: null, unexpectedSteps: [], ttftMs: null, ms: 0, timedOut: false, killed: false,
    sawDone: false, resultStatus: null,
  };

  const done = new Promise(resolve => {
    try {
      child = spawn(cmd, cmdArgs, { cwd: workspace, env: agyEnv(cfg), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      r.error = err; r.ms = Date.now() - t0; resolve(r); return;
    }
    let buf = '', stderr = '';
    let settled = false;
    const finish = () => {
      if (settled) return; settled = true;
      clearTimeout(watchdog);
      r.ms = Date.now() - t0;
      r.agyError = parseAgyError(stderr);
      r.stderrTail = stderr.trim().split('\n').slice(-4).join('\n').slice(-1200);
      // Success = the model actually answered. agy's overall status can stick to ERROR on resumed
      // conversations even when the reply is fine, so it is not trusted on its own.
      r.ok = !r.killed && !r.timedOut && r.text.trim() !== '' && (r.sawDone || r.resultStatus === 'SUCCESS');
      if (!r.ok && !r.error) {
        const msg = r.resultError || r.agyError?.short_error || r.stderrTail || (r.exitCode != null ? `agy exited with code ${r.exitCode}` : 'agy produced no reply');
        r.error = new Error(msg);
      }
      resolve(r);
    };
    // Our own watchdog on top of --print-timeout, in case agy itself hangs.
    const watchdog = setTimeout(() => { r.timedOut = true; try { child.kill(); } catch {} }, (cfg.printTimeoutSec + 30) * 1000);

    child.on('error', err => { r.error = err; finish(); });
    child.stdout.setEncoding('utf8');   // keep multi-byte characters intact across chunks
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => { stderr += d; if (stderr.length > 200000) stderr = stderr.slice(-100000); });
    child.stdout.on('data', d => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.event === 'init') { r.conversationId = ev.conversation_id || r.conversationId; r.initModel = ev.init?.model; continue; }
        const su = ev.step_update;
        if (su) {
          if (su.conversation_id) r.conversationId ??= su.conversation_id;
          if (su.step_type && !KNOWN_STEP_TYPES.has(su.step_type) && !r.unexpectedSteps.includes(su.step_type)) r.unexpectedSteps.push(su.step_type);
          if (su.step_type === 'agent_response') {
            if (typeof su.text_delta === 'string' && su.text_delta) {
              if (r.ttftMs === null && su.text_delta.trim()) r.ttftMs = Date.now() - t0;
              r.text += su.text_delta;
              onText?.(su.text_delta);
            }
            if (su.state === 'DONE') { r.sawDone = true; if (su.usage) r.usage = su.usage; }
          }
          continue;
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
      }
    });
    child.on('close', code => { r.exitCode = code; finish(); });

    child.stdin.on('error', () => {});
    child.stdin.end(stdinLine(stdinText), 'utf8');
  });

  return {
    get child() { return child; },
    kill() { r.killed = true; try { child?.kill(); } catch {} },
    done,
  };
}
