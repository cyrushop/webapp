# 每日健身

手機用嘅每日健身打卡 web app（PWA，可加到主畫面、離線使用）。

## 功能
- **今日**：每日任務清單，撳一下打剔（再撳取消），進度圈、連續日數 🔥
- **紀錄**：月曆睇邊日全部完成／做咗部分；撳任何過去日子可以補記
- **項目**：新增、刪除、改名、改次數（−／＋ 或直接輸入）、改單位（次／秒／分鐘）、排次序
- 每日紀錄會保存當日嘅項目快照，之後改次數唔會影響舊紀錄
- 匯出／匯入 JSON 備份

預設項目：Push Up 15 次（第 1 組）、Push Up 15 次（第 2 組）、壺鈴 100 次、引體上升 5 次、深蹲 50 次。

## 資料儲存
所有資料存喺瀏覽器 `localStorage`（只喺呢部手機）。清除瀏覽器資料或換手機前，請先喺「項目 → 匯出備份」。

## 部署（GitHub Pages）
1. Repo → **Settings → Pages**
2. Source 揀 **Deploy from a branch**，揀放咗呢啲檔案嘅 branch，folder 揀 `/ (root)`
3. 用手機開個網址 → iPhone Safari：分享 →「加至主畫面」；Android Chrome：選單 →「安裝應用程式」

## 本機試
```sh
python3 -m http.server 8000
# 開 http://localhost:8000
```

純 HTML/CSS/JS，冇 build step、冇外部依賴。
