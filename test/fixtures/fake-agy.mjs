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
