# GPS 定位控制器（Web GPS Simulator）

瀏覽器介面 → 本地橋接（Node.js）→ ADB → Android Mock App，控制 Android 手機的模擬定位。

> ⚠️ **使用前必讀**：在 Pikmin Bloom 等 Niantic／Scopely 遊戲中使用虛擬定位，違反其服務條款，屬「三振處分政策」所列作弊行為，帳號可被警告、停權或永久封禁。Android 的模擬定位會被標記（`Location.isMock()`），本工具**不會**亦**不打算**隱藏此標記。請自行承擔風險；建議只用於開發測試或不涉帳號的用途。
> - [Pikmin Bloom 三振處分政策（官方）](https://niantic.helpshift.com/hc/zh-hant/23-pikmin-bloom/faq/2868-three-strike-discipline-policy/)
> - [Ban appeal FAQ（官方）](https://niantic.helpshift.com/hc/en/23-pikmin-bloom/faq/3044-submitting-a-ban-appeal)

## 架構

```
┌──────────────┐  WebSocket /ws  ┌───────────────────────┐  adb shell (常駐)   ┌──────────────────────┐
│ 瀏覽器 Web UI │ ──────────────▶ │ 本地橋接 server/       │ ─────────────────▶ │ Android Mock App      │
│ Leaflet 地圖  │ ◀── state 10Hz ─│ Engine（路線/搖桿/漂移）│  am broadcast ~1Hz │ test providers:       │
│ 搖桿 / WASD   │                 │ AdbBridge（背壓丟棄）   │                    │ gps / network / fused │
└──────────────┘                 └───────────────────────┘                    └──────────────────────┘
```

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
npm test             # 13 個單元測試
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

### 2. 手機端 Mock App

1. 用 Android Studio 開啟 `gps-simulator/android/`（Gradle 同步會自動下載 wrapper 所需的 Gradle 8.11.1），Run 到手機。
   - 本 repo 未附 `gradlew` / `gradle-wrapper.jar`（二進位檔）；Android Studio 不需要它們。要用命令列可在該資料夾執行 `gradle wrapper`。
2. 手機：設定 → 關於手機 → 連按「版本號碼」開啟開發者選項 → 開啟 **USB 偵錯**。
3. 接 USB，在手機上允許此電腦。
4. 網頁「裝置」分頁 → **🛠 一鍵設定手機**（執行 `appops set … android:mock_location allow`、授予定位權限、啟動 App）。
5. 若仍未生效：開發者選項 → **選取模擬位置應用程式** → Mock Location Bridge。
6. App 內按「3. 啟動模擬服務」，通知列出現常駐通知即可。

手動測試指令：

```sh
adb shell am broadcast -n com.pikminbridge.mock/.CommandReceiver \
  -a com.pikminbridge.mock.SET_LOCATION --es lat 35.658581 --es lng 139.745433
```

## 已知限制 / 未驗證事項

- **Android App 未在此環境編譯**（建置環境無法連線 Google Maven）。程式碼按 Android API 文件撰寫，第一次 Gradle 同步若有版本衝突，請讓 Android Studio 升級 AGP/Kotlin 版本。
- 遊戲是否接受 `LocationManager` test provider 的座標，取決於遊戲使用的定位來源；App 同時餵 `gps`、`network`、`fused`（API 31+）及 Google Play Services Fused（`setMockMode`）。實際效果未經驗證。
- **種花速度上限**：社群資料（Pikipedia）指約 16–20 km/h，非官方數字；UI 在 ≥16 km/h 顯示警告。🌸 預設 7 km/h 為保守值，並非已證實的「最佳」值。
- **冷卻表**：源自 Pokémon GO 玩家社群測試，非 Niantic／Scopely 官方數據，未證實適用於 Pikmin Bloom。
- 公共 OSRM（routing.openstreetmap.de）與 Nominatim 有使用政策與速率限制，只適合個人少量使用；可在「裝置 → 進階」更換 OSRM URL。
- 規格書建議 React/Vue + Tailwind、Socket.io；本實作改用原生 JS + 原生 WebSocket（`ws`），零建置步驟、依賴只有 `ws` 與 `leaflet`。
