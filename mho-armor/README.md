# Outlanders 配裝器

Monster Hunter Outlanders（手機版，2026-10-29 全球上線）嘅防具配裝計算器。純 HTML/CSS/JS，冇 build step、冇外部依賴。

## 功能
- **武器**：8 種上線武器（大劍、太刀、雙劍、大錘、長槍、盾斧、重弩、弓），可揀數據庫入面嘅具體武器或者手動輸入武器技能
- **等級**：輸入冒險者等級（AR）自動計防具稀有度上限，亦可以手動揀
- **目標技能**：自訂技能、目標等級、優先度（高／中／低）；支援套裝技能（按件數門檻）；部分武器有攻略建議技能
- **搜尋**：分支定界（branch-and-bound）窮舉 5 個部位，列出最佳 N 個組合（測試中同暴力窮舉結果一致）
- **素材**：每個組合列出總素材數量，自動扣除已標記「已有」嘅防具，可選包括升級素材，可一鍵複製
- **防具庫**：搜尋、標記「已有」／「排除」
- **數據**：匯入 JSON／CSV、合併、匯出；全部存喺瀏覽器 `localStorage`

## ⚠ 數據狀態
`data/mho-data.json` 而家**冇防具數據**：建立時嘅雲端環境網絡政策封鎖咗 gamewith.ai、game8.co 等數據來源，所以冇填入未核實嘅數字。
已收錄嘅只有 AR→稀有度上限 4 個數據點（AR16→★3、AR21→★5、AR41→★9、AR47→★11，來源：
[GameWith](https://gamewith.ai/monster-hunter-outlanders/en/articles/upgrade-limit-and-dismantle)），中間級數未核實，app 會用保守值並提示。

填數據方法：喺 app「數據」分頁匯入，或者直接編輯 `data/mho-data.json`（格式見 app 內說明）。

## 本機試
```sh
cd mho-armor
python3 -m http.server 8000
# 開 http://localhost:8000
```

## 測試
```sh
node --test mho-armor/test/*.test.js
```
