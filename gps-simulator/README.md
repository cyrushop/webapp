# GPS 定位控制器（Web GPS Simulator）

瀏覽器介面 → 本地橋接（Node.js）→ ADB → Android Mock App，控制 Android 手機的模擬定位。

> ⚠️ **使用前必讀**：在 Pikmin Bloom 等 Niantic／Scopely 遊戲中使用虛擬定位，違反其服務條款，屬「三振處分政策」所列作弊行為，帳號可被警告、停權或永久封禁。Android 的模擬定位會被標記（`Location.isMock()`），本工具**不會**亦**不打算**隱藏此標記。請自行承擔風險；建議只用於開發測試或不涉帳號的用途。
> - [Pikmin Bloom 三振處分政策（官方）](https://niantic.helpshift.com/hc/zh-hant/23-pikmin-bloom/faq/2868-three-strike-discipline-policy/)
> - [Ban appeal FAQ（官方）](https://niantic.helpshift.com/hc/en/23-pikmin-bloom/faq/3044-submitting-a-ban-appeal)

## 架構

```
┌──────────────┐  WebSocket /ws  ┌───────────────────────┐ ① USB 直連（預設）          ┌──────────────────────┐
│ 瀏覽器 Web UI │ ──────────────▶ │ 本地橋接 server/       │   WebSocket /device         │ Android Mock App      │
│ Leaflet 地圖  │ ◀── state 10Hz ─│ Engine（路線/搖桿/漂移）│ ◀═ adb reverse tcp:8787 ══▶ │ BridgeClient (OkHttp) │
│ 搖桿 / WASD   │                 │ DeviceLink / AdbBridge │ ② 後備：am broadcast        │ test providers:       │
└──────────────┘                 └───────────────────────┘ ─────────────────────────▶  │ gps / network / fused │
                                                                                         └──────────────────────┘
```

- **① USB 直連（預設）**：橋接連上 adb 後自動執行 `adb reverse tcp:8787 tcp:8787`；手機 App 連去自己的 `ws://127.0.0.1:8787/device`，經 USB 通道到電腦。每個座標只係一個細 WebSocket frame，唔使每秒喺手機開一個 `am` 進程。拔線後每 2 秒自動重連，電腦端每 5 秒自動重建 `adb reverse`。
- **② ADB 廣播（後備）**：直連未接通時自動改用 `am broadcast`。
- `TRANSPORT=ws|adb` 可強制只用其中一種。

- **移動狀態機在電腦後端**：瀏覽器分頁縮小／背景化都不會影響行走。
- 橋接只監聽 `127.0.0.1`，並拒絕非本機來源（Origin）的 WebSocket，防止其他網站操控你的手機定位。
- 只會把**數字**寫入 adb shell（無字串拼接使用者輸入），沒有指令注入面。
- adb 指令積壓時會丟棄過期座標而非排隊（`maxPending = 2`）。

## 功能對照規格書

| 規格 | 實作 |
|---|---|
| 地圖 / 街道 + 衛星圖層 | Leaflet 1.9.4（本地提供，不依賴 CDN）+ OSM + Esri World Imagery |
| 座標貼上 | `lat, lng`、`lat lng`、Google Maps 連結（`@lat,lng`、`!3d…!4d…`、`?q=`）、`geo:` |
| 地名搜尋 | OSM Nominatim |
| 一鍵瞬移 | 「🎯 選點」點地圖 → 瞬移；收藏列表 ⚡ |
| 收藏夾 + 標籤 + JSON 匯出入 | localStorage，`#標籤` 篩選，匯入自動略過重複座標 |
| 多點路線 | 「✏️ 畫路線」點地圖加點、可拖曳、復原；OSRM 步行路線或直線 |
| GPX 匯入/匯出 | `trkpt` / `rtept` / `wpt` |
| 單次 / 往返 / 閉環繞圈 | 後端 `RoutePlayer`；閉環每圈 < 5 分鐘會提示 |
| 速度滑桿 + 預設 | 1–25 km/h；慢走 / 快走 / 慢跑 / 單車；🌸 種花預設（可自訂，預設 7） |
| 擬真漂移 | 均值回歸隨機漫步（非每秒亂跳），半徑可調；速度 ±% 波動 |
| 虛擬搖桿 | 滑鼠 / 觸控拖曳 + `W A S D` / 方向鍵；按住時每 250ms 重送，失焦自動停 |
| 冷卻計算器 | 記錄互動點 → 實時倒數；瞬移前檢查並要求確認；冷卻表可編輯 |
| 還原真實 GPS | 移除 test providers 並停止服務 |

## 安裝與執行

### 1. 電腦端（需要 Node.js ≥ 18 與 Android platform-tools）

```sh
cd gps-simulator/server
npm install
npm start            # http://127.0.0.1:8787
# 沒有手機時試介面：
npm run dry          # DRY_RUN=1，不呼叫 adb
npm test             # 單元 + 整合測試（含 /device 直連）
```

環境變數：

| 變數 | 預設 | 說明 |
|---|---|---|
| `PORT` | `8787` | |
| `HOST` | `127.0.0.1` | 改成 `0.0.0.0` 會讓同網絡的人都能控制你的定位，不建議 |
| `TICK_MS` | `1000` | 推送頻率（最低 200） |
| `ADB_PATH` | `adb` | |
| `ADB_SERIAL` | 第一部裝置 | 多部手機時指定 |
| `MOCK_PKG` | `com.pikminbridge.mock` | |
| `DRY_RUN` | 關 | |
| `TRANSPORT` | `auto` | `auto`＝直連優先、廣播後備；`ws`；`adb` |
| `DEVICE_ALLOW_LAN` | 關 | 容許 LAN 上的手機直接連 `/device`（Wi-Fi，無 USB）。預設只接受經 `adb reverse` 的本機連線 |

### 2. 手機端 Mock App

**取得 APK（三選一）**

- **GitHub Actions（推薦）**：每次 push 到 `gps-simulator/**` 都會自動 build。到 repo → Actions → *GPS Simulator CI* → 最新一次 run → Artifacts 下載 `mock-location-bridge-apk`（zip 內是 APK），然後 `adb install -r mock-location-bridge-xxxxxxx.apk`。
- **Release**：push 一個 `gps-sim-v*` tag（例如 `git tag gps-sim-v0.2.0 && git push origin gps-sim-v0.2.0`），CI 會把 APK 附加到 GitHub Release。
- **本機**：`cd gps-simulator/android && ./gradlew assembleRelease`，或用 Android Studio 開啟該資料夾。

**固定簽名（建議）**：未設定 secrets 時，CI 用每次 runner 臨時產生的 debug key 簽名，新舊 APK 簽名不同，更新前要先解除安裝舊版。一次性設定：

```sh
keytool -genkeypair -v -keystore mockbridge.jks -alias mockbridge -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 mockbridge.jks > mockbridge.jks.b64     # macOS: base64 -i mockbridge.jks
```

Repo → Settings → Secrets and variables → Actions，新增：`ANDROID_KEYSTORE_BASE64`（.b64 內容）、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`（`mockbridge`）、`ANDROID_KEY_PASSWORD`。keystore 檔本身唔好 commit 入 repo。

**手機設定**

1. 安裝 APK（見上）。
2. 手機：設定 → 關於手機 → 連按「版本號碼」開啟開發者選項 → 開啟 **USB 偵錯**。
3. 接 USB，在手機上允許此電腦。
4. 網頁「裝置」分頁 → **🛠 一鍵設定手機**（執行 `appops set … android:mock_location allow`、授予定位權限、啟動 App）。
5. 若仍未生效：開發者選項 → **選取模擬位置應用程式** → Mock Location Bridge。
6. App 內按「3. 啟動模擬服務」，通知列出現常駐通知即可。

### Pixel 10 Pro / Android 17 注意事項

- 安裝：Google 的「開發者驗證」新規則**不影響 `adb install`**（官方 FAQ 明言 ADB 流程不變）；首批強制地區為巴西、印尼、新加坡、泰國，2027 年擴展至全球。
- 背景啟動限制：Android 12+ 禁止大部分情況由背景啟動前景服務，所以 `am broadcast` 後備路徑喺 App 未開時可能起唔到服務。USB 直連由 App 前台啟動一次後一直常駐，冇呢個問題；「一鍵設定手機」會用 `am start` 由前台開 App。
- 明文連線：Android 17 要求用 network security config 宣告明文連線；App 只對 `127.0.0.1`/`localhost` 開放 `ws://`，其他一律維持只限 TLS。
- `ACCESS_LOCAL_NETWORK`：Android 17 新權限只適用於 **targetSdk 37+** 的 App；本 App target 35，且只連 loopback。
- 電池最佳化：如 Pixel 喺螢幕關閉後殺咗服務，到 設定 → 應用程式 → Mock Location Bridge → 電池 → 選「不受限制」。

手動測試指令（後備廣播路徑）：

```sh
adb shell am broadcast -n com.pikminbridge.mock/.CommandReceiver \
  -a com.pikminbridge.mock.SET_LOCATION --es lat 35.658581 --es lng 139.745433
```

## 已知限制 / 未驗證事項

- Android App 由 GitHub Actions 編譯（開發環境無法連線 Google Maven）；**未在實機上測試**。
- 遊戲是否接受 `LocationManager` test provider 的座標，取決於遊戲使用的定位來源；App 同時餵 `gps`、`network`、`fused`（API 31+）及 Google Play Services Fused（`setMockMode`）。實際效果未經驗證。
- **種花速度上限**：社群資料（Pikipedia）指約 16–20 km/h，非官方數字；UI 在 ≥16 km/h 顯示警告。🌸 預設 7 km/h 為保守值，並非已證實的「最佳」值。
- **冷卻表**：源自 Pokémon GO 玩家社群測試，非 Niantic／Scopely 官方數據，未證實適用於 Pikmin Bloom。
- 公共 OSRM（routing.openstreetmap.de）與 Nominatim 有使用政策與速率限制，只適合個人少量使用；可在「裝置 → 進階」更換 OSRM URL。
- 規格書建議 React/Vue + Tailwind、Socket.io；本實作改用原生 JS + 原生 WebSocket（`ws`），零建置步驟、依賴只有 `ws` 與 `leaflet`。
