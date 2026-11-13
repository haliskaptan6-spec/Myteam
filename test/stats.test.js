// Çalıştırma: node --test
const test = require('node:test');
const assert = require('node:assert');
const S = require('../js/stats.js');
require('../js/data.js');
const { teams, players, matches, rallies, actions } = globalThis.SCOUT;

test('skillStats: elle hesaplanan hücum örneği', () => {
  const a = ['#', '#', '#', '+', '-', '/', '=', '!'].map((ev) => ({ skill: 'A', ev }));
  const s = S.skillStats(a, 'A');
  assert.equal(s.n, 8);
  assert.equal(s.err, 2);
  assert.equal(s.perfect, 37.5);
  assert.equal(s.positive, 50);
  assert.equal(s.eff, 12.5); // (3 - 2) / 8
  assert.equal(S.skillStats([], 'A').eff, null);
});

test('points: sideout ve break ayrımı', () => {
  const p = S.points([
    { skill: 'A', ev: '#', phase: 'SO' }, { skill: 'S', ev: '#', phase: 'BP' },
    { skill: 'B', ev: '#', phase: 'BP' }, { skill: 'D', ev: '#', phase: 'BP' }, { skill: 'A', ev: '+', phase: 'SO' },
  ]);
  assert.deepEqual(p, { total: 3, so: 1, bp: 2 });
});

test('rallyStats: bir takımın sideout kazancı rakibin break kaybıdır', () => {
  const m = matches[0];
  const rs = rallies.filter((r) => r.m === m.id);
  const h = S.rallyStats(rs, m.home), a = S.rallyStats(rs, m.away);
  assert.equal(h.recv, a.serve);
  assert.equal(h.soWon + a.bpWon, h.recv);
  assert.equal(a.soWon + h.bpWon, a.recv);
});

test('örnek veri tutarlı', () => {
  assert.equal(teams.length, 6);
  assert.equal(matches.length, 30);
  assert.ok(matches.every((m) => Math.max(m.setsHome, m.setsAway) === 3));
  // Her servis ası break fazındadır, her karşılama sideout fazındadır.
  assert.ok(actions.every((a) => a.skill !== 'S' || a.phase === 'BP'));
  assert.ok(actions.every((a) => a.skill !== 'R' || a.phase === 'SO'));
  assert.ok(actions.every((a) => players[a.player].team === a.team));
  // Lig geneli sideout oranı gerçekçi aralıkta.
  const so = rallies.filter((r) => r.winner === r.recv).length / rallies.length;
  assert.ok(so > 0.5 && so < 0.75, 'sideout ' + so);
});
