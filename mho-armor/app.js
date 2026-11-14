/* global MHO */
(function () {
  'use strict';
  const M = MHO;
  const KEY = 'mho-armor-v1';
  const $ = id => document.getElementById(id);

  // Skill suggestions taken from published build guides (Game8, checked 2026-11-14).
  // Skill names are as the guides wrote them; they only work if your data uses the same names.
  const PRESETS = {
    'long-sword': { skills: ['Flash Draw'], src: 'https://game8.co/games/Monster-Hunter-Outlanders/archives/618475' },
    'hammer': { skills: ['Charge Enhancement', 'Intimidation'], src: 'https://game8.co/games/Monster-Hunter-Outlanders/archives/635685' },
    'heavy-bowgun': { skills: ['Capacity Boost', 'Offensive Defense'], src: 'https://game8.co/games/Monster-Hunter-Outlanders/archives/618476' },
    'bow': { skills: ['Bow Skill Boost', 'Thunder Damage Up'], src: 'https://game8.co/games/Monster-Hunter-Outlanders/archives/635378' },
    'dual-blades': { skills: ['Fire Damage Up'], src: 'https://game8.co/games/Monster-Hunter-Outlanders/archives/634604' },
  };

  // ---------- storage ----------
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
  }
  const state = Object.assign({
    settings: {
      weaponType: 'long-sword', weaponName: '', weaponSkills: '', ar: '', rarity: 'auto',
      targets: [], topN: 10, preferOwned: true, includeUpgrades: false,
    },
    owned: [],
    excluded: [],
    customDB: null,
  }, load());
  const S = state.settings;

  let bundled = null;
  let db = { meta: {}, arCaps: [], skills: [], setSkills: [], weapons: [], armor: [] };

  // ---------- DOM helper ----------
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : String(c));
    return n;
  }
  function link(href, text) {
    return el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text || href);
  }

  // ---------- data ----------
  async function initData() {
    try {
      const res = await fetch('data/mho-data.json', { cache: 'no-cache' });
      if (res.ok) bundled = M.normalizeDB(await res.json()).db;
    } catch { /* offline or file:// */ }
    applyDB();
  }
  function applyDB() {
    const src = state.customDB || bundled;
    db = src ? M.normalizeDB(src).db : db;
    if (!db.arCaps.length && bundled) db.arCaps = bundled.arCaps;
    renderAll();
  }
  function setSkillNames() { return new Set(db.setSkills.map(s => s.name).concat(db.armor.map(a => a.setSkill).filter(Boolean))); }
  function allSkillNames() {
    const s = new Set(db.skills.map(x => x.name));
    for (const a of db.armor) for (const k of Object.keys(a.skills)) s.add(k);
    for (const w of db.weapons) for (const k of Object.keys(w.skills || {})) s.add(k);
    return [...s].sort((a, b) => a.localeCompare(b));
  }
  function maxLevelOf(name) {
    return db.skills.find(s => s.name === name)?.maxLevel
      ?? db.setSkills.find(s => s.name === name)?.tiers?.length ?? null;
  }

  // ---------- render: build tab ----------
  function renderBanner() {
    const box = $('dataBanner');
    box.replaceChildren();
    if (!db.armor.length) {
      box.append(el('div', { class: 'note bad' },
        el('b', {}, '未有防具數據。'),
        ' App 已經可以用，但需要先匯入 Outlanders 防具數據（技能、套裝、素材）先計到配裝。去「數據」分頁匯入 JSON／CSV。',
      ));
    } else if (db.meta && db.meta.verified === false) {
      box.append(el('div', { class: 'note' }, `數據未標記為已核實（${db.armor.length} 件防具）。結果僅供參考，請以遊戲內數值為準。`));
    }
  }

  function renderWeapon() {
    const wt = $('weaponType');
    wt.replaceChildren(...M.WEAPON_TYPES.map(w => el('option', { value: w.id, selected: w.id === S.weaponType }, w.name)));
    const wn = $('weaponName');
    const list = db.weapons.filter(w => !w.type || w.type === S.weaponType);
    wn.replaceChildren(
      el('option', { value: '' }, list.length ? '— 唔指定 —' : '（數據庫未有武器）'),
      ...list.map(w => el('option', { value: w.name, selected: w.name === S.weaponName },
        `${w.name}${w.rarity ? ` ★${w.rarity}` : ''}`)),
    );
    wn.disabled = !list.length;
    $('weaponSkills').value = S.weaponSkills || '';
  }

  function currentCap() {
    if (S.rarity !== 'auto') return S.rarity === 'none' ? null : Number(S.rarity);
    return M.maxRarityForAR(Number(S.ar), db.arCaps);
  }

  function renderCap() {
    $('ar').value = S.ar;
    const rarities = [...new Set(db.armor.map(a => a.rarity).filter(Number.isFinite).concat(db.arCaps.map(c => c.rarity)))].sort((a, b) => a - b);
    const maxR = Math.max(12, ...rarities);
    const sel = $('rarityOverride');
    sel.replaceChildren(
      el('option', { value: 'auto', selected: S.rarity === 'auto' }, '按 AR 自動'),
      el('option', { value: 'none', selected: S.rarity === 'none' }, '唔限制'),
      ...Array.from({ length: maxR }, (_, i) => i + 1).map(r => el('option', { value: String(r), selected: S.rarity === String(r) }, `★${r} 或以下`)),
    );
    const info = $('capInfo');
    info.replaceChildren();
    const cap = currentCap();
    if (S.rarity === 'auto') {
      if (!S.ar) info.append('輸入 AR 會自動計防具稀有度上限。');
      else if (cap == null) info.append(el('span', { style: 'color:var(--warn)' }, `AR ${S.ar} 低過已知數據點，上限未核實：請喺右邊手動揀。`));
      else {
        const exact = db.arCaps.some(c => c.ar === Number(S.ar));
        const next = db.arCaps.find(c => c.ar > Number(S.ar));
        info.append(`AR ${S.ar} → 稀有度上限 ★${cap}`);
        if (!exact && next) info.append(el('span', { style: 'color:var(--warn)' },
          `（已知下一級：AR ${next.ar} → ★${next.rarity}；中間級數未核實，用咗保守值。如知道實際上限可手動揀）`));
        info.append(' 來源：', link('https://gamewith.ai/monster-hunter-outlanders/en/articles/upgrade-limit-and-dismantle', 'GameWith'));
      }
    } else {
      info.append(S.rarity === 'none' ? '唔限制稀有度。' : `手動上限：★${S.rarity}`);
    }
  }

  function renderPresets() {
    const box = $('presetBox');
    box.replaceChildren();
    const p = PRESETS[S.weaponType];
    if (!p) {
      box.append(el('div', { class: 'small-text muted', style: 'margin-bottom:8px' }, '呢種武器未有已核實嘅攻略技能建議，請自己加目標技能。'));
      return;
    }
    const known = new Set(allSkillNames().concat([...setSkillNames()]));
    box.append(el('div', { class: 'small-text muted', style: 'margin-bottom:6px' },
      '攻略建議（撳一下加入）· 來源：', link(p.src, 'Game8'), ' · 技能名需同數據一致'));
    box.append(el('div', { class: 'chips', style: 'margin-bottom:10px' },
      p.skills.map(n => el('button', {
        class: 'chip' + (known.has(n) ? ' hit' : ''),
        title: known.has(n) ? '數據庫有呢個技能' : '數據庫未見呢個技能名',
        onclick: () => addTarget(n),
      }, '＋ ' + n + (known.size && !known.has(n) ? ' ⚠' : '')))));
  }

  function renderTargets() {
    $('skillList').replaceChildren(
      ...allSkillNames().map(n => el('option', { value: n })),
      ...[...setSkillNames()].map(n => el('option', { value: n }, '套裝技能')),
    );
    const box = $('targets');
    box.replaceChildren();
    if (!S.targets.length) {
      box.append(el('div', { class: 'small-text muted' }, '未有目標技能。'));
      return;
    }
    const sets = setSkillNames();
    S.targets.forEach((t, i) => {
      const isSet = sets.has(t.name);
      const max = maxLevelOf(t.name);
      box.append(el('div', { class: 'target' },
        el('div', {},
          el('input', {
            type: 'text', value: t.name, list: 'skillList', 'aria-label': '技能名',
            onchange: e => {
              t.name = e.target.value.trim();
              if (t.level == null) t.level = maxLevelOf(t.name);
              save(); renderTargets();
            },
          }),
          isSet ? el('div', { class: 'kind' }, '套裝技能') : null),
        el('input', {
          type: 'number', min: 1, value: t.level ?? '', placeholder: max ? `最高${max}` : '盡量高',
          'aria-label': '目標等級', inputmode: 'numeric',
          onchange: e => { t.level = e.target.value === '' ? null : Math.max(1, Number(e.target.value)); save(); },
        }),
        el('select', { 'aria-label': '優先度', onchange: e => { t.weight = Number(e.target.value); save(); } },
          [[3, '高'], [2, '中'], [1, '低']].map(([v, l]) => el('option', { value: v, selected: Number(t.weight) === v }, `優先 ${l}`))),
        el('button', { class: 'small ghost', 'aria-label': '刪除', onclick: () => { S.targets.splice(i, 1); save(); renderTargets(); } }, '✕'),
      ));
    });
  }

  function addTarget(name) {
    if (name && S.targets.some(t => t.name === name)) return;
    const max = name ? maxLevelOf(name) : null;
    S.targets.push({ name: name || '', level: max, weight: 3 - Math.min(2, S.targets.length) });
    save(); renderTargets();
  }

  function renderOptions() {
    $('topN').value = String(S.topN);
    $('preferOwned').checked = !!S.preferOwned;
    $('includeUpgrades').checked = !!S.includeUpgrades;
  }

  // ---------- run ----------
  function weaponSkillMap() {
    const m = M.parseKV(S.weaponSkills);
    const w = db.weapons.find(x => x.name === S.weaponName);
    if (w) for (const [k, v] of Object.entries(w.skills || {})) m[k] = (m[k] || 0) + Number(v);
    return m;
  }

  function run() {
    const out = $('results');
    if (!db.armor.length) {
      out.replaceChildren(el('div', { class: 'card empty' }, el('b', {}, '未有防具數據'), '去「數據」分頁匯入之後再試。'));
      return;
    }
    const targets = S.targets.filter(t => t.name).map(t => ({
      name: t.name, level: t.level, weight: t.weight, kind: setSkillNames().has(t.name) ? 'set' : 'skill',
    }));
    if (!targets.length) {
      out.replaceChildren(el('div', { class: 'card empty' }, el('b', {}, '未揀目標技能'), '最少加一個技能，或者撳攻略建議。'));
      return;
    }
    out.replaceChildren(el('div', { class: 'card empty' }, '計緊…'));
    setTimeout(() => {
      const t0 = performance.now();
      const res = M.optimize(db, {
        targets, cap: currentCap(), weaponSkills: weaponSkillMap(),
        owned: new Set(state.owned), excluded: new Set(state.excluded),
        topN: Number(S.topN), preferOwned: S.preferOwned, includeUpgrades: S.includeUpgrades,
      });
      renderResults(res, targets, performance.now() - t0);
    }, 20);
  }

  function renderResults(res, targets, ms) {
    const out = $('results');
    out.replaceChildren();
    const unknown = targets.filter(t => t.kind === 'skill' && !allSkillNames().includes(t.name));
    if (unknown.length) out.append(el('div', { class: 'note bad' }, `數據庫冇以下技能（檢查拼寫）：${unknown.map(t => t.name).join('、')}`));
    for (const w of res.warnings) out.append(el('div', { class: 'note bad' }, w));
    if (res.truncated) out.append(el('div', { class: 'note' }, '組合太多，搜尋提早停止；結果可能唔係絕對最優。可以減少目標技能或排除部分防具。'));
    out.append(el('div', { class: 'small-text muted', style: 'margin:6px 2px' },
      `搵到 ${res.results.length} 個組合 · 候選件數 ${res.slots.map(s => `${M.PART_LABEL[s.part]}${s.candidates}/${s.total}`).join(' ')} · ${ms.toFixed(0)} ms`));
    if (!res.results.length) {
      out.append(el('div', { class: 'card empty' }, el('b', {}, '搵唔到組合'), '可能稀有度上限太低，或者防具全部被排除咗。'));
      return;
    }
    const targetMap = new Map(targets.map(t => [t.name, t]));
    for (const r of res.results) out.append(resultCard(r, res.maxScore, targetMap));
    out.firstElementChild?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function resultCard(r, maxScore, targetMap) {
    const full = r.missing.length === 0;
    const pct = maxScore > 0 ? Math.min(100, (r.skillScore / maxScore) * 100) : 100;
    const owned = new Set(state.owned);

    const rows = r.pieces.map(({ part, piece }) => el('tr', {},
      el('td', { class: 'part' }, M.PART_LABEL[part]),
      piece
        ? el('td', {},
            el('span', { class: 'pname' }, piece.name),
            owned.has(piece.id) ? el('span', { class: 'tag' }, '已有') : null,
            el('div', { class: 'small-text muted' },
              [piece.set, piece.rarity != null ? `★${piece.rarity}` : null, piece.defense != null ? `防 ${piece.defense}` : null].filter(Boolean).join(' · ')),
            el('div', { class: 'small-text' },
              Object.entries(piece.skills).map(([k, v]) => `${k} ${v}`).join('、'),
              piece.setSkill ? el('span', { class: 'muted' }, `${Object.keys(piece.skills).length ? '｜' : ''}套裝：${piece.setSkill}`) : null))
        : el('td', { class: 'muted' }, '（空 / 任意）'),
      el('td', { style: 'width:1%' }, piece ? el('button', {
        class: 'small toggle', 'aria-pressed': owned.has(piece.id) ? 'true' : 'false',
        onclick: e => { toggle('owned', piece.id); e.target.setAttribute('aria-pressed', String(state.owned.includes(piece.id))); },
      }, '已有') : null),
    ));

    const skillChips = r.skills.map(s => {
      const t = targetMap.get(s.name);
      const want = t?.level;
      const cls = t ? (want != null && s.level < want ? 'chip short' : 'chip hit') : 'chip';
      const over = s.max != null && s.level > s.max ? `（溢出 +${s.level - s.max}）` : '';
      return el('span', { class: cls }, `${s.name} ${s.level}${want != null && t ? `/${want}` : ''}${s.max != null && !t ? `/${s.max}` : ''}${over}`);
    });
    for (const m of r.missing) if (m.have === 0 && !m.set) skillChips.push(el('span', { class: 'chip short' }, `${m.name} 0/${m.want}`));

    const setChips = r.sets.filter(s => s.count > 0).map(s => el('span', {
      class: 'chip' + (s.active.length ? ' set' : ''),
      title: s.active.map(t => `${t.pieces}件：${t.effect || ''}`).join('\n'),
    }, `${s.name} ${s.count}件${s.active.length ? ` ✓${s.active.length}段` : ''}${s.next ? `（${s.next.pieces}件下一段）` : ''}`));

    const matText = r.materials.map(m => `${m.name} x${m.qty}`).join('\n');
    return el('div', { class: 'card result' + (full ? ' full' : '') },
      el('div', { class: 'rhead' },
        el('span', { class: 'rank' }, `#${r.rank}`),
        el('span', { class: 'small-text muted' }, `防禦 ${r.defense} · ${full ? '全部目標達成' : `差 ${r.missing.length} 項`}`)),
      el('div', { class: 'meter' }, el('i', { style: `width:${pct.toFixed(0)}%` })),
      el('table', {}, el('tbody', {}, rows)),
      el('div', { style: 'margin-top:10px' }, el('div', { class: 'chips' }, skillChips)),
      setChips.length ? el('div', { class: 'chips', style: 'margin-top:6px' }, setChips) : null,
      el('details', {},
        el('summary', {}, `需要素材（${r.materials.length} 種${r.ownedPieces.length ? `，已扣除 ${r.ownedPieces.length} 件已有防具` : ''}）`),
        r.materials.length
          ? el('ul', { class: 'mats' }, r.materials.map(m => el('li', {}, el('span', {}, m.name), el('b', {}, `×${m.qty}`))))
          : el('div', { class: 'small-text muted' }, '唔使額外素材（或數據未有素材）。'),
        r.materials.length ? el('div', { class: 'btns' },
          el('button', { class: 'small', onclick: e => copy(matText, e.target) }, '複製素材清單')) : null,
      ),
    );
  }

  function copy(text, btn) {
    const done = () => { const o = btn.textContent; btn.textContent = '已複製'; setTimeout(() => { btn.textContent = o; }, 1200); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => prompt('複製：', text));
    else prompt('複製：', text);
  }

  function toggle(listName, id) {
    const s = new Set(state[listName]);
    if (s.has(id)) s.delete(id); else s.add(id);
    state[listName] = [...s];
    save();
  }

  // ---------- library tab ----------
  function renderLib() {
    const part = $('libPart');
    if (!part.options.length) {
      part.replaceChildren(el('option', { value: '' }, '全部部位'), ...M.PARTS.map(p => el('option', { value: p }, M.PART_LABEL[p])));
    }
    const q = $('libSearch').value.trim().toLowerCase();
    const pf = part.value;
    const owned = new Set(state.owned), ex = new Set(state.excluded);
    const items = db.armor.filter(a => (!pf || a.part === pf) && (!q ||
      [a.name, a.set, a.setSkill, ...Object.keys(a.skills)].filter(Boolean).join(' ').toLowerCase().includes(q)));
    const box = $('libList');
    box.replaceChildren();
    if (!db.armor.length) { box.append(el('div', { class: 'empty' }, el('b', {}, '未有防具數據'), '去「數據」分頁匯入。')); return; }
    box.append(el('div', { class: 'small-text muted', style: 'margin:4px 0' }, `${items.length} 件 · 已有 ${owned.size} · 排除 ${ex.size}`));
    for (const a of items.slice(0, 300)) {
      box.append(el('div', { class: 'lib-item' },
        el('div', {},
          el('div', {}, el('span', { class: 'muted small-text' }, M.PART_LABEL[a.part] + ' '), el('span', { class: 'pname' }, a.name)),
          el('div', { class: 'small-text muted' }, [a.set, a.rarity != null ? `★${a.rarity}` : null, a.defense != null ? `防 ${a.defense}` : null, a.setSkill ? `套裝：${a.setSkill}` : null].filter(Boolean).join(' · ')),
          el('div', { class: 'small-text' }, Object.entries(a.skills).map(([k, v]) => `${k} ${v}`).join('、') || '—'),
        ),
        el('div', { class: 'lib-actions' },
          el('button', { class: 'small toggle', 'aria-pressed': String(owned.has(a.id)), onclick: () => { toggle('owned', a.id); renderLib(); } }, '已有'),
          el('button', { class: 'small toggle ex', 'aria-pressed': String(ex.has(a.id)), onclick: () => { toggle('excluded', a.id); renderLib(); } }, '排除'),
        ),
      ));
    }
    if (items.length > 300) box.append(el('div', { class: 'small-text muted' }, `只顯示頭 300 件，請用搜尋收窄。`));
  }

  // ---------- data tab ----------
  function renderDataStatus() {
    const box = $('dataStatus');
    const m = db.meta || {};
    box.replaceChildren(
      el('div', {},
        el('span', { class: 'stat' }, el('b', {}, db.armor.length), ' 件防具'),
        el('span', { class: 'stat' }, el('b', {}, allSkillNames().length), ' 個技能'),
        el('span', { class: 'stat' }, el('b', {}, setSkillNames().size), ' 個套裝技能'),
        el('span', { class: 'stat' }, el('b', {}, db.weapons.length), ' 件武器')),
      el('div', { class: 'small-text muted', style: 'margin-top:6px' },
        `來源：${state.customDB ? '你匯入嘅數據' : '內置數據'}${m.updated ? ` · 更新：${m.updated}` : ''} · ${m.verified ? '已核實' : '未核實'}`),
      m.notes ? el('div', { class: 'note' }, m.notes) : null,
      (m.sources || []).length ? el('div', { class: 'small-text' }, '參考：', ...(m.sources || []).flatMap((s, i) => [i ? '、' : '', link(s)])) : null,
    );
  }

  async function doImport() {
    const msg = $('importMsg');
    msg.replaceChildren();
    let text = $('importText').value.trim();
    const f = $('importFile').files[0];
    if (!text && f) text = await f.text();
    if (!text) { msg.append(el('div', { class: 'note bad' }, '冇內容。')); return; }
    let incoming, errors = [];
    if (/^[\s﻿]*[{[]/.test(text)) {
      try {
        const raw = JSON.parse(text.replace(/^﻿/, ''));
        ({ db: incoming, errors } = M.normalizeDB(Array.isArray(raw) ? { armor: raw } : raw));
      } catch (e) { msg.append(el('div', { class: 'note bad' }, 'JSON 解析失敗：' + e.message)); return; }
    } else {
      const r = M.armorFromCSV(text);
      errors = r.errors;
      incoming = { meta: { updated: new Date().toISOString().slice(0, 10), verified: false, notes: 'CSV 匯入' }, arCaps: [], skills: [], setSkills: [], weapons: [], armor: r.armor };
    }
    if (!incoming || !incoming.armor.length && !incoming.skills.length && !incoming.weapons.length) {
      msg.append(el('div', { class: 'note bad' }, '冇可匯入嘅內容。', errors.length ? ' ' + errors.slice(0, 5).join('；') : ''));
      return;
    }
    if ($('importMode').value === 'merge') {
      const cur = M.normalizeDB(state.customDB || bundled || {}).db || incoming;
      const byId = new Map(cur.armor.map(a => [a.id, a]));
      for (const a of incoming.armor) byId.set(a.id, a);
      const mergeBy = (a, b) => [...new Map([...a, ...b].map(x => [x.name, x])).values()];
      incoming = {
        meta: { ...cur.meta, ...incoming.meta, verified: !!(cur.meta?.verified && incoming.meta?.verified) },
        arCaps: incoming.arCaps.length ? incoming.arCaps : cur.arCaps,
        skills: mergeBy(cur.skills, incoming.skills),
        setSkills: mergeBy(cur.setSkills, incoming.setSkills),
        weapons: mergeBy(cur.weapons, incoming.weapons),
        armor: [...byId.values()],
      };
    }
    state.customDB = incoming;
    save();
    applyDB();
    msg.append(el('div', { class: errors.length ? 'note' : 'note ok' },
      `已匯入：${incoming.armor.length} 件防具。`, errors.length ? ` ${errors.length} 個問題：${errors.slice(0, 5).join('；')}${errors.length > 5 ? '…' : ''}` : ''));
    $('importText').value = '';
    $('importFile').value = '';
  }

  function download(name, text, type) {
    const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- wiring ----------
  function renderAll() {
    renderBanner(); renderWeapon(); renderCap(); renderPresets(); renderTargets(); renderOptions();
    renderLib(); renderDataStatus();
  }

  $('weaponType').addEventListener('change', e => { S.weaponType = e.target.value; S.weaponName = ''; save(); renderWeapon(); renderPresets(); });
  $('weaponName').addEventListener('change', e => { S.weaponName = e.target.value; save(); });
  $('weaponSkills').addEventListener('change', e => { S.weaponSkills = e.target.value; save(); });
  $('ar').addEventListener('input', e => { S.ar = e.target.value; save(); renderCap(); });
  $('rarityOverride').addEventListener('change', e => { S.rarity = e.target.value; save(); renderCap(); });
  $('addTarget').addEventListener('click', () => addTarget(''));
  $('clearTargets').addEventListener('click', () => { S.targets = []; save(); renderTargets(); });
  $('topN').addEventListener('change', e => { S.topN = Number(e.target.value); save(); });
  $('preferOwned').addEventListener('change', e => { S.preferOwned = e.target.checked; save(); });
  $('includeUpgrades').addEventListener('change', e => { S.includeUpgrades = e.target.checked; save(); });
  $('run').addEventListener('click', run);
  $('libSearch').addEventListener('input', renderLib);
  $('libPart').addEventListener('change', renderLib);
  $('doImport').addEventListener('click', doImport);
  $('exportJson').addEventListener('click', () => download('mho-data.json', JSON.stringify(db, null, 2), 'application/json'));
  $('dlTemplate').addEventListener('click', () => download('mho-armor-template.csv',
    '﻿' + M.CSV_COLS.join(',') + '\nEXAMPLE Helm (delete this row),Example Set,head,3,20,"Skill A:2; Skill B:1",Example Set Skill,"Material A:2; Material B:1"\n', 'text/csv'));
  $('resetData').addEventListener('click', () => {
    if (!confirm('刪除你匯入嘅數據，還原內置數據？（已有／排除標記會保留）')) return;
    state.customDB = null; save(); applyDB();
  });
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    for (const t of ['build', 'lib', 'data']) $('tab-' + t).classList.toggle('hidden', t !== b.dataset.tab);
    window.scrollTo(0, 0);
  }));

  initData();
})();
