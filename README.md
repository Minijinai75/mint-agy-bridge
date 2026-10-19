# 薄荷橋 Mint AGY Bridge

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

## 用起來會怎樣

- **首字時間**：每一則都會開一次 agy。我們實測短對話用 `gemini-4-argon-low` 首字 6～23 秒，同一晚就會跳來跳去（橋自己每則只佔約 1 秒，其餘是 agy 與 Google 那頭）；`-high` 會先思考，再多 5～20 秒。聊天建議 low 或 medium。
- **長對話**：實測 15 萬位元組（約 4.5 萬 token）的歷史，開頭與結尾的細節都答得出來。
- **重新生成／編輯舊訊息**：照常用，每一則都是全新的一發。同一段對話裡新的一則進來，還在生的那則會被停掉（不排隊）；不同對話可以同時生（預設上限 2 則）。
- **「繼續」**：酒館的「繼續」會接著上一則沒寫完的地方寫。
- **手機斷線**：生到一半酒館斷了，橋會讓它生完先存著（預設 15 分鐘）；回來按「重新生成」直接拿到整段，不重扣額度。
- **⚠ 「停止」按鈕停不了 agy**：橋分不出你是按了停止、還是手機斷線，所以預設照樣生完（額度照扣），而且停止後馬上按「重新生成」，拿到的會是剛剛那則的完整版，要再按一次才換新的。在意的話把 `keepOnDisconnect` 設成 `false`：斷線就真的停，代價是手機斷線那則就沒了。
- **酒館的取樣參數不會生效**：溫度、Top P、最大長度這些 agy 沒有開放，橋收到也只能忽略。回覆長短請寫進預設或角色卡。
- **圖片**：v0.1 不帶圖，圖會換成一行「沒帶圖」的說明。

## 設定（選用）

把 `config.example.json` 複製成 `config.json`，只留你要改的欄位，重啟生效：

| 欄位 | 預設 | 說明 |
|---|---|---|
| `port` | `5499` | 接口的埠號 |
| `host` | `127.0.0.1` | 只給本機用。改成其他位址前請先設 `apiKey` |
| `apiKey` | 空 | 設了之後酒館的 API Key 欄要填同一串 |
| `agyPath` | 自動找 | 找不到 agy 時填完整路徑 |
| `adcAuth` | `false` | 用 ADC 登入時設 `true` |
| `defaultModel` | 空 | 請求沒指定模型時用哪顆；空＝清單第一顆 |
| `printTimeoutSec` | `300` | 一則最多等幾秒 |
| `maxRetries` | `0` | agy 遇到 429 等錯誤自己重試幾次。agy 原本會重試約 140 秒才放棄，橋預設 0：幾秒內就回錯誤，你自己決定要不要再按一次 |
| `stdinLimitBytes` | `180000` | 最新一則超過這麼大就挪進代理檔（上限 185000，再高會撞上 agy 的切尾） |
| `cleanupConversations` | `true` | 每則生完刪掉 agy 存在本機的這段對話 |
| `keepOnDisconnect` | `true` | 酒館斷線（或按停止）時照樣生完並存著；`false`＝當場停掉 |
| `resumeMinutes` | `15` | 斷線那則存多久 |
| `maxConcurrent` | `2` | 不同對話最多同時生幾則 |
| `usageLog` | `true` | 在 `usage/` 記 token 數（不記內容） |

狀態頁：`http://127.0.0.1:5499/status`（agy 版本、模型清單、警告）。設了 `apiKey` 之後狀態頁也要帶金鑰，用 `curl -H "Authorization: Bearer 你的金鑰" http://127.0.0.1:5499/status` 看；或看酒館主控台裡 `[mint-agy-bridge]` 開頭的幾行。

## 常見錯誤

還沒吐出任何字就失敗時，酒館會跳出錯誤通知（不會變成角色的一則回覆）；生到一半才失敗，錯誤會接在已經生出的字後面。括號裡附原始錯誤。

| 看到 | 原因與處理 |
|---|---|
| 找不到 agy 程式 | 第 1 步沒裝好，或裝在別處：在 `config.json` 填 `agyPath` |
| 模型不在你 agy 帳號的清單裡 | 你的登入方式看不到這顆。重新整理酒館的模型清單再選 |
| Google Cloud 專案的配額不夠（429） | 到 Google Cloud 主控台「配額」頁替那顆模型申請提高，或換模型 |
| 額度或速率到上限（429） | 等一兩分鐘再按重新生成，或換模型 |
| AI 點數不足 | 到 Antigravity 看用量 |
| 還沒登入／登入過期 | 終端機打 `agy` 重新登入；ADC 跑 `gcloud auth application-default login` |
| 連不上 Google（網路或代理） | 網路斷了或代理軟體沒開 |
| 依內容擋下了這一發 | 供應商的內容審核。改寫再送，或換模型 |
| 沒有權限用這顆模型（403） | Google Cloud 專案沒開 Vertex AI（`aiplatform.googleapis.com`）或模型沒啟用 |
| 超過 N 秒還沒生完 | 按重新生成；常發生就調大 `printTimeoutSec` |
| 被同一段對話的新請求取代了（409） | 你在它生完前又送了一句或按了重新生成，正常現象 |
| 同時在生的已經有 N 則（429） | 別的對話還在生，等它生完；或調大 `maxConcurrent` |
| API key 不對（401） | 酒館的 API Key 欄要跟 `config.json` 的 `apiKey` 一樣 |
| agy 找不到橋產生的角色代理檔 | agy 新版行為變了，請到 GitHub 開 issue |
| 埠 5499 被佔用 | 可能已經有一座在跑（例如酒館裡一座、又手動開了 standalone）。要兩座就在 `config.json` 改 `port`，酒館的網址跟著改 |

狀態頁出現「useG1Credits 是開的」：這是 agy 的全域設定，免費額度用完會自動扣付費 AI 點數。橋不會改它，要不要關由你決定。

## 它怎麼運作、安全嗎

- 每一則：把角色卡、預設和整段對話寫成一個暫時的 agy「自訂代理」檔（拿掉 agy 內建的寫程式提示、**不給任何工具**），只把你最新那句從標準輸入送進去，生完就刪檔。為什麼這樣排：agy 會把超過約 19.2 萬位元組的使用者訊息從尾端默默切掉，代理檔則實測 39 萬位元組完整。你貼的單則訊息太長時，橋也會把它挪進代理檔。細節看 [docs/DESIGN.md](docs/DESIGN.md)。
- 每一發都帶 `--sandbox`、不帶 `--dangerously-skip-permissions`；agy 若想動用工具，無人值守模式會自動拒絕，橋會在主控台記警告。
- 只聽 `127.0.0.1`，而且擋掉瀏覽器網頁偷送的請求（POST 只收 JSON、Host 必須是本機名稱）；`host` 改成別的位址時沒設 `apiKey` 橋不會啟動。不碰你的 agy 登入，也不改 agy 設定。
- 角色卡裡寫 `@檔案路徑` 不會被 agy 展開成檔案內容（實測模型只看到路徑字串），第三方角色卡讀不到你的檔案。
- **本機留下的東西**：每則生完，橋會刪掉 agy 為這段對話建的對話庫、逐字稿、註記和鎖檔。但 agy 有兩個所有對話共用的摘要檔（`~/.gemini/antigravity-cli/conversation_summaries.db`、`jetbox_summaries_proto.pb`），實測裡面會留下你送出的那句話（角色卡與歷史沒有）。這兩個檔你平常用 agy 也在用，橋不動它們；介意的話自己在 agy 裡清。

## 風險（請先讀）

薄荷橋走的是 Google **官方**的 agy CLI，不冒充編輯器、不碰非公開接口。但 agy 是寫程式用的工具，拿它來聊天、玩角色扮演，用法跟官方設想的不一樣。帳號會不會因此受限，我們無法保證，**風險請自行評估、自行承擔**。

## 授權

MIT，見 [LICENSE](LICENSE)。
