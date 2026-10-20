// A stand-in for the agy CLI, speaking the same stream-json shapes agy 1.4.2 emits.
// Behaviour is picked by markers in the stdin message:
//   #429        → quota error (exit 3, AGY_ERROR on stderr, error_message step)
//   #slow       → stream slowly (~1.5 s) so tests can disconnect / supersede mid-reply
//   #tool       → emit an unexpected step type before the reply
//   #midfail    → stream some text, then fail with a network error (exit 3)
//   #nonl       → the final result line has no trailing newline and reports a denied action
//   #grandchild → leave a sleeping grandchild that keeps stdout open after agy exits
//   #filter     → stream some text, then print Google's content-filter message on stderr and hang
//                 (real agy retries the blocked reply until its timeout)
//   #filter0    → the same, before any text
//   #hang       → print nothing and hang (ignores --print-timeout, like the case reported on 26-10-20)
//   #exit1      → exit with code 1, nothing on stderr, no result line
//   #long       → stream 780 CJK characters (for max_tokens); with #stall, hang 20 s before finishing
//   #quote      → a normal reply whose text quotes the filter sentence (must not count as filtered)
//   #blankfirst → first piece is only a newline, then normal text
//   #stallonce  → first run: stream half a reply, then go silent for 20 s (the 26-10-20 case); the next
//                 run (marker file in FAKE_AGY_DATA) streams a normal reply "重來的回覆。"
//   #stallalways→ every run streams half a reply, then goes silent
//   #think      → a reply that writes a <think> block (~400 tokens) before a short story
//   #twodone    → a first reply step ends (DONE), 300 ms later a second step starts, 400 ms later it ends
//   #stallthink → like #stallonce, but both runs start with their own <think> block
//   #doneonly   → a reply ends with DONE, then neither a result event nor an exit
//   #mismatch   → "<thinking>" closed as "</think>", then a story of ~4,800 tokens (past the thinking limit: max_tokens must still apply)
// --log-file   → the fake writes a few agy-style log lines there, with account details to redact
//   otherwise  → reply "echo:<message>|agent=<bytes of agent file>|tail=<last 40 chars of agent file>"
// FAKE_AGY_DATA (env) = agy data dir; the fake writes conversations/<id>.db and brain/<id>/ there.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

if (argv.includes('--version')) { console.log('1.4.2'); process.exit(0); }
if (argv[0] === 'models') {
  console.log('Fetching available models...');
  console.log('gemini-4-argon-high\tGemini 4 Argon (High)');
  console.log('gemini-3.8-flash-low\tGemini 3.8 Flash (Low)');
  process.exit(0);
}

const out = o => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', async () => {
  const ev = JSON.parse(input.split('\n')[0]);
  const msg = ev.message.content;
  const agent = opt('--agent');
  const agentFile = path.join(process.cwd(), '.agents', 'agents', `${agent}.md`);
  if (!fs.existsSync(agentFile)) {
    out({ event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error: `agent not found: ${agent}` } });
    process.exit(1);
  }
  const agentText = fs.readFileSync(agentFile, 'utf8');
  const id = randomUUID();
  const data = process.env.FAKE_AGY_DATA;
  if (data) {
    fs.mkdirSync(path.join(data, 'conversations'), { recursive: true });
    fs.writeFileSync(path.join(data, 'conversations', `${id}.db`), 'x');
    fs.mkdirSync(path.join(data, 'brain', id, '.system_generated'), { recursive: true });
  }
  if (opt('--log-file')) fs.appendFileSync(opt('--log-file'), 'I1020 server_oauth.go:224] applyAuthResult: email=player@example.com, authMethod=gcp, quotaProject=my-proj-123\nI1020 http.go:349] URL: https://aiplatform.googleapis.com/v1/projects/my-proj-123/locations/global\nI1020 manager.go:88] workspace C:\\Users\\Player\\Secret Folder\\ws\nI1020 server.go:1199] Conversation using project ID: my-proj-123\n');
  if (process.env.FAKE_AGY_PIDLOG) fs.appendFileSync(process.env.FAKE_AGY_PIDLOG, `${process.pid}\t${msg.slice(0, 40).replace(/\s+/g, ' ')}\n`);   // which run a leftover process belongs to
  if (process.env.FAKE_AGY_ARGS_OUT) fs.writeFileSync(process.env.FAKE_AGY_ARGS_OUT, JSON.stringify({ argv, env: { retries: process.env.AGY_CLI_MODEL_API_MAX_RETRIES, noUpdate: process.env.AGY_CLI_DISABLE_AUTO_UPDATE }, agentText, msg }));

  out({ event: 'init', conversation_id: id, init: { model: opt('--model'), agent, tools: ['run_command'], permission_mode: 'request-review' } });
  out({ event: 'step_update', step_update: { conversation_id: id, step_index: 0, state: 'DONE', step_type: 'user_input' } });

  if (msg.includes('#429')) {
    const e = 'Quota exceeded for aiplatform.googleapis.com/global_online_prediction_requests_per_base_model with base model: anthropic-claude-opus. Please submit a quota increase request.';
    out({ event: 'step_update', step_update: { conversation_id: id, step_index: 1, state: 'DONE', step_type: 'error_message' } });
    out({ event: 'result', result: { conversation_id: id, status: 'ERROR', response: '', error: e, usage: { input_tokens: 0, output_tokens: 0 } } });
    process.stderr.write(`error: ${e}\nAGY_ERROR: ${JSON.stringify({ short_error: `RESOURCE_EXHAUSTED (code 429): ${e}`, retryable: false })}\n`);
    process.exit(3);
  }
  if (msg.includes('#midfail')) {
    out({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: '前半段' } });
    await sleep(100);
    process.stderr.write('AGY_ERROR: {"short_error":"dial tcp 142.250.0.1:443: connectex: No connection could be made because the target machine actively refused it.","retryable":true}\n');
    process.exit(3);
  }
  if (msg.includes('#filter')) {
    if (!msg.includes('#filter0')) {
      out({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: '正文寫完了。' } });
      await sleep(100);
    }
    process.stderr.write('W1020 retry.go:88] Your previous response was blocked by content safety filters: The model output could not be generated. This output contains sensitive words that violate Google\'s Generative AI Prohibited Use policy. If you think this was an error, send feedback.\nPlease provide a response that complies with content policies, or briefly explain to the user why you cannot help with this request\nRetries remaining: 3\n');
    await sleep(20000);
    process.exit(1);
  }
  if (msg.includes('#hang')) { await sleep(20000); process.exit(0); }
  if (msg.includes('#exit1')) process.exit(1);
  if (msg.includes('#long')) {
    for (let i = 0; i < 60; i++) {
      out({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: '狐狸在雪地裡慢慢走著回家。' } });
      await sleep(5);
    }
    if (msg.includes('#stall')) await sleep(20000);
    out({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: '', usage: { input_tokens: 100, output_tokens: 700 } } });
    out({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: '', usage: { input_tokens: 100, output_tokens: 700 } } });
    process.exit(0);
  }
  if (msg.includes('#stallonce') || msg.includes('#stallalways')) {
    const mark = path.join(data || process.cwd(), 'stalled-once');
    if (msg.includes('#stallalways') || !fs.existsSync(mark)) {
      fs.writeFileSync(mark, '1');
      for (const piece of ['前半段', '寫到一半']) {
        out({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: piece } });
        await sleep(50);
      }
      await sleep(20000);
      process.exit(0);
    }
    fs.rmSync(mark, { force: true });
    out({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: '重來的回覆。' } });
    out({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: '', usage: { input_tokens: 100, output_tokens: 6 } } });
    out({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: '重來的回覆。', usage: { input_tokens: 100, output_tokens: 6 } } });
    process.exit(0);
  }
  if (msg.includes('#donehang')) {   // reply complete, then agy takes 3 s to wrap up (must not count as a stall)
    out({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: '完整的回覆。' } });
    out({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: '', usage: { input_tokens: 100, output_tokens: 6 } } });
    await sleep(3000);
    out({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: '完整的回覆。', usage: { input_tokens: 100, output_tokens: 6 } } });
    process.exit(0);
  }
  const step = (text, state = 'ACTIVE', extra = {}) => out({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state, step_type: 'agent_response', text_delta: text, ...extra } });
  const finishOk = text => { out({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: text, usage: { input_tokens: 100, output_tokens: 50 } } }); process.exit(0); };
  if (msg.includes('#twodone')) {
    step('第一段。'); step('', 'DONE', { usage: { input_tokens: 100, output_tokens: 4 } });
    await sleep(300);
    out({ event: 'step_update', step_update: { conversation_id: id, step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: '第二' } });
    await sleep(400);
    out({ event: 'step_update', step_update: { conversation_id: id, step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: '段。' } });
    out({ event: 'step_update', step_update: { conversation_id: id, step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: '', usage: { input_tokens: 100, output_tokens: 8 } } });
    finishOk('第一段。第二段。');
  }
  if (msg.includes('#stallthink')) {
    const mark = path.join(data || process.cwd(), 'stalled-once');
    if (!fs.existsSync(mark)) {
      fs.writeFileSync(mark, '1');
      step('<think>想A</think>\n'); await sleep(30); step('半截');
      await sleep(20000); process.exit(0);
    }
    fs.rmSync(mark, { force: true });
    step('\n<thi'); step('nk>想B'); step('</think>\n'); step('全文。'); step('', 'DONE');
    finishOk('<think>想B</think>\n全文。');
  }
  if (msg.includes('#mismatch')) {
    step('<thinking>想一下'); step('</think>\n');
    for (let i = 0; i < 420; i++) { step('狐狸在雪地裡慢慢走著回家。'); if (i % 20 === 0) await sleep(1); }
    step('', 'DONE'); finishOk('');
  }
  if (msg.includes('#doneonly')) {   // DONE, then no result event and no exit
    step('只有完成訊號。'); step('', 'DONE', { usage: { input_tokens: 100, output_tokens: 7 } });
    await sleep(20000); process.exit(0);
  }
  if (msg.includes('#donenoexit')) {   // the 26-10-20 case: reply and result sent, then agy never exits
    for (const piece of ['正文', '生完了。']) out({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: piece } });
    out({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: '\n', usage: { input_tokens: 48493, output_tokens: 3961 } } });
    out({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: '正文生完了。\n', usage: { input_tokens: 48493, output_tokens: 3961 } } });
    await sleep(20000);
    process.exit(0);
  }
  if (msg.includes('#think')) {
    const pieces = ['<think>\n', ...Array(40).fill('先想清楚角色此刻的心情與場景。'), '\n</think>\n', '狐狸', '回家了。'];
    for (const piece of pieces) out({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: piece } });
    out({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: '', usage: { input_tokens: 100, output_tokens: 500 } } });
    out({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: '', usage: { input_tokens: 100, output_tokens: 500 } } });
    process.exit(0);
  }
  if (msg.includes('#grandchild')) {
    const { spawn } = await import('node:child_process');
    spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
  }
  if (msg.includes('#tool')) out({ event: 'step_update', step_update: { conversation_id: id, step_index: 1, state: 'DONE', step_type: 'run_command' } });

  if (msg.includes('#quote')) {
    const q = 'The guard read the notice aloud: "blocked by content safety filters" under the Generative AI Prohibited Use policy.';
    for (const piece of q.match(/[\s\S]{1,20}/g)) out({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: piece } });
    out({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: '', usage: { input_tokens: 1, output_tokens: 30 } } });
    out({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: q, usage: { input_tokens: 1, output_tokens: 30 } } });
    process.exit(0);
  }
  if (msg.includes('#blankfirst')) out({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: '\n' } });
  const reply = `echo:${msg.slice(0, 200)}|agent=${Buffer.byteLength(agentText)}|tail=${agentText.trimEnd().slice(-40)}`;
  const pieces = reply.match(/[\s\S]{1,12}/g);
  const delay = msg.includes('#slow') ? Math.ceil(1500 / pieces.length) : 0;
  for (const piece of pieces) {
    out({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: piece } });
    if (delay) await sleep(delay);
  }
  const usage = { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 0, total_tokens: 125 };
  out({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: '\n', usage } });
  const result = { event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: reply + '\n', usage } };
  if (msg.includes('#nonl')) {
    result.result.denied_actions = [{ tool: 'write_to_file' }];
    process.stdout.write(JSON.stringify(result), () => process.exit(0));
    return;
  }
  out(result);
  process.exit(0);
});
