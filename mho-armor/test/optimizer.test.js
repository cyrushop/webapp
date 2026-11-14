// Run: node --test mho-armor/test/
// Uses a SYNTHETIC fixture (random names/numbers) only to check the search
// against brute force. It is not game data.
const test = require('node:test');
const assert = require('node:assert');
const M = require('../optimizer.js');

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function fixture(seed) {
  const r = rng(seed);
  const skillNames = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
  const setNames = ['SetA', 'SetB', 'SetC'];
  const armor = [];
  for (const part of M.PARTS) {
    for (let i = 0; i < 7; i++) {
      const skills = {};
      const k = 1 + Math.floor(r() * 2);
      for (let j = 0; j < k; j++) skills[skillNames[Math.floor(r() * skillNames.length)]] = 1 + Math.floor(r() * 2);
      armor.push({
        id: `${part}-${i}`, name: `${part} ${i}`, set: `X${i}`, part,
        rarity: 1 + Math.floor(r() * 6), defense: 10 + Math.floor(r() * 40),
        skills, setSkill: r() < 0.5 ? setNames[Math.floor(r() * setNames.length)] : null,
        materials: { [`Mat${i}`]: 1 + Math.floor(r() * 3) },
      });
    }
  }
  return {
    armor,
    skills: skillNames.map(n => ({ name: n, maxLevel: 5 })),
    setSkills: [
      { name: 'SetA', tiers: [{ pieces: 2, effect: 'a2' }, { pieces: 4, effect: 'a4' }] },
      { name: 'SetB', tiers: [{ pieces: 3, effect: 'b3' }] },
      { name: 'SetC', tiers: [{ pieces: 2, effect: 'c2' }] },
    ],
  };
}

function brute(db, targets, cap, weaponSkills, owned, preferOwned) {
  const tl = t => Math.min(t.level == null ? Infinity : t.level,
    t.kind === 'set' ? db.setSkills.find(s => s.name === t.name).tiers.length : 5);
  const slots = M.PARTS.map(p => [null, ...db.armor.filter(a => a.part === p && (cap == null || a.rarity <= cap))]);
  const scores = [];
  const tiersOf = n => db.setSkills.find(s => s.name === n).tiers;
  (function rec(d, pick) {
    if (d === slots.length) {
      const sk = { ...weaponSkills }, sc = {};
      let def = 0, own = 0;
      for (const p of pick) {
        if (!p) continue;
        for (const [k, v] of Object.entries(p.skills)) sk[k] = (sk[k] || 0) + v;
        if (p.setSkill) sc[p.setSkill] = (sc[p.setSkill] || 0) + 1;
        def += p.defense;
        if (preferOwned && owned.has(p.id)) own++;
      }
      let s = 0;
      for (const t of targets) {
        const w = t.weight;
        if (t.kind === 'set') s += w * Math.min(tl(t), M.tiersReached(tiersOf(t.name), sc[t.name] || 0));
        else s += w * Math.min(tl(t), sk[t.name] || 0);
      }
      scores.push(s * 1e8 + own * 1e6 + def);
      return;
    }
    for (const c of slots[d]) rec(d + 1, [...pick, c]);
  })(0, []);
  return scores.sort((a, b) => b - a);
}

test('top-1 matches brute force on random fixtures', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const db = fixture(seed);
    const r = rng(seed * 7);
    const targets = [
      { name: 'S1', kind: 'skill', level: 1 + Math.floor(r() * 4), weight: 3 },
      { name: 'S2', kind: 'skill', level: r() < 0.3 ? null : 2, weight: 2 },
      { name: 'S3', kind: 'skill', level: 3, weight: 1 },
      { name: 'SetA', kind: 'set', level: 2, weight: 2 },
    ];
    const cap = r() < 0.5 ? null : 4;
    const owned = new Set(db.armor.filter(() => r() < 0.2).map(a => a.id));
    const preferOwned = seed % 2 === 0;
    const weaponSkills = { S3: 1 };
    const out = M.optimize(db, { targets, cap, weaponSkills, owned, preferOwned, topN: 5 });
    const exp = brute(db, targets, cap, weaponSkills, owned, preferOwned);
    assert.ok(!out.truncated);
    assert.ok(out.results.length > 0);
    // Recompute the found build's score independently from its description.
    const res = out.results[0];
    let s = 0;
    for (const t of targets) {
      if (t.kind === 'set') {
        const st = res.sets.find(x => x.name === t.name);
        s += t.weight * Math.min(t.level ?? Infinity, st ? st.active.length : 0);
      } else {
        const sk = res.skills.find(x => x.name === t.name);
        s += t.weight * Math.min(t.level ?? 5, sk ? sk.level : 0);
      }
    }
    const own = preferOwned ? res.pieces.filter(p => p.piece && owned.has(p.piece.id)).length : 0;
    const got = s * 1e8 + own * 1e6 + res.defense;
    assert.strictEqual(got, exp[0], `seed ${seed}`);
    for (const p of res.pieces) if (p.piece && cap != null) assert.ok(p.piece.rarity <= cap);
  }
});

test('materials exclude owned pieces and sum quantities', () => {
  const db = {
    armor: [
      { id: 'h', name: 'H', part: 'head', defense: 1, skills: { A: 1 }, materials: { Scale: 2, Jade: 1 } },
      { id: 'c', name: 'C', part: 'chest', defense: 1, skills: { A: 1 }, materials: { Scale: 3 } },
    ],
  };
  const out = M.optimize(db, { targets: [{ name: 'A', level: 2, weight: 1 }], owned: new Set(['c']) });
  const mats = Object.fromEntries(out.results[0].materials.map(m => [m.name, m.qty]));
  assert.deepStrictEqual(mats, { Scale: 2, Jade: 1 });
  assert.deepStrictEqual(out.results[0].missing, []);
});

test('AR cap lookup', () => {
  const caps = [{ ar: 16, rarity: 3 }, { ar: 21, rarity: 5 }, { ar: 41, rarity: 9 }, { ar: 47, rarity: 11 }];
  assert.strictEqual(M.maxRarityForAR(10, caps), null);
  assert.strictEqual(M.maxRarityForAR(16, caps), 3);
  assert.strictEqual(M.maxRarityForAR(30, caps), 5);
  assert.strictEqual(M.maxRarityForAR(60, caps), 11);
});

test('CSV + KV parsing', () => {
  assert.deepStrictEqual(M.parseKV("Rathalos Max 2; Hunter's Jade I×1 | Bone x3; Ore"),
    { 'Rathalos Max': 2, "Hunter's Jade I": 1, Bone: 3, Ore: 1 });
  const { armor, errors } = M.armorFromCSV(
    'name,set,part,rarity,defense,skills,set_skill,materials\n"Helm, A",Set,頭,3,20,"Flash Draw:2",SS,"Scale:2;Jade:1"\nBad,Set,nose,1,1,,,\n');
  assert.strictEqual(armor.length, 1);
  assert.strictEqual(armor[0].name, 'Helm, A');
  assert.strictEqual(armor[0].part, 'head');
  assert.deepStrictEqual(armor[0].skills, { 'Flash Draw': 2 });
  assert.strictEqual(errors.length, 1);
});
