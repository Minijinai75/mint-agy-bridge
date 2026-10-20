// Settings: built-in defaults ← config.json next to index.mjs ← environment (MINT_PORT, for testing).
// POST /config can change the "runtime" keys in memory; restart returns to config.json.

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_FRAMING } from './agent-file.mjs';

export const DEFAULTS = Object.freeze({
  port: 5499,
  host: '127.0.0.1',
  apiKey: '',                    // set it to require "Authorization: Bearer <apiKey>" (required when host is not loopback)
  agyPath: '',                   // '' = auto-detect
  agyDataDir: '',                // '' = ~/.gemini/antigravity-cli
  adcAuth: false,                // true = run agy with AGY_ADC_AUTH=true (Application Default Credentials sign-in)
  defaultModel: '',              // used when the request names no model; '' = first model agy lists
  printTimeoutSec: 900,          // slow models (argon-high) with a long chat need minutes; raise it further for those
  stallSec: 120,                 // a safety net: text started, then this long without a new word → stop and send it again once; 0 = off
  stallFirstSec: 180,            // the same before the first word (the model may think silently first: argon-high 20-32 s, a slow evening 140 s); 0 = off
  stallRetry: true,              // ...the "send it again once" part
  honorMaxTokens: true,          // stop the reply at the request's max_tokens (estimated: agy itself has no output limit; thinking blocks not counted)
  maxRetries: 0,                 // agy's own retries on API errors (default agy behaviour waits ~140 s on a 429)
  stdinLimitBytes: 180000,       // agy cuts user messages at ~192,000 bytes; anything larger goes to the agent file
  cleanupConversations: true,    // delete agy's local copy of each conversation after the reply
  keepOnDisconnect: true,        // SillyTavern disconnected (phone locked, or Stop): finish anyway and keep the reply
  resumeMinutes: 15,             // ...for this long, handed over when the same request comes again
  maxConcurrent: 2,              // replies generated at the same time across different chats
  usageLog: true,                // write token counts (no content) to usage/YYYY-MM.jsonl
  framing: DEFAULT_FRAMING,      // one paragraph put before the character card; '' to disable
});

// [min, max] for numeric keys; integers only where marked.
const RANGES = {
  port: [1, 65535, true],
  printTimeoutSec: [10, 86400, true],
  stallSec: [0, 3600, true],
  stallFirstSec: [0, 3600, true],
  maxRetries: [0, 20, true],
  stdinLimitBytes: [1000, 185000, true],   // above ~192,000 agy truncates silently
  resumeMinutes: [0, 1440, false],
  maxConcurrent: [1, 8, true],
};

const RUNTIME_KEYS = ['defaultModel', 'printTimeoutSec', 'stallSec', 'stallFirstSec', 'stallRetry', 'honorMaxTokens', 'maxRetries', 'cleanupConversations', 'keepOnDisconnect', 'resumeMinutes', 'maxConcurrent', 'usageLog', 'framing'];

function clean(raw, keys) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of keys) {
    if (!(k in raw)) continue;
    const v = raw[k], d = DEFAULTS[k];
    if (typeof d === 'boolean' && typeof v === 'boolean') out[k] = v;
    else if (typeof d === 'string' && typeof v === 'string') out[k] = v;
    else if (typeof d === 'number' && typeof v === 'number' && Number.isFinite(v)) {
      const [min, max, int] = RANGES[k] || [0, Number.MAX_SAFE_INTEGER, false];
      if (int && !Number.isInteger(v)) continue;
      out[k] = Math.min(max, Math.max(min, v));
    }
  }
  return out;
}

export function isLoopback(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export function loadConfig(dir, env = process.env) {
  let fileCfg = {}, fileError = null;
  const file = path.join(dir, 'config.json');
  if (fs.existsSync(file)) {
    try { fileCfg = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (err) { fileError = `config.json 讀不懂（${err.message}），先用預設值`; }
  }
  const cfg = { ...DEFAULTS, ...clean(fileCfg, Object.keys(DEFAULTS)) };
  const envPort = Number(env.MINT_PORT);
  if (env.MINT_PORT && Number.isInteger(envPort) && envPort > 0 && envPort < 65536) cfg.port = envPort;
  return { cfg, fileError };
}

export function applyRuntimePatch(cfg, patch) {
  Object.assign(cfg, clean(patch, RUNTIME_KEYS));
  return cfg;
}

/** What GET /config shows: everything except the API key. */
export function publicConfig(cfg) {
  const { apiKey, ...rest } = cfg;
  return { ...rest, apiKey: apiKey ? '(set)' : '' };
}
