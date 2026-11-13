// Scout aksiyonlarından istatistik hesapları. Arayüzden bağımsızdır.
(function (root) {
  const SKILLS = [
    { id: 'S', name: 'Servis' }, { id: 'R', name: 'Karşılama' }, { id: 'E', name: 'Pas' },
    { id: 'A', name: 'Hücum' }, { id: 'B', name: 'Blok' }, { id: 'D', name: 'Savunma' },
  ];
  const EVALS = ['#', '+', '!', '-', '/', '='];
  const pct = (a, n) => (n ? (100 * a) / n : null);

  // Bir beceri için adetler ve yüzdeler. Hata: '=' (hücumda '/' bloklanan top da hatadır).
  // Verim = (# − hata) / toplam.
  function skillStats(actions, skill) {
    const c = { '#': 0, '+': 0, '!': 0, '-': 0, '/': 0, '=': 0 };
    let n = 0;
    for (const a of actions) if (a.skill === skill) { c[a.ev]++; n++; }
    const err = c['='] + (skill === 'A' ? c['/'] : 0);
    return { n, c, err, perfect: pct(c['#'], n), positive: pct(c['#'] + c['+'], n), error: pct(err, n), eff: pct(c['#'] - err, n) };
  }

  // Oyuncunun/takımın doğrudan kazandırdığı sayılar: servis ası, hücum sayısı, blok sayısı.
  // so: takım servis karşılarken, bp: takım servis atarken.
  function points(actions) {
    const p = { total: 0, so: 0, bp: 0 };
    for (const a of actions) {
      if (a.ev !== '#' || !'SAB'.includes(a.skill)) continue;
      p.total++;
      if (a.phase === 'SO') p.so++; else p.bp++;
    }
    return p;
  }

  // Takımın ralli bazlı sideout ve break yüzdeleri.
  function rallyStats(rallies, team) {
    let recv = 0, soWon = 0, serve = 0, bpWon = 0;
    for (const r of rallies) {
      if (r.recv === team) { recv++; if (r.winner === team) soWon++; }
      else if (r.serve === team) { serve++; if (r.winner === team) bpWon++; }
    }
    return { recv, soWon, serve, bpWon, so: pct(soWon, recv), bp: pct(bpWon, serve) };
  }

  function setsPlayed(items) {
    const s = new Set();
    for (const x of items) s.add(x.m + ':' + x.set);
    return s.size;
  }

  function summary(actions) {
    const skills = {};
    for (const s of SKILLS) skills[s.id] = skillStats(actions, s.id);
    return { sets: setsPlayed(actions), pts: points(actions), skills };
  }

  // value'nun values içindeki yüzdelik sırası (0-100). null ise null.
  function percentile(values, value) {
    const v = values.filter((x) => x != null);
    if (value == null || !v.length) return null;
    return (100 * v.filter((x) => x <= value).length) / v.length;
  }

  const api = { SKILLS, EVALS, skillStats, points, rallyStats, setsPlayed, summary, percentile };
  if (typeof module !== 'undefined') module.exports = api;
  root.STATS = api;
})(typeof window !== 'undefined' ? window : globalThis);
