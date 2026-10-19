// Settings: built-in defaults ← config.json next to index.mjs ← environment (MINT_PORT, for testing).
// POST /config can change the "runtime" keys in memory; restart returns to config.json.

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_FRAMING } from './agent-file.mjs';

export const DEFAULTS = Object.freeze({
  port: 5499,
  host: '127.0.0.1',
  apiKey: '',                    // set it to require "Authorization: Bearer <apiKey>"
  agyPath: '',                   // '' = auto-detect
  agyDataDir: '',                // '' = ~/.gemini/antigravity-cli
  adcAuth: false,                // true = run agy with AGY_ADC_AUTH=true (Application Default Credentials sign-in)
  defaultModel: '',              // used when the request names no model; '' = first model agy lists
  printTimeoutSec: 300,
  maxRetries: 0,                 // agy's own retries on API errors (default agy behaviour waits ~140 s on a 429)
  stdinLimitBytes: 180000,       // agy cuts user messages at ~192,000 bytes; anything larger goes to the agent file
  cleanupConversations: true,    // delete agy's local copy of each conversation after the reply
  resumeMinutes: 15,             // keep a finished reply for this long when SillyTavern disconnected mid-way
  usageLog: true,                // write token counts (no content) to usage/YYYY-MM.jsonl
  framing: DEFAULT_FRAMING,      // one paragraph put before the character card; '' to disable
});

const RUNTIME_KEYS = ['defaultModel', 'printTimeoutSec', 'maxRetries', 'cleanupConversations', 'resumeMinutes', 'usageLog', 'framing'];

function clean(raw, keys) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of keys) {
    if (!(k in raw)) continue;
    const v = raw[k], d = DEFAULTS[k];
    if (typeof d === 'boolean' && typeof v === 'boolean') out[k] = v;
    else if (typeof d === 'string' && typeof v === 'string') out[k] = v;
    else if (typeof d === 'number' && typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      if (k === 'port' && !(Number.isInteger(v) && v > 0 && v < 65536)) continue;
      if (k === 'printTimeoutSec' && v < 10) continue;
      if (k === 'stdinLimitBytes' && v < 1000) continue;
      if (k === 'maxRetries' && !(Number.isInteger(v) && v <= 20)) continue;
      out[k] = v;
    }
  }
  return out;
}

export function loadConfig(dir, env = process.env) {
  let fileCfg = {}, fileError = null;
  const file = path.join(dir, 'config.json');
  if (fs.existsSync(file)) {
    try { fileCfg = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (err) { fileError = `config.json 讀不懂（${err.message}），先用預設值`; }
  }
  const cfg = { ...DEFAULTS, ...clean(fileCfg, Object.keys(DEFAULTS)) };
  if (env.MINT_PORT && Number.isInteger(Number(env.MINT_PORT))) cfg.port = Number(env.MINT_PORT);
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
