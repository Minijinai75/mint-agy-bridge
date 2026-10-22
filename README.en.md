# Mint AGY Bridge (薄荷橋)

> 中文版：[README.md](README.md)

Chat in SillyTavern with your own **Antigravity** account. Mint AGY Bridge is a SillyTavern server plugin that opens an OpenAI-compatible endpoint on your machine and calls Google's official Antigravity CLI (`agy`) behind it. The headline model is **Gemini 4 Argon**; which models you can actually pick depends on your account and how you signed in.

In short: an OpenAI-compatible `/v1/chat/completions` (streaming and non-streaming) backed by the official Antigravity CLI. Zero dependencies, Node 18+, Windows / macOS / Linux. The models are whatever `agy models` lists for your account.

One thing to know before you start: the bridge's own messages — the red notice in SillyTavern, the console lines and the `warnings` on the status page — are in Chinese, and there is no language switch. Match them by the original line, the number in it, or the raw error after `（原始錯誤：…）` ("original error:"). A red notice about a message that failed while generating starts with `薄荷橋：` (the bridge's name); console lines start with `[mint-agy-bridge]`; the status page's `warnings` carry no prefix. The [Common errors](#common-errors) table below lists each Chinese line next to its English meaning.

## Who it is for

- SillyTavern players who have an Antigravity account and can already run `agy` in a terminal.
- Anyone who wants to play character cards with Gemini 4 Argon (or the other models in their account).

## Install in three steps

**1. Install the Antigravity CLI**

```powershell
# Windows (PowerShell)
irm https://antigravity.google/cli/install.ps1 | iex
```
```bash
# macOS / Linux
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

Run this in **a terminal you opened yourself** (Windows: Start menu → PowerShell or Windows Terminal). On Windows, if you let an AI inside an app such as the Claude desktop app run it for you, agy ends up in that app's private drawer and SillyTavern cannot see it — why, how to tell, and how to fix it are under [File-system virtualization in MSIX-packaged apps (MSIX 封裝 App 的檔案虛擬化)](#file-system-virtualization-in-msix-packaged-apps-msix-封裝-app-的檔案虛擬化-letting-the-claude-desktop-app-install-agy-bites) below (Windows only).

macOS / Linux: the install script puts `agy` in `~/.local/bin/agy` (as the install guides on the web describe it; the official page is <https://antigravity.google/docs/install/>). Afterwards **open a new terminal** and run `agy --version`. If the shell says the command is not found, `~/.local/bin` is not on your PATH: add `export PATH="$HOME/.local/bin:$PATH"` to `~/.bashrc` or `~/.zshrc`. When SillyTavern is started from a desktop shortcut, launchd or systemd, it often sees a different PATH than your terminal does; if the bridge cannot find agy, the surest fix is to put the full path into `agyPath` in `config.json` (see below).

**2. Sign in to agy**

Type `agy` in a terminal and sign in once as the screen tells you, then run `agy models` to see which models you have. The sign-in method decides the model list (official docs: <https://antigravity.google/docs/install/>):

| Sign-in | Models we saw (agy 1.4.2, 2026-10-19) |
|---|---|
| Personal Google account | Gemini 3.8 Flash, Claude Sonnet / Opus 4.6, GPT-OSS 120B |
| Google Cloud project (business account) | Gemini 4 Argon, Gemini 3.1 Pro, Gemini 3.6–3.8 Flash, Claude Opus / Sonnet 5.5 |
| Application Default Credentials (ADC) | Same family as the Google Cloud project; set `"adcAuth": true` in `config.json` |

**What `agy models` prints on your machine is what counts**; the table is only what we saw, and Google changes it at any time. Claude 5.5 through a Google Cloud project also needs quota on that project, or you get a 429.

**3. Install the plugin and connect SillyTavern**

```bash
cd SillyTavern/plugins
git clone https://github.com/Minijinai75/mint-agy-bridge.git
```

1. Open `SillyTavern/config.yaml` and make sure `enableServerPlugins: true`.
2. Restart SillyTavern. When the console shows `[mint-agy-bridge] 在 http://127.0.0.1:5499/v1 待命` ("standing by at …") followed by the model list, it is working.
3. In SillyTavern: "API Connections" → **Chat Completion** → source **Custom (OpenAI-compatible)** → URL `http://127.0.0.1:5499/v1` → Connect → pick a model from the dropdown.

You can also run it without SillyTavern: `node standalone.mjs` in the repo folder; the endpoint is the same `http://127.0.0.1:5499/v1`.

## Upgrade in three steps

1. **Pull the new version**: in a terminal, go to the plugin folder and pull.
   ```bash
   cd SillyTavern/plugins/mint-agy-bridge
   git pull
   ```
2. **Skim the changelog**: open [CHANGELOG.md](CHANGELOG.md) and check whether the new version has a "read before upgrading" note. `git pull` never touches your `config.json` — which also means an old number you once copied into it overrides the new default (for example `printTimeoutSec: 300` from the 0.1.0 example). Delete the line of any field you have no reason to change and the new default applies.
3. **Restart SillyTavern**: plugins load only at startup. After the restart open the status page `http://127.0.0.1:5499/status`; when `"version"` shows the new number you are done.

## What to expect

- **Time to first token**: every message starts a fresh agy. In our measurements a short chat on `gemini-4-argon-low` takes 6–23 s to the first token, and it jumps around within one evening (the bridge itself spends about 1 s per message; the rest is agy and Google's side). `-high` thinks first and adds 5–20 s. For chat, low or medium is the better choice.
- **Long chats**: with 150,000 bytes of history (about 45,000 tokens) the model answered details from both the beginning and the end.
- **Regenerate / edit an older message**: works as usual; every message is a fresh run. A new request in the same chat stops the one still generating (no queue); different chats can generate at the same time (default limit 2).
- **"Continue"**: SillyTavern's Continue picks up where the last reply stopped.
- **Phone disconnects**: if SillyTavern drops the connection mid-reply, the bridge lets the reply finish and keeps it (15 minutes by default); press "Regenerate" when you are back and you get the whole thing without spending quota again.
- **⚠ The Stop button does not stop agy**: the bridge cannot tell a Stop from a dropped connection, so by default it finishes the reply anyway (quota is spent), and pressing Regenerate right after Stop hands you the full version of that same reply; press once more for a new one. If you mind, set `keepOnDisconnect` to `false`: a disconnect then really stops agy, at the price of losing the reply when your phone drops.
- **Max Response Length is honoured** (since 0.1.1): agy itself has no output limit, so the bridge counts tokens as they stream in (an estimate: about 1.15 Chinese characters or 4.4 Latin letters per token) and stops cleanly when your limit is reached. **Thinking does not count** (since 0.1.2): the model's own thinking never leaves agy anyway; and when your preset asks the model to write its thinking into the reply inside `<think>` / `<thinking>` / `<reasoning>` (SillyTavern moves it into the "thinking" box), that part is not counted either — the limit is for the story only. Thinking tags with other names are not recognised and do count. **SillyTavern's default is 300 tokens** (about 350 Chinese characters); if replies get cut short, raise "Max Response Length" (4000–8000, say), or set `"honorMaxTokens": false` in `config.json` to leave it to the model.
- **The reply is finished but agy does not exit** (fixed in 0.1.2): on some players' machines agy sends the whole reply and then does not quit; 0.1.1 waited until the timeout and reported an error. Now, as soon as agy says "this turn is done", the bridge hands the reply to SillyTavern without waiting for the process; agy gets 10 s to exit on its own, then it is stopped, and the message still counts as a success (the status page marks it `lingered: true`). When agy only says "this reply step is done" without "this turn is done", the bridge waits those 10 s (a second step could follow) before handing over, so now and then the spinner runs about 10 s longer; `sawResult: false` on the status page is that case.
- **A stall is retried once automatically** (since 0.1.2): 120 s (`stallSec`) without a new word after text has started, or 180 s before the first word (`stallFirstSec`; the model may be thinking first, so this one is generous), and the bridge stops that run and **sends it again once — the retry spends quota again**. The half reply already streamed cannot be taken back, so a line "〔前一發卡住，重來〕" ("the previous run stalled, starting over") appears before the new reply; delete that half yourself or press Regenerate. If the first run had already finished its thinking block, the retry's thinking block is kept out of the story. If the retry stalls too, there is no third try; a red notice says "no words from the model for N seconds". Set `"stallRetry": false` to turn the retry off. If you raised `maxRetries`: agy prints nothing while it retries a 429 itself, and a long wait looks like a stall, so raise `stallFirstSec` along with it.
- **Other sampling parameters have no effect**: agy does not expose temperature, Top P and friends, so the bridge has to ignore them.
- **Speed is Google's**: output speed is not constant and differs a lot between evenings on the same model — we measured `argon-medium` with 40,000 tokens of history at about 13 tokens/s (a 4,400-token reply took 5½ minutes) and `argon-low` on a short chat at 36–52 tokens/s; the first token sometimes took 6 s, sometimes 140 s. The bridge waits up to 900 s by default; for `argon-high` with a long history and a long reply, raise `printTimeoutSec`. `tokPerSec` on the status page is that message's speed from its first word to its last.
- **Images**: v0.1 does not send images; each one is replaced by a one-line note saying no image was attached.

## Configuration (optional)

Copy `config.example.json` to `config.json`, keep only the fields you want to change, restart to apply:

| Field | Default | Meaning |
|---|---|---|
| `port` | `5499` | The endpoint's port |
| `host` | `127.0.0.1` | Local only. Set `apiKey` before changing it to another address |
| `apiKey` | empty | Once set, SillyTavern's API Key field must hold the same string |
| `agyPath` | auto-detect | Fill in the full path when the status page says agy cannot be found. Windows installs here by default, copy it as is: `"agyPath": "%LOCALAPPDATA%\\agy\\bin\\agy.exe"` (backslashes are doubled in JSON; `%LOCALAPPDATA%` is expanded by the bridge since 0.1.2). macOS / Linux: run `which agy` in a terminal and copy what it prints, for example `"agyPath": "~/.local/bin/agy"` (a leading `~` is expanded to your home folder since 0.1.4) |
| `adcAuth` | `false` | Set `true` when you sign in with ADC |
| `defaultModel` | empty | The model used when a request names none; empty = the first one in the list |
| `printTimeoutSec` | `900` | How long one message may take at most (0.1.0 had 300, not enough for slow models with long chats). Raise it further for `argon-high` with a long history |
| `stallSec` | `120` | After text has started, this many seconds without a new word counts as a stall; `0` = no check |
| `stallFirstSec` | `180` | The same for the first word; `0` = no check (only `printTimeoutSec` applies) |
| `stallRetry` | `true` | Send a stalled message again once (spends quota again); `false` = report the error instead |
| `honorMaxTokens` | `true` | Stop the reply at SillyTavern's "Max Response Length" (estimated; thinking blocks not counted); `false` = no limit, the model stops by itself |
| `maxRetries` | `0` | How often agy retries 429s and similar errors by itself. agy's own default retries for about 140 s before giving up; the bridge defaults to 0 so you get the error within seconds and decide yourself |
| `stdinLimitBytes` | `180000` | A latest message larger than this moves into the agent file (max 185000; higher would hit agy's truncation) |
| `cleanupConversations` | `true` | Delete agy's local copy of each conversation after the reply |
| `keepOnDisconnect` | `true` | When SillyTavern disconnects (or you press Stop), finish anyway and keep the reply; `false` = stop at once |
| `resumeMinutes` | `15` | How long a disconnected reply is kept |
| `maxConcurrent` | `2` | How many messages may generate at the same time across different chats |
| `usageLog` | `true` | Write token counts (never content) to `usage/` |

Status page: `http://127.0.0.1:5499/status` (agy version, model list, warnings; `agy.path` is the agy the bridge actually found and runs). Once `apiKey` is set, the status page needs it too: `curl -H "Authorization: Bearer your-key" http://127.0.0.1:5499/status`; or read the lines starting with `[mint-agy-bridge]` in SillyTavern's console.

### How the bridge finds agy (the same order on all three platforms, different places)

1. `agyPath` in `config.json` (when set, nothing else is tried; `%VAR%` and a leading `~` are expanded).
2. PATH: the first folder on the PATH that SillyTavern's process sees which holds `agy` (`agy.exe` on Windows).
3. The installer's default locations for the platform, in order:
   - Windows: `%LOCALAPPDATA%\agy\bin\agy.exe`
   - Linux: `~/.local/bin/agy`, `/usr/local/bin/agy`, `~/.antigravity/bin/agy`
   - macOS: `~/.local/bin/agy`, `/opt/homebrew/bin/agy`, `/usr/local/bin/agy`, `~/.antigravity/bin/agy`
4. Failing all of that, the bare `agy` (`agy.exe` on Windows) is run and the operating system searches the PATH once more; if that fails too, the status page and the console list every default location that could not be read, with its error code.

On Windows the bridge additionally looks into the drawers of MSIX-packaged apps (next section); macOS / Linux have no such thing and skip it silently.

## Common errors

When a message fails, SillyTavern shows a red notice; the error is never written into the character's reply (streaming or not). If nothing had been produced yet, the message is not saved as a reply; if it failed half-way, the text already produced stays and the notice is shown separately. The original error is in brackets inside the notice.

The bridge's own messages (the red notice, the console, the status page's warnings) are in Chinese; match by the original line, the number, or the raw error after `（原始錯誤：…）`. The left column below gives the Chinese line as the bridge prints it, with its English meaning.

**When you report a problem, include the status page**: open `http://127.0.0.1:5499/status` in a browser and paste the whole page. It holds the version, the model of the last message, how long it took, how many tokens it produced, the tokens per second (`tokPerSec`), and whether it timed out, stalled or was filtered — no chat content. "Same here" alone does not tell us which case it was. Do not restart SillyTavern right away after a failure: copy the status page first, a restart clears the "last message". For runs that stalled, timed out or where agy did not exit, the bridge keeps agy's own log in the plugin folder's `logs/` (the last 5 only; e-mail, Google Cloud project id, tokens and your own agy permission rules are masked, your user folder is written as `~`; the log holds no character card and no chat content); `agyLog` on the status page names the file, and we may ask you for its last few dozen lines.

| You see | Cause and what to do |
|---|---|
| `找不到 agy 程式` ("agy not found") / status page: `找不到 agy 或讀不到版本` ("agy not found, or its version cannot be read") | Fastest fix: fill in `agyPath` in `config.json` (Windows: the full path of agy.exe; macOS / Linux: what `which agy` prints in a terminal, usually `~/.local/bin/agy`) and restart SillyTavern. On macOS / Linux the usual cause is a SillyTavern started from the desktop or a service, whose PATH lacks `~/.local/bin`; `agyPath` goes around that. agy is installed but is not found right as SillyTavern starts (two players hit this): since 0.1.2 the bridge looks again after 5 s, up to three times, and opening the status page looks once more; the console prints the error code of that moment (`ENOENT`, `EBUSY`, `EPERM`…), include it when you report. **Windows, agy was installed for you by the Claude desktop app, and even a full `agyPath` gives `ENOENT`**: see "File-system virtualization in MSIX-packaged apps" (MSIX 封裝 App 的檔案虛擬化) below; since 0.1.3 the status page adds a hint. Only when agy is really not installed go back to step 1 |
| `模型那頭 N 秒沒出字` ("no words from the model for N seconds") | The reply stopped moving (half-way, or before the first word); not a timeout, not a broken bridge. If the notice says it was "already sent again once", the retry stalled too; wait a minute or two and press Regenerate, and switch models if it keeps happening |
| `這個模型不在你 agy 帳號的清單裡` / `模型「…」不在你 agy 帳號的清單裡` ("the model is not in your agy account's list") | Your sign-in does not see this model. Refresh SillyTavern's model list and pick again |
| `你的 Google Cloud 專案對這顆模型的配額不夠（429）` ("your Google Cloud project's quota for this model is too low (429)") | In the Google Cloud console's "Quotas" page request a higher quota for that model, or switch models |
| `額度或速率到上限（429）` ("quota or rate limit reached (429)") | Wait a minute or two and press Regenerate, or switch models |
| `反重力的 AI 點數不足` ("not enough Antigravity AI credits") | Check your usage in Antigravity |
| `agy 還沒登入或登入失效` ("agy not signed in, or the sign-in expired") / `Google Cloud 的登入過期或找不到了` ("the Google Cloud sign-in expired or cannot be found") | Type `agy` in a terminal and sign in again; with ADC run `gcloud auth application-default login` |
| `連不上 Google（網路或代理有問題）` ("cannot reach Google (network or proxy)") | The network is down or your proxy software is not running |
| `被 Google 的內容過濾擋下了` ("blocked by Google's content filter") | Google judged this output against its usage policy (the original error says `content safety filters`). agy retries a blocked reply three times, waiting in vain each time, so the bridge stops it as soon as it sees the message instead of dragging on to the timeout. **The most often blocked one is Horae's plot summary** (it asks the model to retell the whole plot). Rephrase the latest line, swipe with other wording, or switch models |
| `模型供應商依內容擋下了這一發` ("the model provider refused this one for its content") | The provider's other content moderation. Rephrase and send again, or switch models |
| `沒有權限用這顆模型（403）` ("no permission for this model (403)") | The Google Cloud project has Vertex AI (`aiplatform.googleapis.com`) disabled or the model is not enabled |
| `橋在 N 秒時停掉了 agy` ("the bridge stopped agy at N seconds") | Time ran out before the reply was finished; the bridge stopped it, agy is not broken. Press Regenerate; if it happens often raise `printTimeoutSec` (a slow model, a long history and a long reply together hit it most easily) |
| `agy 自己中途結束了（代碼 N）` ("agy ended on its own (code N)") | agy quit without saying why: usually quota, a content block or trouble on the model's side. Wait a minute or two and press Regenerate, switch models if it keeps happening; include the status page when you report |
| `這一則被同一段對話的新請求取代了` ("replaced by a newer request in the same chat", HTTP 409) | You sent another line or pressed Regenerate before it finished; normal |
| `同時在生的已經有 N 則` ("N messages already generating", HTTP 429) | Other chats are still generating; wait for them, or raise `maxConcurrent` |
| `API key 不對（config.json 的 apiKey）` ("wrong API key", HTTP 401) | SillyTavern's API Key field must equal `apiKey` in `config.json` |
| `agy 找不到橋產生的角色代理檔` ("agy cannot find the agent file the bridge wrote") | A new agy version changed behaviour; please open an issue on GitHub |
| console: `埠 5499 被佔用了，橋沒啟動` ("port 5499 is in use, the bridge did not start") | Another bridge may already be running (one inside SillyTavern plus a standalone, say). For two of them, change `port` in `config.json` and the URL in SillyTavern |

`useG1Credits 是開的` ("useG1Credits is on") on the status page: this is agy's global setting; once the free quota is used up it silently charges paid AI credits. The bridge never changes it; whether to turn it off is your call.

### File-system virtualization in MSIX-packaged apps, "MSIX 封裝 App 的檔案虛擬化" (letting the Claude desktop app install agy bites)

The red notice and the status page point here by the Chinese title, `README「MSIX 封裝 App 的檔案虛擬化」`.

Windows only: MSIX and file-system virtualization are Windows mechanisms; macOS / Linux have nothing of the kind, and on those platforms the bridge neither shows this hint nor looks into any drawer.

**Symptom**: agy is "installed" and runs fine inside the Claude desktop app, but a SillyTavern started from the desktop keeps saying agy cannot be found; even a full path in `agyPath` in `config.json` gives `ENOENT`. A SillyTavern started from inside Claude works.

**Cause**: the Claude desktop app for Windows is an **MSIX package** — the Microsoft Store kind of packaging, but not only Store installs count: the installer downloaded from Claude's website is packaged the same way. Such an app, and every child process it starts (including a PowerShell you had the AI open inside it), has its new files under `%LOCALAPPDATA%` quietly redirected by Windows into `%LOCALAPPDATA%\Packages\Claude_<some id>\LocalCache\Local\` — that is "file-system virtualization". For that app the path looks unchanged and the files are all there; for every other program the same path is empty. So an agy installed by running `install.ps1` inside Claude lives in Claude's private drawer, visible only to Claude and the programs it started; even when PATH has agy's folder, that folder is empty when seen from the desktop. agy's settings and sign-in live in `~/.gemini`, outside the virtualized area, and the player who found this did not need to sign in again after reinstalling; if agy asks, sign in once as the screen tells you. The bridge's 0.1.2 "look again after 5 s" and the status page's re-check fail correctly in this situation: for SillyTavern's process the file really is not there.

**How to tell**: in a terminal you opened yourself, **outside** Claude (Start menu → PowerShell), run:

```powershell
dir $env:LOCALAPPDATA\agy\bin\agy.exe
dir $env:LOCALAPPDATA\Packages\Claude_*\LocalCache\Local\agy\bin\agy.exe
```

If the first line is a red "not found" and the second lists `agy.exe`, this is your problem. (In cmd: `dir %LOCALAPPDATA%\agy\bin`.) If the second line **prints nothing** (a path with `*` that matches nothing gives no error, just no output), agy is not in Claude's drawer and the cause is something else; go back to the table above. Since 0.1.3 the bridge itself looks into every app's drawer: when it finds agy there, the status page's warning says outright "agy is actually in app ○○'s private drawer (path)", and `agy.hiddenIn` shows the path, so you need not run these two lines yourself.

**Fix**: in a terminal you opened yourself (not the one inside Claude), run the step 1 install command again; agy then lands in the real `%LOCALAPPDATA%`; then restart SillyTavern from the desktop. If you still want an AI to install it for you, ask it to write the install command into a `.bat` file and open that with `explorer.exe <full path of the .bat>` — run through the desktop's (explorer's) identity, it is outside the app's drawer.

Other MSIX-packaged apps (most Microsoft Store installs) may be packaged the same way; the check is the same. Since 0.1.3, when agy is not found and a path that was tried lies under `AppData\Local`, the status page, the console and the red notice on sending add this hint (Windows' default location is under `AppData\Local` anyway, so players who simply have not installed agy see the "if…" sentence too; take it as a reminder); when agy is actually found in some app's drawer, the hint names the place instead. (Found and fixed by 朔牽星 in 亭仔腳 on 2026-10-21, thank you.)

## How it works, and is it safe

- Each message: the character card, the preset and the whole chat are written into a temporary agy "custom agent" file (agy's built-in coding prompt removed, **no tools at all**); only your latest line goes in through standard input; the file is deleted when the reply is done. Why this layout: agy silently cuts user messages at about 192,000 bytes from the end, while an agent file of 390,000 bytes arrived intact in our tests. When a single message you paste is too long, the bridge moves it into the agent file too. Details in [docs/DESIGN.md](docs/DESIGN.md).
- Every run carries `--sandbox` and never `--dangerously-skip-permissions`; if agy wants to use a tool, unattended mode denies it automatically and the bridge logs a warning to the console.
- When the bridge stops a run (a stall, a timeout, a newer request in the same chat), the processes agy started go with it: `taskkill /T` on Windows; on macOS / Linux agy runs in its own process group and the whole group gets SIGTERM (since 0.1.4).
- It listens on `127.0.0.1` only and rejects requests sneaked in by web pages in your browser (POST must be JSON, the Host header must be a local name); with `host` set to another address and no `apiKey`, the bridge refuses to start. It never touches your agy sign-in and never changes agy's settings.
- `@file-path` written in a character card is not expanded by agy into the file's content (in our tests the model only saw the path string), so a third-party card cannot read your files.
- **What stays on your machine**: after each reply the bridge deletes the conversation database, transcript, annotations and lock file agy created for that chat. agy also keeps two summary files shared by all conversations (`~/.gemini/antigravity-cli/conversation_summaries.db`, `jetbox_summaries_proto.pb`), and in our tests the line you sent does remain in them (not the card or the history). You use those two files with your other agy work as well, so the bridge leaves them alone; clear them in agy yourself if you mind.

## Risk (read first)

Mint AGY Bridge goes through Google's **official** agy CLI; it does not impersonate an editor and touches no private interface. But agy is a coding tool, and using it for chat and roleplay is not what it was designed for. Whether an account can be restricted for that we cannot promise — **assess and carry the risk yourself**.

## License

MIT, see [LICENSE](LICENSE).
