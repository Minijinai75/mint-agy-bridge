// Live test against a running bridge and the real agy (uses your quota — a handful of requests).
//   node standalone.mjs            (in another terminal; or MINT_PORT=5499)
//   node test/live-e2e.mjs [baseUrl] [model]
// Shots: short / long history (~150 KB) with codes at both ends / regenerate / oversized latest message (~250 KB).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:5499';
const MODEL = process.argv[3] || 'gemini-4-argon-high';
const DATA = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');

const CARD = [
  '你在互動小說裡扮演林小滿：二十八歲，台北大稻埕巷口「滿月烘焙」的老闆娘，凌晨四點起床揉麵團。',
  '個性嘴硬心軟、愛碎念、對常客很護短，口頭禪是「厚～」。使用者扮演每天早上來買麵包的上班族。',
  '用繁體中文回覆，每次 60 到 120 字，動作用＊包起來。',
].join('\n');

async function ask(messages, label) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, stream: true, messages }) });
  let text = '', ttft = null, finish = null;
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const ev = buf.slice(0, i); buf = buf.slice(i + 2);
      if (!ev.startsWith('data: ') || ev === 'data: [DONE]') continue;
      const j = JSON.parse(ev.slice(6));
      const c = j.choices[0].delta.content;
      if (c) { ttft ??= Date.now() - t0; text += c; }
      finish = j.choices[0].finish_reason || finish;
    }
  }
  const out = { label, status: res.status, ttftMs: ttft, totalMs: Date.now() - t0, finish, chars: text.length, text };
  console.log(JSON.stringify({ ...out, text: text.slice(0, 300) }));
  return out;
}

const convCount = () => { try { return fs.readdirSync(DATA).length; } catch { return null; } };
const before = convCount();
const results = [];
const greet = [{ role: 'system', content: CARD }, { role: 'assistant', content: '＊鐵捲門拉起一半，小滿彎腰鑽出來。＊「厚～你又這麼早？麵包還沒出爐啦。」' }];

// 1. short
const short = [...greet, { role: 'user', content: '早安！今天有什麼麵包？' }];
results.push(await ask(short, 'short'));

// 2. long history, ~150 KB, a code at the start and one at the end of the history
const hist = [];
let n = 0;
const line = k => `第${k}天：我買了${(k * 7) % 9 + 1}個菠蘿麵包，妳說今天的奶酥特別香，我們聊了巷口新開的豆花店和下雨天的生意。`;
hist.push({ role: 'user', content: '先記住：開頭暗號是「青花椒七號」。' }, { role: 'assistant', content: '＊小滿翻白眼＊「好啦記住了，青花椒七號。」' });
while (Buffer.byteLength(JSON.stringify(hist)) < 150000) {
  n++; hist.push({ role: 'user', content: line(n) }, { role: 'assistant', content: `＊小滿一邊包麵包一邊碎念＊「第${n}天了耶，厚～你都不膩喔？」` });
}
hist.push({ role: 'user', content: '再記一個：結尾暗號是「藍莓氣泡十一」。' }, { role: 'assistant', content: '＊她用麵粉在櫃檯寫字＊「藍莓氣泡十一，記好了。」' });
const longMsgs = [...greet, ...hist, { role: 'user', content: '（出戲一下，請直接回答）開頭暗號、結尾暗號各是什麼？我們聊到第幾天？' }];
console.log(`long history bytes ≈ ${Buffer.byteLength(JSON.stringify(longMsgs))}, days=${n}`);
const long = await ask(longMsgs, 'long-150KB');
results.push({ ...long, checks: { head: long.text.includes('青花椒七號'), tail: long.text.includes('藍莓氣泡十一'), day: long.text.includes(String(n)) } });

// 3. regenerate the short one (same messages, as a swipe would send)
const again = await ask(short, 'regenerate');
results.push({ ...again, differs: again.text !== results[0].text });

// 4. oversized latest message (~250 KB): the bridge must move it into the agent file
let big = '以下是一份很長的店務流水帳，請不要演戲，只照最後一行的指示做。\n';
let k = 0;
while (Buffer.byteLength(big) < 250000) { k++; big += `第${k}筆：賣出${(k * 7) % 23 + 1}個菠蘿麵包、${(k * 3) % 11 + 1}個肉鬆捲，收現金${k * 13 % 997}元。\n`; }
big += '尾端暗號是「橘子汽水三號」。\n最後一行指示：只回答尾端暗號是什麼，以及流水帳最後一筆的編號。';
const huge = await ask([...greet, { role: 'user', content: big }], 'oversized-latest-250KB');
results.push({ ...huge, bytes: Buffer.byteLength(big), lastNo: k, checks: { tailCode: huge.text.includes('橘子汽水三號'), lastNo: huge.text.includes(String(k)) } });

const after = convCount();
const summary = { model: MODEL, conversationsBefore: before, conversationsAfter: after, results: results.map(r => ({ ...r, text: r.text.slice(0, 400) })) };
const outFile = process.env.LIVE_OUT || path.join(os.tmpdir(), `mint-live-${Date.now()}.json`);
fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
console.log(`\nsaved → ${outFile}`);
console.log(JSON.stringify({ conversationsBefore: before, conversationsAfter: after, long: results[1].checks, regenerateDiffers: results[2].differs, oversized: results[3].checks }));
