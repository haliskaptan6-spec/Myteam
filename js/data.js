// Örnek scout verisi. Gerçek scoutlar bağlandığında bu dosyanın ürettiği
// { teams, players, matches, rallies, actions } yapısı aynı kalmalı.
//   action: { m, set, r, team, player, skill, ev, phase }
//   skill : S servis, R karşılama, E pas, A hücum, B blok, D savunma
//   ev    : # + ! - / =      phase: SO (sideout) | BP (break)
//   rally : { m, set, r, serve, recv, winner }
(function (root) {
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rnd = mulberry32(20261113);
  const clamp = (v) => Math.max(0.05, Math.min(0.95, v));
  function pick(items, weights) {
    let x = rnd() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < items.length; i++) { x -= weights[i]; if (x < 0) return items[i]; }
    return items[items.length - 1];
  }

  const TEAM_DEFS = [
    ['Kartal SK', 'KAR', 0.7], ['Poyraz Voleybol', 'POY', 0.62], ['Marmara Spor', 'MAR', 0.55],
    ['Ege Yıldızları', 'EGE', 0.5], ['Anadolu Gücü', 'ANA', 0.45], ['Başkent Akademi', 'BAŞ', 0.38],
  ];
  const FIRST = ['Elif', 'Zeynep', 'Defne', 'Ada', 'Ebrar', 'Hande', 'Cansu', 'Simge', 'Melis', 'İlkin', 'Derya', 'Saliha', 'Aslı', 'Yasemin', 'Buse', 'Ceren', 'Tuğba', 'Gizem', 'Beyza', 'Nil', 'Selin', 'Meryem', 'İrem', 'Duru'];
  const LAST = ['Yılmaz', 'Kaya', 'Demir', 'Şahin', 'Çelik', 'Aydın', 'Arslan', 'Doğan', 'Kılıç', 'Aslan', 'Çetin', 'Koç', 'Kurt', 'Özkan', 'Polat', 'Erdem', 'Güneş', 'Bulut', 'Aksoy', 'Tekin'];
  const ROLES = [
    ['S', 'Pasör'], ['OH1', 'Smaçör'], ['MB1', 'Orta Oyuncu'], ['OPP', 'Pasör Çaprazı'],
    ['OH2', 'Smaçör'], ['MB2', 'Orta Oyuncu'], ['L', 'Libero'],
  ];

  const teams = [], players = [], matches = [], rallies = [], actions = [];
  const roster = {}; // teamId -> { role: player }
  TEAM_DEFS.forEach(([name, code, strength], t) => {
    teams.push({ id: t, name, code });
    roster[t] = {};
    ROLES.forEach(([role, pos], i) => {
      const rt = {};
      for (const k of 'SREABD') rt[k] = clamp(strength + (rnd() - 0.5) * 0.35);
      const p = {
        id: players.length, team: t, no: i * 2 + 1 + Math.floor(rnd() * 2), pos,
        name: FIRST[players.length % FIRST.length] + ' ' + LAST[(players.length * 7 + t) % LAST.length],
      };
      players.push(p);
      roster[t][role] = { p, rt };
    });
  });

  let ctx; // { m, set, r, serve }
  function log(team, pl, skill, ev) {
    actions.push({ m: ctx.m, set: ctx.set, r: ctx.r, team, player: pl.p.id, skill, ev, phase: team === ctx.serve ? 'BP' : 'SO' });
  }

  // Top oyundayken: att hücum eder, def savunur. Kazanan takımı döndürür.
  function attackLoop(att, def, q, viaSet) {
    for (let i = 0; i < 8; i++) {
      const A = roster[att], D = roster[def];
      if (viaSet) {
        const se = A.S.rt.E;
        if (rnd() < 0.01) { log(att, A.S, 'E', '='); return def; }
        log(att, A.S, 'E', q >= 0.7 ? (rnd() < 0.3 + 0.5 * se ? '#' : '+') : q >= 0.5 ? (rnd() < se ? '+' : '!') : (rnd() < se ? '!' : '-'));
      }
      const mid = q >= 0.7 ? 0.6 : 0.08;
      const hitter = viaSet ? pick([A.OH1, A.OH2, A.OPP, A.MB1, A.MB2], [1, 1, 1.1, mid, mid]) : pick([A.MB1, A.MB2, A.OH1], [1, 1, 1]);
      const blocker = pick([D.MB1, D.MB2, D.OH1, D.OPP], [1.4, 1.4, 1, 1]);
      const ar = hitter.rt.A;
      const x = rnd();
      const pKill = 0.22 + 0.28 * ar + 0.14 * (q - 0.5), pErr = 0.1 - 0.05 * ar, pBlk = 0.04 + 0.08 * blocker.rt.B;
      const digger = pick([D.L, D.OH1, D.OH2, D.S, D.OPP], [2, 1, 1, 0.7, 0.7]);
      if (x < pKill) {
        log(att, hitter, 'A', '#');
        if (rnd() < 0.5) log(def, digger, 'D', '=');
        return att;
      }
      if (x < pKill + pErr) { log(att, hitter, 'A', '='); return def; }
      if (x < pKill + pErr + pBlk) { log(att, hitter, 'A', '/'); log(def, blocker, 'B', '#'); return def; }
      log(att, hitter, 'A', pick(['+', '!', '-'], [0.3, 0.2, 0.5]));
      if (rnd() < 0.3) log(def, blocker, 'B', rnd() < 0.7 ? '+' : '-');
      const dr = digger.rt.D;
      const dv = pick(['#', '+', '-'], [0.15 + 0.3 * dr, 0.35, 0.5 - 0.3 * dr]);
      log(def, digger, 'D', dv);
      q = { '#': 1, '+': 0.7, '-': 0.3 }[dv];
      [att, def] = [def, att];
      viaSet = true;
    }
    log(att, roster[att].OPP, 'A', '#');
    return att;
  }

  function playRally(sT, rT, server) {
    const R = roster[rT], sr = server.rt.S;
    const recv = pick([R.OH1, R.OH2, R.L], [1, 1, 1.3]);
    const rr = recv.rt.R;
    const sv = pick(['#', '=', '+', '!', '-'], [0.03 + 0.07 * sr, 0.14 - 0.06 * sr, 0.15 + 0.15 * sr, 0.25, 0.43 - 0.16 * sr]);
    log(sT, server, 'S', sv);
    if (sv === '#') { log(rT, recv, 'R', '='); return sT; }
    if (sv === '=') return rT;
    let rv;
    if (sv === '+') rv = rnd() < 0.25 - 0.15 * rr ? '/' : '-';
    else if (sv === '!') rv = rnd() < 0.6 - 0.3 * rr ? '!' : '+';
    else rv = rnd() < 0.35 + 0.4 * rr ? '#' : '+';
    log(rT, recv, 'R', rv);
    if (rv === '/') return attackLoop(sT, rT, 0.9, false);
    return attackLoop(rT, sT, { '#': 1, '+': 0.75, '!': 0.5, '-': 0.25 }[rv], true);
  }

  const ORDER = ['S', 'OH1', 'MB1', 'OPP', 'OH2', 'MB2'];
  function playMatch(m) {
    const side = [m.home, m.away], rot = [0, 0], sets = [0, 0];
    let r = 0;
    for (let set = 1; sets[0] < 3 && sets[1] < 3; set++) {
      const target = set === 5 ? 15 : 25, sc = [0, 0];
      let srv = (set + 1) % 2;
      while (Math.max(sc[0], sc[1]) < target || Math.abs(sc[0] - sc[1]) < 2) {
        ctx = { m: m.id, set, r: r++, serve: side[srv] };
        const winner = playRally(side[srv], side[1 - srv], roster[side[srv]][ORDER[rot[srv] % 6]]);
        rallies.push({ m: m.id, set, r: ctx.r, serve: side[srv], recv: side[1 - srv], winner });
        const w = winner === side[0] ? 0 : 1;
        sc[w]++;
        if (w !== srv) { srv = w; rot[w]++; }
      }
      sets[sc[0] > sc[1] ? 0 : 1]++;
    }
    m.setsHome = sets[0]; m.setsAway = sets[1];
  }

  // Çift devreli lig (10 hafta)
  const ids = teams.map((t) => t.id);
  for (let leg = 0; leg < 2; leg++) {
    const arr = ids.slice();
    for (let round = 0; round < ids.length - 1; round++) {
      for (let i = 0; i < ids.length / 2; i++) {
        const a = arr[i], b = arr[ids.length - 1 - i];
        const m = { id: matches.length, week: leg * (ids.length - 1) + round + 1, home: leg ? b : a, away: leg ? a : b };
        matches.push(m);
        playMatch(m);
      }
      arr.splice(1, 0, arr.pop());
    }
  }

  root.SCOUT = { teams, players, matches, rallies, actions };
})(typeof window !== 'undefined' ? window : globalThis);
