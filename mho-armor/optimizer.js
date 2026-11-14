// Monster Hunter Outlanders armor optimizer — pure logic, no DOM.
// Works in the browser (window.MHO) and in Node (require) for tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MHO = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PARTS = ['head', 'chest', 'arms', 'waist', 'legs'];
  const PART_LABEL = { head: '頭', chest: '胸', arms: '腕', waist: '腰', legs: '腳' };
  const PART_ALIASES = {
    head: 'head', helm: 'head', helmet: 'head', 頭: 'head', 头: 'head',
    chest: 'chest', body: 'chest', mail: 'chest', 胸: 'chest', 身: 'chest', 胴: 'chest',
    arms: 'arms', arm: 'arms', braces: 'arms', vambraces: 'arms', 腕: 'arms', 手: 'arms',
    waist: 'waist', coil: 'waist', belt: 'waist', 腰: 'waist',
    legs: 'legs', leg: 'legs', greaves: 'legs', boots: 'legs', 腳: 'legs', 脚: 'legs', 足: 'legs',
  };

  // Weapon types available at the 2026-10-29 global launch (8 types).
  const WEAPON_TYPES = [
    { id: 'great-sword', name: '大劍 Great Sword' },
    { id: 'long-sword', name: '太刀 Long Sword' },
    { id: 'dual-blades', name: '雙劍 Dual Blades' },
    { id: 'hammer', name: '大錘 Hammer' },
    { id: 'lance', name: '長槍 Lance' },
    { id: 'charge-blade', name: '盾斧 Charge Blade' },
    { id: 'heavy-bowgun', name: '重弩 Heavy Bowgun' },
    { id: 'bow', name: '弓 Bow' },
  ];

  const SKILL_UNIT = 1e8;  // one weighted skill level outranks any owned/defense tie-break
  const OWNED_UNIT = 1e6;  // one owned piece outranks any defense difference
  const DEF_CAP = OWNED_UNIT - 1;

  function normPart(p) {
    if (p == null) return null;
    const k = String(p).trim().toLowerCase();
    return PART_ALIASES[k] || null;
  }

  // arCaps: [{ ar, rarity }] — highest rarity unlocked at each Adventurer Rank.
  // Returns null when the AR is below every known entry (cap unknown).
  function maxRarityForAR(ar, arCaps) {
    if (!Number.isFinite(ar) || !Array.isArray(arCaps)) return null;
    let cap = null;
    for (const c of arCaps) if (ar >= c.ar && (cap == null || c.rarity > cap)) cap = c.rarity;
    return cap;
  }

  function addMats(into, mats, mult) {
    for (const [k, v] of Object.entries(mats || {})) into[k] = (into[k] || 0) + v * (mult || 1);
    return into;
  }

  function pieceMaterials(piece, cap, includeUpgrades) {
    const m = addMats({}, piece.materials);
    if (includeUpgrades && Array.isArray(piece.upgrades)) {
      for (const u of piece.upgrades) if (cap == null || u.toRarity <= cap) addMats(m, u.materials);
    }
    return m;
  }

  function tiersReached(tiers, count) {
    let n = 0;
    for (const t of tiers || []) if (count >= t.pieces) n++;
    return n;
  }

  function setSkillIndex(db) {
    const map = new Map();
    for (const s of db.setSkills || []) {
      map.set(s.name, { ...s, tiers: [...(s.tiers || [])].sort((a, b) => a.pieces - b.pieces) });
    }
    return map;
  }

  function usable(piece, cap, excluded) {
    if (excluded && excluded.has(piece.id)) return false;
    if (cap != null && Number.isFinite(piece.rarity) && piece.rarity > cap) return false;
    return true;
  }

  /**
   * Find the top-N armor combinations.
   * opts.targets: [{ name, kind: 'skill'|'set', level (number|null = as high as possible), weight }]
   * opts.weaponSkills: { skillName: level } — added before armor.
   */
  function optimize(db, opts) {
    const {
      targets = [],
      cap = null,
      weaponSkills = {},
      owned = new Set(),
      excluded = new Set(),
      topN = 20,
      preferOwned = false,
      includeUpgrades = false,
      nodeLimit = 5e6,
    } = opts || {};

    const sets = setSkillIndex(db);
    const skillT = targets.filter(t => t.kind !== 'set');
    const setT = targets.filter(t => t.kind === 'set');
    const tLevel = t => (t.level == null || t.level === '' ? Infinity : Number(t.level));
    // Levels above a skill's max (or a set skill's tier count) add nothing, so cap them.
    const maxLv = new Map((db.skills || []).filter(s => Number.isFinite(s.maxLevel)).map(s => [s.name, s.maxLevel]));
    const skillTargets = skillT.map(t => ({
      name: t.name, level: Math.min(tLevel(t), maxLv.get(t.name) ?? Infinity), weight: Number(t.weight) || 1,
    }));
    const setTargets = setT.map(t => {
      const tiers = sets.get(t.name)?.tiers || [];
      return { name: t.name, level: Math.min(tLevel(t), tiers.length || Infinity), weight: Number(t.weight) || 1, tiers };
    });
    const warnings = [];
    for (const s of setTargets) if (!s.tiers.length) warnings.push(`套裝技能「${s.name}」冇件數門檻數據，計唔到。`);

    const nS = skillTargets.length, nT = setTargets.length;
    const setIdx = new Map(setTargets.map((s, i) => [s.name, i]));

    // Build per-slot candidates.
    const slots = PARTS.map(part => {
      const raw = (db.armor || []).filter(p => normPart(p.part) === part && usable(p, cap, excluded));
      const cands = raw.map(p => ({
        piece: p,
        vec: skillTargets.map(t => Number(p.skills?.[t.name]) || 0),
        set: setIdx.has(p.setSkill) ? setIdx.get(p.setSkill) : -1,
        def: Math.max(0, Number(p.defense) || 0),
        owned: preferOwned && owned.has(p.id) ? 1 : 0,
      }));
      const relevant = cands.filter(c => c.set >= 0 || c.vec.some(v => v > 0));
      const others = cands.filter(c => !(c.set >= 0 || c.vec.some(v => v > 0)));
      // Filler: best non-contributing piece (by owned, then defense) + empty slot.
      others.sort((a, b) => (b.owned - a.owned) || (b.def - a.def));
      const pool = relevant.concat(others.slice(0, 1));
      pool.push({ piece: null, vec: skillTargets.map(() => 0), set: -1, def: 0, owned: 0 });
      // Drop strictly dominated candidates.
      const kept = pool.filter((a, i) => !pool.some((b, j) => j !== i && dominates(b, a)));
      kept.sort((a, b) => optimistic(b) - optimistic(a));
      return { part, cands: kept, total: raw.length };
    });

    function dominates(b, a) {
      if (a.set >= 0 && b.set !== a.set) return false;
      let strict = false;
      for (let i = 0; i < nS; i++) {
        if (b.vec[i] < a.vec[i]) return false;
        if (b.vec[i] > a.vec[i]) strict = true;
      }
      if (b.def < a.def || b.owned < a.owned) return false;
      if (b.def > a.def || b.owned > a.owned || (b.set >= 0 && a.set < 0)) strict = true;
      return strict;
    }
    function optimistic(c) {
      let s = 0;
      for (let i = 0; i < nS; i++) s += c.vec[i] * skillTargets[i].weight;
      if (c.set >= 0) s += setTargets[c.set].weight;
      return s * SKILL_UNIT + c.owned * OWNED_UNIT + c.def;
    }

    // Suffix maxima for the upper bound.
    const L = slots.length;
    const remSkill = Array.from({ length: L + 1 }, () => new Array(nS).fill(0));
    const remSet = Array.from({ length: L + 1 }, () => new Array(nT).fill(0));
    const remDef = new Array(L + 1).fill(0);
    const remOwned = new Array(L + 1).fill(0);
    for (let d = L - 1; d >= 0; d--) {
      const cs = slots[d].cands;
      for (let i = 0; i < nS; i++) remSkill[d][i] = remSkill[d + 1][i] + Math.max(...cs.map(c => c.vec[i]));
      for (let s = 0; s < nT; s++) remSet[d][s] = remSet[d + 1][s] + (cs.some(c => c.set === s) ? 1 : 0);
      remDef[d] = remDef[d + 1] + Math.max(...cs.map(c => c.def));
      remOwned[d] = remOwned[d + 1] + Math.max(...cs.map(c => c.owned));
    }

    const base = skillTargets.map(t => Number(weaponSkills[t.name]) || 0);
    const have = base.slice();
    const setCount = new Array(nT).fill(0);
    const pick = new Array(L);
    let def = 0, ownedN = 0, nodes = 0, truncated = false;
    const best = []; // sorted desc by score

    function skillScore(extraSkill, extraSet) {
      let s = 0;
      for (let i = 0; i < nS; i++) {
        const t = skillTargets[i];
        s += t.weight * Math.min(t.level, have[i] + (extraSkill ? extraSkill[i] : 0));
      }
      for (let k = 0; k < nT; k++) {
        const t = setTargets[k];
        s += t.weight * Math.min(t.level, tiersReached(t.tiers, setCount[k] + (extraSet ? extraSet[k] : 0)));
      }
      return s;
    }
    function threshold() {
      return best.length < topN ? -Infinity : best[best.length - 1].score;
    }

    function dfs(d) {
      if (++nodes > nodeLimit) { truncated = true; return; }
      if (d === L) {
        const ss = skillScore(null, null);
        const score = ss * SKILL_UNIT + ownedN * OWNED_UNIT + Math.min(def, DEF_CAP);
        if (score <= threshold()) return;
        best.push({ score, skillScore: ss, pieces: pick.map(c => c.piece) });
        best.sort((a, b) => b.score - a.score);
        if (best.length > topN) best.pop();
        return;
      }
      const bound = skillScore(remSkill[d], remSet[d]) * SKILL_UNIT
        + (ownedN + remOwned[d]) * OWNED_UNIT + Math.min(def + remDef[d], DEF_CAP);
      if (bound <= threshold()) return;
      for (const c of slots[d].cands) {
        for (let i = 0; i < nS; i++) have[i] += c.vec[i];
        if (c.set >= 0) setCount[c.set]++;
        def += c.def; ownedN += c.owned; pick[d] = c;
        dfs(d + 1);
        for (let i = 0; i < nS; i++) have[i] -= c.vec[i];
        if (c.set >= 0) setCount[c.set]--;
        def -= c.def; ownedN -= c.owned;
        if (truncated) return;
      }
    }
    dfs(0);

    const maxScore = skillTargets.reduce((s, t) => s + (Number.isFinite(t.level) ? t.weight * t.level : 0), 0)
      + setTargets.reduce((s, t) => s + (Number.isFinite(t.level) ? t.weight * t.level : 0), 0);

    const results = best.map((r, i) => describe(db, r.pieces, {
      rank: i + 1, weaponSkills, targets: skillTargets, setTargets, sets, owned, cap, includeUpgrades,
      skillScore: r.skillScore,
    }));

    return {
      results, warnings, truncated, nodes, maxScore,
      slots: slots.map(s => ({ part: s.part, candidates: s.cands.filter(c => c.piece).length, total: s.total })),
    };
  }

  function describe(db, pieces, ctx) {
    const skills = { ...Object.fromEntries(Object.entries(ctx.weaponSkills || {}).map(([k, v]) => [k, Number(v) || 0])) };
    const setCounts = {};
    let defense = 0;
    const materials = {};
    const ownedPieces = [];
    for (const p of pieces) {
      if (!p) continue;
      for (const [k, v] of Object.entries(p.skills || {})) skills[k] = (skills[k] || 0) + (Number(v) || 0);
      if (p.setSkill) setCounts[p.setSkill] = (setCounts[p.setSkill] || 0) + 1;
      defense += Number(p.defense) || 0;
      if (ctx.owned && ctx.owned.has(p.id)) ownedPieces.push(p.id);
      else addMats(materials, pieceMaterials(p, ctx.cap, ctx.includeUpgrades));
    }
    const maxLv = new Map((db.skills || []).map(s => [s.name, s.maxLevel]));
    const skillList = Object.entries(skills)
      .filter(([, v]) => v > 0)
      .map(([name, level]) => {
        const max = maxLv.get(name);
        return { name, level, max: max ?? null, effective: max != null ? Math.min(level, max) : level };
      })
      .sort((a, b) => b.level - a.level || a.name.localeCompare(b.name));
    const setList = Object.entries(setCounts).map(([name, count]) => {
      const info = ctx.sets.get(name);
      const tiers = info?.tiers || [];
      return {
        name, count, tiers,
        active: tiers.filter(t => count >= t.pieces),
        next: tiers.find(t => count < t.pieces) || null,
      };
    }).sort((a, b) => b.count - a.count);
    const missing = [];
    for (const t of ctx.targets) {
      const got = skills[t.name] || 0;
      if (Number.isFinite(t.level) && got < t.level) missing.push({ name: t.name, have: got, want: t.level });
    }
    for (const t of ctx.setTargets) {
      const got = tiersReached(t.tiers, setCounts[t.name] || 0);
      if (Number.isFinite(t.level) && got < t.level) missing.push({ name: t.name, have: got, want: t.level, set: true });
    }
    return {
      rank: ctx.rank,
      pieces: PARTS.map((part, i) => ({ part, piece: pieces[i] || null })),
      skills: skillList,
      sets: setList,
      defense,
      materials: Object.entries(materials).map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name)),
      ownedPieces,
      missing,
      skillScore: ctx.skillScore,
    };
  }

  // ---------- Import helpers ----------

  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
        } else field += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some(f => f.trim() !== '')) rows.push(row);
        row = [];
      } else field += ch;
    }
    row.push(field);
    if (row.some(f => f.trim() !== '')) rows.push(row);
    return rows;
  }

  // "Flash Draw:2; Attack Boost 1" / "Rathalos Scale x2 | Hunter's Jade I×1"
  function parseKV(s) {
    const out = {};
    if (!s) return out;
    for (const part of String(s).split(/[;|\n]/)) {
      const t = part.trim();
      if (!t) continue;
      const m = t.match(/^(.*\S)\s*[:：=×*]\s*(\d+)$/)
        || t.match(/^(.*\S)\s+x\s*(\d+)$/i)
        || t.match(/^(.*\S)\s+(\d+)$/);
      if (m) out[m[1].trim()] = (out[m[1].trim()] || 0) + Number(m[2]);
      else out[t] = (out[t] || 0) + 1;
    }
    return out;
  }

  const CSV_COLS = ['name', 'set', 'part', 'rarity', 'defense', 'skills', 'set_skill', 'materials'];

  function armorFromCSV(text) {
    const rows = parseCSV(text.replace(/^﻿/, ''));
    if (!rows.length) return { armor: [], errors: ['CSV 係空嘅'] };
    const head = rows[0].map(h => h.trim().toLowerCase());
    const col = n => head.indexOf(n);
    const missingCols = ['name', 'part'].filter(c => col(c) < 0);
    if (missingCols.length) return { armor: [], errors: [`CSV 缺少欄位：${missingCols.join(', ')}`] };
    const armor = [], errors = [];
    rows.slice(1).forEach((r, i) => {
      const get = n => (col(n) >= 0 ? (r[col(n)] || '').trim() : '');
      const part = normPart(get('part'));
      if (!get('name')) { errors.push(`第 ${i + 2} 行：冇名`); return; }
      if (!part) { errors.push(`第 ${i + 2} 行：部位「${get('part')}」唔識`); return; }
      armor.push(cleanPiece({
        name: get('name'), set: get('set'), part,
        rarity: get('rarity') === '' ? null : Number(get('rarity')),
        defense: get('defense') === '' ? null : Number(get('defense')),
        skills: parseKV(get('skills')),
        setSkill: get('set_skill') || null,
        materials: parseKV(get('materials')),
      }));
    });
    return { armor, errors };
  }

  function slug(s) {
    return String(s).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  }

  function cleanPiece(p) {
    const part = normPart(p.part);
    return {
      id: p.id || `${slug(p.set || p.name)}-${part}-${slug(p.name)}`,
      name: String(p.name || '').trim(),
      set: p.set ? String(p.set).trim() : '',
      part,
      rarity: Number.isFinite(Number(p.rarity)) && p.rarity !== null && p.rarity !== '' ? Number(p.rarity) : null,
      defense: Number.isFinite(Number(p.defense)) && p.defense !== null && p.defense !== '' ? Number(p.defense) : null,
      skills: p.skills || {},
      setSkill: p.setSkill || null,
      materials: p.materials || {},
      ...(Array.isArray(p.upgrades) ? { upgrades: p.upgrades } : {}),
    };
  }

  // Validate & normalise a full JSON database. Returns { db, errors }.
  function normalizeDB(raw) {
    const errors = [];
    if (!raw || typeof raw !== 'object') return { db: null, errors: ['唔係有效嘅 JSON 物件'] };
    const armor = [];
    (raw.armor || []).forEach((p, i) => {
      if (!p || !p.name) { errors.push(`armor[${i}]：冇 name`); return; }
      if (!normPart(p.part)) { errors.push(`armor[${i}]（${p.name}）：part「${p.part}」唔識`); return; }
      armor.push(cleanPiece(p));
    });
    const ids = new Set();
    for (const p of armor) {
      if (ids.has(p.id)) { errors.push(`重複 id：${p.id}`); }
      ids.add(p.id);
    }
    const db = {
      meta: raw.meta || {},
      arCaps: Array.isArray(raw.arCaps) ? raw.arCaps.filter(c => Number.isFinite(c.ar) && Number.isFinite(c.rarity)) : [],
      skills: Array.isArray(raw.skills) ? raw.skills.filter(s => s && s.name) : [],
      setSkills: Array.isArray(raw.setSkills) ? raw.setSkills.filter(s => s && s.name) : [],
      weapons: Array.isArray(raw.weapons) ? raw.weapons.filter(w => w && w.name) : [],
      armor,
    };
    return { db, errors };
  }

  return {
    PARTS, PART_LABEL, WEAPON_TYPES, CSV_COLS,
    normPart, maxRarityForAR, optimize, tiersReached,
    parseCSV, parseKV, armorFromCSV, normalizeDB, pieceMaterials,
  };
});
