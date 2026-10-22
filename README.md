# 薄荷橋 Mint AGY Bridge

> English version: [README.en.md](README.en.md)

讓 SillyTavern（酒館）用你自己的 **Antigravity（反重力）** 帳號聊天：薄荷橋是一個酒館伺服器外掛，在本機開一個 OpenAI 相容的接口，背後呼叫 Google 官方的 Antigravity CLI（`agy`）。主力模型是 **Gemini 4 Argon**；實際能選哪些模型，看你的帳號與登入方式。

> English summary: a SillyTavern server plugin exposing an OpenAI-compatible endpoint (`/v1/chat/completions`, streaming and non-streaming) backed by the official Antigravity CLI. Zero dependencies, Node 18+. Models are whatever `agy models` lists for your account.

## 給誰用

- 有 Antigravity 帳號、已經能在終端機跑 `agy` 的酒館玩家。
- 想用 Gemini 4 Argon（或你帳號裡的其他模型）玩角色卡。

## 三步安裝

**1. 裝 Antigravity CLI**

```powershell
# Windows（PowerShell）
irm https://antigravity.google/cli/install.ps1 | iex
```
```bash
# macOS / Linux
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

這行要在**你自己開的終端機**跑（Windows：開始功能表 → PowerShell 或 Windows Terminal）。Windows 上叫 Claude 桌面版這類 App 裡的 AI 替你跑的話，agy 會被裝進那個 App 自己的抽屜、酒館看不到——為什麼、怎麼判、怎麼救，看下面的〔[MSIX 封裝 App 的檔案虛擬化](#msix-封裝-app-的檔案虛擬化叫-claude-桌面版幫你裝-agy-會撞到)〕（只有 Windows 會撞到）。

macOS／Linux：安裝腳本把 `agy` 放在 `~/.local/bin/agy`（照網路上的安裝教學；官方說明在 <https://antigravity.google/docs/install/>）。裝完**新開一個終端機**打 `agy --version`；說找不到指令就是 `~/.local/bin` 不在 PATH 裡，把 `export PATH="$HOME/.local/bin:$PATH"` 加進 `~/.bashrc` 或 `~/.zshrc`。酒館是從桌面捷徑、launchd 或 systemd 啟動的話，它看到的 PATH 常跟你終端機的不一樣，橋找不到 agy 時直接在 `config.json` 填 `agyPath`（下面有寫）最穩。

**2. 登入 agy**

在終端機打 `agy`，照畫面登入一次，然後打 `agy models` 看你有哪些模型。登入方式決定模型清單（官方說明：<https://antigravity.google/docs/install/>）：

| 登入方式 | 我們實測看到的模型（agy 1.4.2，26-10-19） |
|---|---|
| 個人 Google 帳號 | Gemini 3.8 Flash、Claude Sonnet／Opus 4.6、GPT-OSS 120B |
| Google Cloud 專案（商業帳號登入） | Gemini 4 Argon、Gemini 3.1 Pro、Gemini 3.6～3.8 Flash、Claude Opus／Sonnet 5.5 |
| Application Default Credentials（ADC） | 跟 Google Cloud 專案同一類；要在 `config.json` 設 `"adcAuth": true` |

**模型清單以你自己跑 `agy models` 的結果為準**，上表只是我們看到的樣子；Google 隨時會改。Claude 5.5 走 Google Cloud 專案時還要專案有配額，沒有會回 429。

**3. 裝外掛、接上酒館**

```bash
cd SillyTavern/plugins
git clone https://github.com/Minijinai75/mint-agy-bridge.git
```

1. 打開 `SillyTavern/config.yaml`，確認 `enableServerPlugins: true`。
2. 重啟酒館。主控台出現 `[mint-agy-bridge] 在 http://127.0.0.1:5499/v1 待命` 和模型清單就是好了。
3. 酒館「API 連線」→ **Chat Completion** → 來源選 **Custom (OpenAI-compatible)** → 網址填 `http://127.0.0.1:5499/v1` → 連線 → 下拉選模型。

不想裝進酒館也可以單獨跑：在 repo 資料夾 `node standalone.mjs`，接口一樣是 `http://127.0.0.1:5499/v1`。

## 升級三步

1. **拉新版**：在終端機進外掛資料夾拉一次。
   ```bash
   cd SillyTavern/plugins/mint-agy-bridge
   git pull
   ```
2. **看一眼更新紀錄**：打開 [CHANGELOG.md](CHANGELOG.md)，看新版那段有沒有「升級前先看」。你的 `config.json` 不會被 `git pull` 動到——但也因為這樣，你以前抄進去的舊數字會蓋過新版的預設值（例如 0.1.0 範例裡的 `printTimeoutSec: 300`）。沒有特別要改的欄位，刪掉那一行就會用新預設。
3. **重啟酒館**：外掛只在酒館啟動時載入，不重啟不會換新版。重啟後打開狀態頁 `http://127.0.0.1:5499/status`，`"version"` 是新版號就好了。

## 用起來會怎樣

- **首字時間**：每一則都會開一次 agy。我們實測短對話用 `gemini-4-argon-low` 首字 6～23 秒，同一晚就會跳來跳去（橋自己每則只佔約 1 秒，其餘是 agy 與 Google 那頭）；`-high` 會先思考，再多 5～20 秒。聊天建議 low 或 medium。
- **長對話**：實測 15 萬位元組（約 4.5 萬 token）的歷史，開頭與結尾的細節都答得出來。
- **重新生成／編輯舊訊息**：照常用，每一則都是全新的一發。同一段對話裡新的一則進來，還在生的那則會被停掉（不排隊）；不同對話可以同時生（預設上限 2 則）。
- **「繼續」**：酒館的「繼續」會接著上一則沒寫完的地方寫。
- **手機斷線**：生到一半酒館斷了，橋會讓它生完先存著（預設 15 分鐘）；回來按「重新生成」直接拿到整段，不重扣額度。
- **⚠ 「停止」按鈕停不了 agy**：橋分不出你是按了停止、還是手機斷線，所以預設照樣生完（額度照扣），而且停止後馬上按「重新生成」，拿到的會是剛剛那則的完整版，要再按一次才換新的。在意的話把 `keepOnDisconnect` 設成 `false`：斷線就真的停，代價是手機斷線那則就沒了。
- **最大回覆長度（Max Response Length）會生效**（0.1.1 起）：agy 本身沒有輸出上限可設，橋邊收邊估字數，估到你設的 token 數就停下、正常收尾。是估算（中文約 1.15 字一個 token、英文約 4.4 個字母一個 token），會差一點。**思考不算在內**（0.1.2 起）：模型自己的思考 agy 不會送出來，本來就不算；你的預設要模型把思考寫在回覆裡、用 `<think>`／`<thinking>`／`<reasoning>` 包起來的（酒館會把它收進「思考」框），那一段也不算，上限只管正文。思考標籤用別的名字的，橋認不出來，還是會算進去。**酒館預設是 300 token（約 350 個中文字）**，回覆被切太短就把酒館的「最大回覆長度」調大（例如 4000～8000）；不想讓橋管就在 `config.json` 設 `"honorMaxTokens": false`。
- **回覆生完但 agy 沒結束**（0.1.2 修）：有玩家的 agy 看起來是送完整段回覆後程式不退出，0.1.1 會一路等到逾時、最後報錯。現在 agy 一說「這一輪完成了」，橋就把回覆交給酒館，不等程式退出；agy 有 10 秒自己退，不退就停掉它，這一則照常算成功（狀態頁標 `lingered: true`）。agy 只說「這段回覆完成」、沒說「這一輪完成」的話，橋會等那 10 秒（後面可能還有第二段）才交，所以偶爾會多轉 10 秒左右的圈，狀態頁的 `sawResult: false` 就是這種。
- **卡住會自動重送一次**（0.1.2 起）：已經開始出字之後連續 120 秒（`stallSec`）沒有新的字，或連第一個字都等了 180 秒（`stallFirstSec`，模型可能在先想，所以放寬），橋就停掉這一發、**自動重送一次——重送會再算一發額度**。串流已經出現的半截字收不回來，所以會先出現一行「〔前一發卡住，重來〕」再接新的回覆——那半截請自己刪掉或按重新生成；前一發已經寫完思考段的話，重送那發的思考段不會再出現在正文裡。重送那發又卡住就不再送，跳紅色通知「模型那頭 N 秒沒出字」。不想自動重送就設 `"stallRetry": false`。把 `maxRetries` 調大的人注意：agy 自己遇到 429 重試時不會出字，等太久會被當成卡住，`stallFirstSec` 要跟著調大。
- **其他取樣參數不會生效**：溫度、Top P 這些 agy 沒有開放，橋收到也只能忽略。
- **速度看 Google 那頭**：出字速度不固定，同一顆模型不同晚上差很多——我們量過 `argon-medium` 配 4 萬 token 歷史每秒約 13 個 token（4,400 token 的回覆要 5 分半），也量過 `argon-low` 短對話每秒 36～52 個；首字有時 6 秒、有時 140 秒。橋預設最多等 900 秒；`argon-high` 配長歷史、又要長回覆的，把 `printTimeoutSec` 再調大。狀態頁的 `tokPerSec` 是那一則從第一個字到最後一個字的速度。
- **圖片**：v0.1 不帶圖，圖會換成一行「沒帶圖」的說明。

## 設定（選用）

把 `config.example.json` 複製成 `config.json`，只留你要改的欄位，重啟生效：

| 欄位 | 預設 | 說明 |
|---|---|---|
| `port` | `5499` | 接口的埠號 |
| `host` | `127.0.0.1` | 只給本機用。改成其他位址前請先設 `apiKey` |
| `apiKey` | 空 | 設了之後酒館的 API Key 欄要填同一串 |
| `agyPath` | 自動找 | 狀態頁說找不到 agy 時填完整路徑。Windows 預設裝在這裡，可以直接照抄：`"agyPath": "%LOCALAPPDATA%\\agy\\bin\\agy.exe"`（JSON 裡反斜線要寫兩個；`%LOCALAPPDATA%` 這種寫法 0.1.2 起橋會自己展開）。macOS／Linux 在終端機打 `which agy`，把印出來的路徑照抄，例如 `"agyPath": "~/.local/bin/agy"`（開頭的 `~` 0.1.4 起橋會自己展開成家目錄） |
| `adcAuth` | `false` | 用 ADC 登入時設 `true` |
| `defaultModel` | 空 | 請求沒指定模型時用哪顆；空＝清單第一顆 |
| `printTimeoutSec` | `900` | 一則最多等幾秒（0.1.0 是 300，慢模型配長對話不夠用）。`argon-high` 配長歷史可以再調大 |
| `stallSec` | `120` | 開始出字後連續幾秒沒新字就算卡住；`0`＝不檢查 |
| `stallFirstSec` | `180` | 連第一個字都等幾秒就算卡住；`0`＝不檢查（只看 `printTimeoutSec`） |
| `stallRetry` | `true` | 卡住時自動重送一次（會再算一發額度）；`false`＝直接報錯 |
| `honorMaxTokens` | `true` | 照酒館的「最大回覆長度」停下回覆（估算，思考段不算）；`false`＝不管長度，生到模型自己停 |
| `maxRetries` | `0` | agy 遇到 429 等錯誤自己重試幾次。agy 原本會重試約 140 秒才放棄，橋預設 0：幾秒內就回錯誤，你自己決定要不要再按一次 |
| `stdinLimitBytes` | `180000` | 最新一則超過這麼大就挪進代理檔（上限 185000，再高會撞上 agy 的切尾） |
| `cleanupConversations` | `true` | 每則生完刪掉 agy 存在本機的這段對話 |
| `keepOnDisconnect` | `true` | 酒館斷線（或按停止）時照樣生完並存著；`false`＝當場停掉 |
| `resumeMinutes` | `15` | 斷線那則存多久 |
| `maxConcurrent` | `2` | 不同對話最多同時生幾則 |
| `usageLog` | `true` | 在 `usage/` 記 token 數（不記內容） |

狀態頁：`http://127.0.0.1:5499/status`（agy 版本、模型清單、警告；`agy.path` 是橋實際找到、實際在跑的那一支）。設了 `apiKey` 之後狀態頁也要帶金鑰，用 `curl -H "Authorization: Bearer 你的金鑰" http://127.0.0.1:5499/status` 看；或看酒館主控台裡 `[mint-agy-bridge]` 開頭的幾行。

### 橋怎麼找 agy（三個平台一樣的順序，位置不同）

1. `config.json` 的 `agyPath`（有填就只用它，不再找別處；`%VAR%` 與開頭的 `~` 會展開）。
2. PATH：酒館那個程序看到的 PATH 裡，第一個有 `agy`（Windows 是 `agy.exe`）的資料夾。
3. 各平台安裝程式的預設位置，依序：
   - Windows：`%LOCALAPPDATA%\agy\bin\agy.exe`
   - Linux：`~/.local/bin/agy`、`/usr/local/bin/agy`、`~/.antigravity/bin/agy`
   - macOS：`~/.local/bin/agy`、`/opt/homebrew/bin/agy`、`/usr/local/bin/agy`、`~/.antigravity/bin/agy`
4. 都沒有就直接叫 `agy`（Windows 叫 `agy.exe`），讓作業系統再找一次 PATH；還是沒有，狀態頁和主控台會列出每個讀不到的預設位置與原因代碼。

Windows 上找不到時，橋還會翻 MSIX 封裝 App 的抽屜（下面那段）；macOS／Linux 沒這回事，跳過不提。

## 常見錯誤

失敗時酒館會跳出紅色的錯誤通知，錯誤不會寫進角色的回覆裡（串流、非串流都一樣）：還沒吐出任何字就失敗，這一則不會存成回覆；生到一半才失敗，已經生出的字留著、另外跳通知。通知的括號裡附原始錯誤。

**回報問題時請附上狀態頁的內容**：瀏覽器打開 `http://127.0.0.1:5499/status`，整頁複製貼上。裡面有版本、最後一則用的模型、花了幾秒、生了多少 token、每秒幾個 token（`tokPerSec`）、是逾時、卡住還是被過濾，沒有對話內容。光說「也是這樣」我們查不到是哪一種。出事後別急著重啟酒館，先抄狀態頁：重啟會把「最後一則」清掉。卡住、逾時、agy 不退出的那幾發，橋會把 agy 自己的紀錄留在外掛資料夾的 `logs/`（只留最近 5 份；信箱、Google Cloud 專案編號、權杖和你自己設的 agy 權限規則已經遮掉，你的使用者資料夾寫成 `~`。紀錄裡沒有角色卡和對話內容）；狀態頁的 `agyLog` 寫是哪一份，我們要的話會請你貼最後幾十行。

| 看到 | 原因與處理 |
|---|---|
| 找不到 agy 程式／狀態頁說找不到 agy | 先在 `config.json` 填 `agyPath`（Windows 是 agy.exe 的完整路徑；macOS／Linux 在終端機打 `which agy` 照抄，通常是 `~/.local/bin/agy`）再重啟酒館，這招最快。macOS／Linux 常見原因是酒館從桌面或服務啟動、看到的 PATH 沒有 `~/.local/bin`，填 `agyPath` 就繞過去了。agy 明明裝好卻偶爾在酒館剛啟動時找不到（有玩家撞過兩次）：0.1.2 起橋會隔 5 秒再找、最多三次，打開狀態頁也會重找一次；主控台會印出那一刻讀不到的原因代碼（`ENOENT`、`EBUSY`、`EPERM`…），回報時附上。**Windows、agy 是叫 Claude 桌面版幫你裝的、`agyPath` 填了完整路徑還是 `ENOENT`**：看下面的〔MSIX 封裝 App 的檔案虛擬化〕，0.1.3 起狀態頁會多提示這一句。真的沒裝才回第 1 步 |
| 模型那頭 N 秒沒出字 | 回覆停住不動（生到一半，或一個字都還沒出），不是逾時，也不是橋壞了。通知裡寫「已經自動重送過一次」的，表示重送那發也卡住了；等一兩分鐘再按重新生成，一直這樣就換模型 |
| 模型不在你 agy 帳號的清單裡 | 你的登入方式看不到這顆。重新整理酒館的模型清單再選 |
| Google Cloud 專案的配額不夠（429） | 到 Google Cloud 主控台「配額」頁替那顆模型申請提高，或換模型 |
| 額度或速率到上限（429） | 等一兩分鐘再按重新生成，或換模型 |
| AI 點數不足 | 到 Antigravity 看用量 |
| 還沒登入／登入過期 | 終端機打 `agy` 重新登入；ADC 跑 `gcloud auth application-default login` |
| 連不上 Google（網路或代理） | 網路斷了或代理軟體沒開 |
| 被 Google 的內容過濾擋下了 | Google 判定這一發的輸出違反使用政策（原始錯誤裡有 `content safety filters`）。agy 被擋後會自己重試三次、每次都白等，所以橋一看到就停掉，不會再拖到逾時。**最常被擋的是 Horae 劇情摘要那一發**（它要模型把整段劇情重述一遍）。改寫最新那句、換個說法重抽，或換模型 |
| 依內容擋下了這一發 | 供應商的其他內容審核。改寫再送，或換模型 |
| 沒有權限用這顆模型（403） | Google Cloud 專案沒開 Vertex AI（`aiplatform.googleapis.com`）或模型沒啟用 |
| 橋在 N 秒時停掉了 agy | 時間到了回覆還沒生完，是橋停的，不是 agy 壞了。按重新生成；常發生就調大 `printTimeoutSec`（慢模型、長歷史、長回覆三者疊在一起最容易撞到） |
| agy 自己中途結束了（代碼 N） | agy 沒說原因就結束了：多半是額度到上限、內容被擋或模型那頭出狀況。等一兩分鐘再按重新生成，一直這樣就換模型；回報時附狀態頁內容 |
| 被同一段對話的新請求取代了（409） | 你在它生完前又送了一句或按了重新生成，正常現象 |
| 同時在生的已經有 N 則（429） | 別的對話還在生，等它生完；或調大 `maxConcurrent` |
| API key 不對（401） | 酒館的 API Key 欄要跟 `config.json` 的 `apiKey` 一樣 |
| agy 找不到橋產生的角色代理檔 | agy 新版行為變了，請到 GitHub 開 issue |
| 埠 5499 被佔用 | 可能已經有一座在跑（例如酒館裡一座、又手動開了 standalone）。要兩座就在 `config.json` 改 `port`，酒館的網址跟著改 |

狀態頁出現「useG1Credits 是開的」：這是 agy 的全域設定，免費額度用完會自動扣付費 AI 點數。橋不會改它，要不要關由你決定。

### MSIX 封裝 App 的檔案虛擬化（叫 Claude 桌面版幫你裝 agy 會撞到）

只有 Windows 會撞到這個：MSIX 與檔案虛擬化是 Windows 的機制，macOS／Linux 沒有這回事，橋在那兩個平台也不會提示這一句、不會去翻抽屜。

**症狀**：agy 明明「裝好了」、在 Claude 桌面版裡面叫得動，但從桌面點開的酒館一直說找不到 agy；`config.json` 的 `agyPath` 填了完整路徑也一樣 `ENOENT`。從 Claude 裡面開的酒館卻正常。

**原因**：Claude 桌面版（Windows）是 **MSIX 封裝**的 App——微軟商店那種包法，但不是只有商店裝的才算，官網下載的 Claude 安裝檔也是這種包法。這類 App、以及它開出來的所有子程序（包括你在裡面叫 AI 開的 PowerShell），在 `%LOCALAPPDATA%` 底下新建的檔案會被 Windows 悄悄轉存到 `%LOCALAPPDATA%\Packages\Claude_<一串代碼>\LocalCache\Local\` 底下——這叫「檔案虛擬化」。對那個 App 來說路徑看起來沒變、檔案都在；對別的程式來說，同一個路徑是空的。所以在 Claude 裡跑 `install.ps1` 裝的 agy，其實住進了 Claude 的私人抽屜，只有 Claude 跟它開出來的程式看得到；就算 PATH 裡有 agy 那一筆，它指向的資料夾從桌面看也是空的。agy 的設定與登入放在 `~/.gemini`，不在虛擬化的範圍，朔牽星重裝後沒有重新登入；真要你登入就照畫面登入一次。橋 0.1.2 的「隔 5 秒再找」和狀態頁重查在這個情境下都會正確地失敗：對酒館那個程序來說，檔案真的不存在。

**判法**：在 Claude **外面**、自己開的終端機（開始功能表 → PowerShell）跑：

```powershell
dir $env:LOCALAPPDATA\agy\bin\agy.exe
dir $env:LOCALAPPDATA\Packages\Claude_*\LocalCache\Local\agy\bin\agy.exe
```

第一行紅字說找不到、第二行卻列出了 `agy.exe`，就是這個問題。（cmd 的寫法：`dir %LOCALAPPDATA%\agy\bin`。）第二行**什麼都沒印**（路徑帶 `*` 時對不到不會紅字，只是沒輸出）＝agy 不在 Claude 的抽屜裡，是別的原因，回上面那張表。0.1.3 起橋自己也會去各個 App 的抽屜找：找到了，狀態頁的警告會直接寫「agy 其實在 ○○ 這個 App 的私人抽屜裡（路徑）」，`agy.hiddenIn` 也會列出來，不用自己跑這兩行。

**修法**：在自己開的終端機（不是 Claude 裡面那個）重跑一次第 1 步的安裝指令，agy 就會裝進真的 `%LOCALAPPDATA%`；然後從桌面重開酒館。還是想叫 AI 替你裝的話，請它把安裝指令寫成一個 `.bat`，再用 `explorer.exe <那個 .bat 的完整路徑>` 開——借桌面（explorer）的身分跑，就不在 App 的抽屜裡了。

其他 MSIX 封裝的 App（微軟商店裝的多半是）也可能有同樣的包法，判法一樣。0.1.3 起，找不到 agy 而且找過的路徑在 `AppData\Local` 底下時，狀態頁、主控台和送訊息時的紅色通知會多提示這一句（Windows 的預設位置本來就在 `AppData\Local` 底下，所以沒裝 agy 的人也會看到這句「若是…」，當成提醒就好）；在某個 App 的抽屜裡真的找到 agy 時，提示會改成直接寫出它在哪。（26-10-21 朔牽星在亭仔腳破案並實測修法，謝謝。）

## 它怎麼運作、安全嗎

- 每一則：把角色卡、預設和整段對話寫成一個暫時的 agy「自訂代理」檔（拿掉 agy 內建的寫程式提示、**不給任何工具**），只把你最新那句從標準輸入送進去，生完就刪檔。為什麼這樣排：agy 會把超過約 19.2 萬位元組的使用者訊息從尾端默默切掉，代理檔則實測 39 萬位元組完整。你貼的單則訊息太長時，橋也會把它挪進代理檔。細節看 [docs/DESIGN.md](docs/DESIGN.md)。
- 每一發都帶 `--sandbox`、不帶 `--dangerously-skip-permissions`；agy 若想動用工具，無人值守模式會自動拒絕，橋會在主控台記警告。
- 橋停掉一發 agy 時（卡住、逾時、被新請求取代），連它開出來的子程序一起停：Windows 用 `taskkill /T`，macOS／Linux 把 agy 放在自己的 process group 裡整組送 SIGTERM（0.1.4 起）。
- 只聽 `127.0.0.1`，而且擋掉瀏覽器網頁偷送的請求（POST 只收 JSON、Host 必須是本機名稱）；`host` 改成別的位址時沒設 `apiKey` 橋不會啟動。不碰你的 agy 登入，也不改 agy 設定。
- 角色卡裡寫 `@檔案路徑` 不會被 agy 展開成檔案內容（實測模型只看到路徑字串），第三方角色卡讀不到你的檔案。
- **本機留下的東西**：每則生完，橋會刪掉 agy 為這段對話建的對話庫、逐字稿、註記和鎖檔。但 agy 有兩個所有對話共用的摘要檔（`~/.gemini/antigravity-cli/conversation_summaries.db`、`jetbox_summaries_proto.pb`），實測裡面會留下你送出的那句話（角色卡與歷史沒有）。這兩個檔你平常用 agy 也在用，橋不動它們；介意的話自己在 agy 裡清。

## 風險（請先讀）

薄荷橋走的是 Google **官方**的 agy CLI，不冒充編輯器、不碰非公開接口。但 agy 是寫程式用的工具，拿它來聊天、玩角色扮演，用法跟官方設想的不一樣。帳號會不會因此受限，我們無法保證，**風險請自行評估、自行承擔**。

## 授權

MIT，見 [LICENSE](LICENSE)。
