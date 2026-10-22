# 更新紀錄

## 0.1.4（2026-10-22）

一件事：橋在 Linux 與 macOS 真的能用了。作者在 Windows 上開發、測試，這版第一次在 Linux 跑整套測試、在三個平台跑 CI。升級照 README 的「升級三步」：`git pull`、看這段、重啟酒館。沒有要改的設定，`config.json` 的鍵名、預設埠、API 行為都沒動。

- **Linux 上原本紅的格**：整套測試在 Linux 跑，1 格紅、2 格被跳過。紅的那格是狀態頁把使用者資料夾遮成 `~` 的測試——它把假路徑放在系統暫存夾底下，Windows 的暫存夾在 `AppData\Local\Temp`、在家目錄裡，macOS／Linux 的 `/tmp`、`/var/folders` 不在，遮不到；而且那格把路徑轉成大寫，在大小寫有別的檔案系統上是另一個路徑。追下去發現遮罩本身在 macOS／Linux 也有錯：`/home/name/x` 會遮成 `/~/x`（開頭的斜線沒算進去），`/root` 這種短家目錄還會把句子裡的 `root` 字樣一起遮掉；現在開頭的斜線算進去、資料夾名字要整個對上才遮。被跳過的兩格是 Windows 限定的 MSIX 抽屜測試，現在改成把平台注進去，三個平台都跑得到 Windows 那條路。
- **找 agy 的順序分平台**：`agyPath` → PATH（酒館那個程序看到的 PATH 裡第一個有 agy 的資料夾，狀態頁的 `agy.path` 直接顯示完整路徑）→ 各平台安裝程式的預設位置（Windows `%LOCALAPPDATA%\agy\bin\agy.exe`；Linux `~/.local/bin/agy`、`/usr/local/bin/agy`、`~/.antigravity/bin/agy`；macOS 多 Homebrew 的 `/opt/homebrew/bin/agy`、`/usr/local/bin/agy`）→ 裸名 `agy`／`agy.exe`。`agyPath` 開頭的 `~` 會展開成家目錄。MSIX 抽屜那段（0.1.3）只在 Windows 跑，macOS／Linux 直接跳過、不提示；狀態頁與紅色通知的「填 agyPath」那句分平台：Windows 寫 `%LOCALAPPDATA%\agy\bin\agy.exe`，macOS／Linux 寫 `which agy` 與 `~/.local/bin/agy`（macOS 加 Homebrew 的位置）。主控台「預設位置讀不到」那行在 macOS／Linux 印 `HOME` 而不是 `LOCALAPPDATA`。**Windows 注意**：0.1.3 是先看 `%LOCALAPPDATA%\agy\bin\agy.exe`、沒有才交給 PATH；這版先掃 PATH、再看預設位置。照 install.ps1 裝的，PATH 那筆指的就是同一支 agy.exe，行為不變；自己另外放了一支 agy.exe 在 PATH 裡的人，這版會用 PATH 那支（狀態頁 `agy.path` 看得到用的是哪支）。
- **找到的位置記住、不每則重掃**（維護者審查後補）：PATH 只在啟動、狀態頁重查、以及叫 agy 回 `ENOENT` 時重掃，`agy --version`、`agy models` 和每一則聊天都用記住的那支。原因：PATH 裡若有連不到的網路位置（斷線的 NAS 映射、公司 VPN 的 UNC），每次 `stat` 要等 SMB 逾時（實測 21 秒）、而且是同步呼叫，整個酒館會停住；0.1.3 從不碰 PATH，所以每則重掃會是純回歸。失效條件照 26-10-20 那案設計：酒館啟動 15 秒內讀不到預設位置、一分鐘後才讀得到——每次重查（啟動的三次重試、狀態頁）都重新找，叫 agy 回 `ENOENT` 也立刻丟掉記住的位置、下一則重新找。測試：假 PATH 塞一個只計數 `stat` 次數的資料夾，連叫三次 `resolveAgyPath` 只 `stat` 一輪；叫 agy 回 `ENOENT` 之後下一次重新解析（單元測試用 `agy --version`：記住的那支刪掉、叫它回 `ENOENT`、放回去後下一次又找到，三平台都跑；macOS／Linux 另有一格用 shell 包裝走 PATH、搬資料夾；橋的測試用整則聊天：agy 搬到 PATH 後面的資料夾，第一發 `ENOENT`、第二發就找到，macOS／Linux）。啟動時 init 先找一次、第一次 checkAgy 沿用那個答案，重試與狀態頁重查才重新找，PATH 慢的資料夾不會在啟動時連付兩次。
- **停掉 agy 時連子程序一起停**（macOS／Linux）：Windows 本來就用 `taskkill /T` 整棵砍；macOS／Linux 以前只送 SIGTERM 給 agy 本身，它開的子程序會留下來。現在 agy 跑在自己的 process group 裡，整組一起停。新增測試：卡住被停的那發，它開的子程序也要消失（三個平台都跑）。
- **GitHub Actions**：`.github/workflows/test.yml` 在 ubuntu、windows、macos 各跑一次 `npm test`（Node 22）。
- **README 英文版**：`README.en.md`，內容對齊中文版；中文版頂端連過去。中文版補 macOS／Linux 的安裝備註（`~/.local/bin` 不在 PATH 時怎麼辦、從桌面啟動的酒館 PATH 不同）、`agyPath` 的寫法、「橋怎麼找 agy」一段、錯誤表那格。
- 真裝 agy：這版的開發環境連不到 `antigravity.google`（網路政策擋掉），裝不起來；npm 上名叫 `antigravity-cli` 的是佔位套件，不是官方的。找 agy 的邏輯用測試自帶的假執行檔驗（macOS／Linux 用一支包著假 agy 的 shell 腳本放進 PATH，狀態頁要顯示它的路徑、版本 1.4.2、聊天要走得通；Windows 用一個名叫 `agy.exe` 的假檔驗 PATH 掃描與預設位置）。驗過的 agy 版本清單沒動。Unix PATH 端到端那格（PATH 裡放一支包著假 agy 的 shell 腳本、狀態頁要顯示它的路徑、聊天要走得通、搬走後下一則重新找）在 Windows 跳過：`.cmd` 包裝沒有 shell 跑不起來。
- 其他維護者審查後補的小項：`.github/workflows/test.yml` 加 `permissions: contents: read`；PATH 裡的相對路徑項（`.`、`bin`）找到時改回絕對路徑，不留到 spawn 時才對 cwd（cwd 也算進快取鍵）；預設位置那支沒有執行位（macOS／Linux）時跳過、記 `EACCES`，不會記住一支每次 spawn 都失敗的檔；英文 README 說明橋自己的訊息都是中文（紅色通知、主控台、狀態頁 warnings 沒有語言開關），常見錯誤表每格附中文原句，MSIX 段標題附中文原標題「MSIX 封裝 App 的檔案虛擬化」（紅色通知指的是那個標題）。

## 0.1.3（2026-10-22）

一件事：叫 Claude 桌面版幫你裝的 agy，酒館看不到。升級照 README 的「升級三步」：`git pull`、看這段、重啟酒館。沒有要改的設定。

- **找不到 agy 時多一句提示**：找不到 agy（`ENOENT`）、而且找過的路徑在 `AppData\Local` 底下時，狀態頁的 `warnings`（排在「填 agyPath」那句後面）、酒館啟動時的主控台，以及送訊息時跳的紅色通知（通知用短版），都多一句「若是叫 Claude 桌面版這類 MSIX 封裝的 App 幫你裝的 agy，請在自己的終端機重裝一次」。原因：Claude 桌面版（Windows）是 MSIX 封裝的 App（官網下載的也是，不只商店版），它跟它開出來的每個程序寫進 `%LOCALAPPDATA%` 的檔案，會被 Windows 轉到 `AppData\Local\Packages\Claude_<id>\LocalCache\Local\` 底下，只有它們自己看得到——在 Claude 裡跑 `install.ps1` 裝的 agy 就住在那裡，從桌面點開的酒館當然找不到，`agyPath` 填完整路徑也一樣。Windows 的預設位置本來就在 `AppData\Local` 底下，所以 Windows 上只要找不到 agy 幾乎都會看到這句「若是…」（沒裝的人也會，當提醒就好）；`agyPath` 指到別處（例如 D 槽）的 `ENOENT`、別的錯誤碼（`EBUSY`、`EPERM`）、macOS／Linux 不會多這句。
- **橋會自己去 App 的抽屜找**：那個抽屜（`%LOCALAPPDATA%\Packages\<App>\LocalCache\Local\agy\bin\agy.exe`）從外面讀得到。找不到 agy 時橋會翻一遍，真的找到就不再說「若是」，改成直接寫「agy 其實在 ○○ 這個 App 的私人抽屜裡（完整路徑）」，狀態頁的 `agy.hiddenIn` 也列出那個路徑。
- 找不到 agy 時，狀態頁不再把「模型清單拿不到」那句也列進去（它跟上面兩句講的是同一件事，以前會重複）。
- README 補「MSIX 封裝 App 的檔案虛擬化」一段：白話原因、判法（在 Claude 外面自己開的終端機看 `%LOCALAPPDATA%\agy\bin` 有沒有 agy.exe）、修法（自己的終端機重跑 `install.ps1`；要讓 AI 裝就叫它用 `explorer.exe` 借桌面身分跑）。安裝第 1 步加一句「在你自己開的終端機跑」。
- agy 1.4.4、1.4.5 列進驗過的版本（這版的真機測試先跑在 1.4.4、收尾時這台已自動更新到 1.4.5 再各補一輪：flash-low 非串流與串流各一發正常）。
- 出處：朔牽星 26-10-21 在亭仔腳破案——同一支程式從 Claude 的殼跑 `stat` 成功、用 `explorer.exe` 借桌面身分跑就 `ENOENT`；用 `explorer.exe` 重跑 `install.ps1` 後，從桌面開的酒館就看得到 agy 了。0.1.2 的「隔 5 秒再找」和狀態頁重查對這個情境都正確地失敗了：對那個程序來說檔案真的不存在。

## 0.1.2（2026-10-20）

修玩家第二天回報的三件事。升級照 README 的「升級三步」：`git pull`、看這段、重啟酒館。

**升級前先看**：沒有要改的設定。新欄位 `stallSec`、`stallFirstSec`、`stallRetry` 不用加進 `config.json`，用預設就好。卡住自動重送會多算一發額度，不要的話設 `"stallRetry": false`。

- **回覆生完卻一直轉圈、最後報逾時**：狀態頁是 `timedOut: true`、`usage` 裡卻有完整的 token 數的那種。agy 只在回覆整段完成時才附 token 數，所以我們推論那幾發其實生完了、是 agy 程式沒退出（家裡重現不了，等升級後的狀態頁證實）。現在 agy 一說「這一輪完成了」，橋就把回覆交給酒館、不等程式退出；agy 有 10 秒自己退，不退就停掉它，這一則照常算成功，狀態頁標 `lingered: true` 和 `postDoneHangSec`。
- **卡住會自動重來一次**：開始出字之後連續 120 秒（`stallSec`）沒新字，或第一個字等了 180 秒（`stallFirstSec`），橋就停掉這一發、自動重送一次（會再算一發額度）。串流已經送出的半截收不回來，中間會插一行「〔前一發卡住，重來〕」再接新的回覆；前一發已經寫完思考段的話，重送那發的思考段不會再露在正文裡。重送那發又卡住就不再送，紅色通知寫「模型那頭 N 秒沒出字」。`stallSec: 0`／`stallFirstSec: 0` 關掉檢查、`stallRetry: false` 關掉重送。
- **「最大回覆長度」不再把思考算進去**：模型寫在回覆裡、用 `<think>`／`<thinking>`／`<reasoning>` 包起來的思考段不算進上限，上限只管正文（0.1.1 把它算進去，上限設 2000 時思考還沒寫完就被切）。思考段沒關上、或開關標籤名字不一樣時，思考超過約 4,000 token（或上限的三倍）就照常算，上限不會整個失效。agy 模型自己的內部思考本來就不會送出來，不受影響。
- **酒館剛啟動時偶爾找不到 agy**：找不到時隔 5 秒再找、最多三次；打開狀態頁時如果還缺 agy 或模型清單，會先重找一次再顯示，過期的警告跟著消失。預設位置讀不到時，主控台會印出原因代碼（`ENOENT`、`EBUSY`、`EPERM`…）、當下的 `LOCALAPPDATA` 和工作資料夾，下次撞到就分得出原因。警告文字改成先叫你填 `agyPath`，不再先叫人重裝；`agyPath` 裡的 `%LOCALAPPDATA%` 這類寫法會自己展開。
- **出事那發的 agy 紀錄留下來**：卡住、逾時、agy 不退出或失敗的那發，橋把 agy 自己的紀錄複製到外掛資料夾的 `logs/`（只留最近 5 份），信箱、Google Cloud 專案編號、權杖、你自己設的 agy 權限規則先遮掉，使用者資料夾寫成 `~`（後面的路徑留著，「哪個檔被鎖住」這種原因才看得到）。紀錄裡沒有角色卡和對話內容。狀態頁的 `agyLog` 寫是哪一份。
- 狀態頁與 `usage/` 紀錄多記：`stalled`（卡住被停）、`stalledBeforeText`、`tokPerSec`（第一個字到最後一個字的速度，估算；不到一秒不算）、`retriedAfterStall`（重送那發）、`lingered`、`sawResult`（agy 有沒有說「這一輪完成」）、`postDoneHangSec`（回覆完成到 agy 被收掉的秒數）、`doneAtMs`、`textAfterDone`；agy 叫不動時 `agy.error` 寫原因。狀態頁上你的使用者資料夾改顯示成 `~`（玩家常整頁貼出來）。找不到 agy 時不再多跳一條「agy null 不在驗過的版本」。缺 agy 或模型清單時，狀態頁最多等 3 秒重查，不會卡住。
- README 加「升級三步」，「回報附狀態頁」那段寫得更清楚。
- agy 1.4.3 列進驗過的版本（這版的真機測試都跑在 1.4.3 上），狀態頁不再對它跳「不在驗過的版本」。

## 0.1.1（2026-10-20）

修玩家第一天回報的四件事。

**升級前先看**：
- 酒館的「最大回覆長度」從這版起會生效。酒館預設是 300 token（約 350 個中文字），沒調過的話升級後回覆會變短——到 AI 回應設定把它調大（例如 4000～8000），或在 `config.json` 設 `"honorMaxTokens": false`。上限 400 以下時主控台會提醒一次。
- 如果你的 `config.json` 是整份照 0.1.0 範例複製的，裡面的 `printTimeoutSec` 還是 300，要自己改成 900（或刪掉那一行用預設）。

- **錯誤不再跑進「思考」區**：生到一半出錯時，錯誤改用獨立的錯誤事件送出，酒館跳紅色通知；已經生出的字留著，錯誤不會寫進回覆。
- **內容過濾不再被報成逾時**：Google 擋下輸出後 agy 會自己重試、一路等到逾時。現在橋一看到「content safety filters」就停掉 agy，錯誤寫「被 Google 的內容過濾擋下了」。最常被擋的是 Horae 劇情摘要那一發。
- **酒館的「最大回覆長度」會生效**：agy 沒有輸出上限可設，橋邊收邊估 token 數，到了就停、以 `finish_reason: length` 收尾。不想要就設 `"honorMaxTokens": false`。
- **逾時預設 300 → 900 秒**，逾時訊息改成「橋在 N 秒時停掉了 agy」，不再附上被橋砍掉後的結束代碼（看起來像 agy 壞了）；agy 自己無故結束時另有一句說明。
- **非串流請求的錯誤看得到了**：酒館後端遇到非串流的 HTTP 錯誤只會顯示「Bad Gateway」，橋的說明被丟掉；現在非串流失敗改回 HTTP 200 帶 `error` 欄位，酒館會把整句說明顯示出來（串流照舊用真的錯誤碼）。「測試訊息」按鈕和擴充功能的背景請求走的就是非串流。
- `/status` 的最後一則多記：`maxTokens`、`capped`（到上限收尾）、`contentBlocked`、`timedOut`、`exitCode`，失敗時附錯誤摘要。README 加「回報問題時請附狀態頁內容」。

## 0.1.0（2026-10-19）

第一版。

- OpenAI 相容的 `/v1/chat/completions`（串流與非串流）、`/v1/models`、`/status`、`/healthz`、`/config`。
- 模型清單啟動時從 `agy models` 讀，十分鐘快取；請求的模型不在清單裡時直接回清單，不白跑一發。
- 每則一個 agy 程序；角色卡、預設、歷史寫進暫時的自訂代理檔（無工具、不載 agy 內建提示），標準輸入只送最新一則；最新一則超過 18 萬位元組時也挪進代理檔（避開 agy 約 19.2 萬位元組的靜默切尾）。
- 新請求進來時讓前一則停下（重新生成不排隊）；酒館斷線時照樣生完、存著等重新生成來拿。
- agy 自動更新關閉；agy 的 API 重試次數預設 0（429 從約 140 秒變成幾秒內回錯誤）。
- 錯誤翻成看得懂的話：429 配額、點數不足、模型不在清單、未登入／登入過期、逾時、找不到 agy。
- 每則生完刪掉 agy 存在本機的該段對話（對話庫、逐字稿、註記、鎖檔）。
- 支援 ADC 登入（`adcAuth`）、選用的 API Key。
- 讓位只發生在同一段對話之間；不同對話可並行（`maxConcurrent`）。酒館的「繼續」會接著寫。
- 首字前就失敗回 HTTP 錯誤（酒館跳通知、不存成角色回覆）；只有 `stream: true` 才串流（OpenAI 預設）。
- `keepOnDisconnect`：斷線（含按停止）時要不要照樣生完。
- 擋本機網頁偷送請求（POST 只收 JSON、Host 檢查）；非本機位址必須設 apiKey。
- 每個程序用自己的暫存夾，兩座橋不會互刪；設定值有上下限。
- agy 結束但管線沒關時 2 秒內收尾；Windows 連子程序一起停。
- 已知限制：不帶圖片；酒館的溫度等取樣參數不生效；「停止」按鈕預設不會停 agy；只驗過 agy 1.4.2。
