// agy / bridge errors → a sentence a player can act on. The raw error is always appended.
// Strings matched here were observed with agy 1.4.2 unless marked (guess).
// Order matters: network and permission problems are checked before "content blocked", because
// their wording can contain "refused" / "blocked" too.

export function humanError(raw, ctx = {}) {
  const msg = String((raw && raw.message) || raw || '').trim() || 'unknown error';
  const withRaw = text => `${text}（原始錯誤：${msg.slice(0, 600)}）`;

  if (raw && raw.code === 'ENOENT' && String(raw.syscall || '').startsWith('spawn')) {
    return withRaw('找不到 agy 程式。先照 README 第 1 步裝好 Antigravity CLI；裝在別的位置就把完整路徑填進 config.json 的 agyPath，再重啟酒館。');
  }
  if (raw && (raw.code === 'ENOENT' || raw.code === 'EACCES' || raw.code === 'EPERM' || raw.code === 'ENOSPC')) {
    return withRaw('橋寫不進暫存工作夾（硬碟滿了、權限或防毒擋住）。重啟酒館試試；一直這樣就回報這段錯誤。');
  }
  // Google's output filter. Checked before the timeout: agy retries a blocked reply until time runs out,
  // so before 0.1.1 this was reported as a timeout.
  if (ctx.contentBlocked || /content safety filters|Prohibited Use policy/i.test(msg)) {
    return withRaw('被 Google 的內容過濾擋下了（不是逾時，也不是橋或 agy 壞了）。agy 被擋後會自己重試、每次都白等，所以橋一看到就先停掉。最常被擋的是 Horae 劇情摘要那一發；改寫一下最新那句、換個說法重抽，或換一顆模型。');
  }
  if (ctx.timedOut) {
    return withRaw(`橋在 ${ctx.elapsedSec ?? ctx.timeoutSec ?? '?'} 秒時停掉了 agy：時間到了回覆還沒生完（設定的上限是 ${ctx.timeoutSec ?? '?'} 秒，不是 agy 壞了）。按重新生成再試；argon-high 這類慢模型配長歷史常常要更久，把 config.json 的 printTimeoutSec 再調大。`);
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
  // Network: proxy down, DNS, connection refused, timeouts on the wire.
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|refused it|connection refused|dial tcp|proxyconnect|no such host|getaddrinfo|network is (down|unreachable)|deadline exceeded|tls handshake/i.test(msg)) {
    return withRaw('連不上 Google（網路或代理有問題）。確認網路、代理軟體有開，再按重新生成。');
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
  if (/PERMISSION_DENIED|\b403\b/i.test(msg)) {
    return withRaw('沒有權限用這顆模型（403）。用 Google Cloud 專案登入的話，確認專案已開 Vertex AI（aiplatform.googleapis.com）、這顆模型已啟用。');
  }
  // Content refusals (provider wording). Checked before sign-in: refusals can also say "unauthorized".
  if (/\bSAFETY\b|prohibited[ _]content|PROHIBITED_CONTENT|blocked (due to|by|for) (safety|content|policy)|content (policy|filter|moderation)|RECITATION|refused to (serve|generate|answer|respond)|based on the content/i.test(msg)) {
    return withRaw('模型供應商依內容擋下了這一發。改寫一下再送，或換一顆模型。');
  }
  // Google Cloud sign-in whose credentials expired (guess: Google auth wording).
  if (/invalid_grant|invalid_rapt|reauth|application default credentials|could not find default credentials/i.test(msg)) {
    return withRaw('Google Cloud 的登入過期或找不到了。用 ADC 登入的跑一次 gcloud auth application-default login；用 Google Cloud 帳號登入的在終端機打 agy 重新登入。再按重新生成。');
  }
  // Not signed in (guess: wording varies by agy version).
  if (/not (logged|signed) in|unauthenticated|\b401\b|login required|please (log|sign) ?in|sign in to|authentication/i.test(msg)) {
    return withRaw('agy 還沒登入或登入失效。在終端機打 agy 照指示登入一次，再按重新生成。');
  }
  if (/print.?timeout|timed? ?out/i.test(msg)) {
    return withRaw(`agy 自己的時間上限到了（${ctx.timeoutSec ?? '?'} 秒）。按重新生成再試；常常這樣就把 printTimeoutSec 調大。`);
  }
  // agy ended on its own with nothing on stderr to say why.
  const exit = /^agy exited with code (\d+)$/i.exec(msg);
  if (exit) {
    return withRaw(`agy 自己中途結束了（代碼 ${exit[1]}），沒留下原因。常見是額度到上限（429）、內容被擋、或模型那頭出狀況：等一兩分鐘按重新生成，一直這樣就換一顆模型；要回報的話附上 /status 的內容。`);
  }
  return msg;
}

/** Pull `AGY_ERROR: {...}` out of agy's stderr, if present. */
export function parseAgyError(stderr) {
  const m = /AGY_ERROR:\s*(\{.*\})\s*$/m.exec(stderr || '');
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
