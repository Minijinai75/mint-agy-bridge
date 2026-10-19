// agy / bridge errors → a sentence a player can act on. The raw error is always appended.
// Strings matched here were observed with agy 1.4.2 unless marked (guess).

export function humanError(raw, ctx = {}) {
  const msg = String((raw && raw.message) || raw || '').trim() || 'unknown error';
  const withRaw = text => `${text}（原始錯誤：${msg.slice(0, 600)}）`;

  if (raw && raw.code === 'ENOENT') {
    return withRaw('找不到 agy 程式。先照 README 第 1 步裝好 Antigravity CLI；裝在別的位置就把完整路徑填進 config.json 的 agyPath，再重啟酒館。');
  }
  if (ctx.timedOut || /print.?timeout|deadline exceeded|timed? ?out/i.test(msg)) {
    return withRaw(`超過 ${ctx.timeoutSec ?? '?'} 秒還沒生完，橋把這一發停掉了。按重新生成再試；常常這樣就把 config.json 的 printTimeoutSec 調大。`);
  }
  // Model not in this account's list: agy exits 1 and prints the available models.
  if (/invalid model selection|not recognized as a known model/i.test(msg)) {
    const avail = /Available models:\s*([\s\S]*)$/i.exec(msg);
    const list = avail ? avail[1].split('\n').map(s => s.trim()).filter(Boolean).join('、') : '';
    return withRaw(`這個模型不在你 agy 帳號的清單裡（每個帳號、每種登入方式看到的模型不同）。${list ? `你現在能用的：${list}。` : ''}在酒館重新整理模型清單再選一次。`);
  }
  if (/agent not found|no agent named|unknown agent|available agents/i.test(msg)) {
    return withRaw('agy 找不到橋產生的角色代理檔（agy 版本行為可能變了）。到 GitHub 開 issue 附上這段錯誤。');
  }
  if (/credits balance is too low/i.test(msg)) {
    return withRaw('反重力的 AI 點數不足。到 Antigravity 看用量，或等額度重置。');
  }
  if (/global_online_prediction_requests_per_base_model|quota increase request/i.test(msg)) {
    return withRaw('你的 Google Cloud 專案對這顆模型的配額不夠（429）。到 Google Cloud 主控台的「配額」頁替這顆模型申請提高，或先換別顆模型。');
  }
  if (/RESOURCE_EXHAUSTED|\b429\b|quota exceeded|rate.?limit|too many requests/i.test(msg)) {
    return withRaw('額度或速率到上限（429）。等一兩分鐘再按重新生成，或先換別顆模型。');
  }
  // Content refusals must be checked before sign-in errors: provider refusals can also say "unauthorized".
  if (/safety|blocked|prohibited content|content (policy|filter)|refused/i.test(msg)) {
    return withRaw('模型供應商依內容擋下了這一發。改寫一下再送，或換一顆模型。');
  }
  // Google Cloud project sign-in whose credentials expired (guess: Google auth wording).
  if (/invalid_grant|invalid_rapt|reauth|application default credentials|could not find default credentials/i.test(msg)) {
    return withRaw('Google Cloud 的登入過期或找不到了。在終端機打 agy 照指示重新登入，再按重新生成。');
  }
  // Not signed in (guess: wording varies by agy version).
  if (/not (logged|signed) in|unauthenticated|\b401\b|login required|please (log|sign) ?in|sign in to|authentication/i.test(msg)) {
    return withRaw('agy 還沒登入或登入失效。在終端機打 agy 照指示登入一次，再按重新生成。');
  }
  if (/PERMISSION_DENIED|\b403\b/i.test(msg)) {
    return withRaw('沒有權限用這顆模型（403）。用 Google Cloud 專案登入的話，確認專案已開 Vertex AI、這顆模型已啟用。');
  }
  return msg;
}

/** Pull `AGY_ERROR: {...}` out of agy's stderr, if present. */
export function parseAgyError(stderr) {
  const m = /AGY_ERROR:\s*(\{.*\})\s*$/m.exec(stderr || '');
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
