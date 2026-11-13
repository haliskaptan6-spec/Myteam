(function () {
  const { teams, players, matches, rallies, actions } = SCOUT;
  const { SKILLS, EVALS } = STATS;
  const $ = (id) => document.getElementById(id);
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const num = (v, d = 1) => (v == null ? '–' : v.toLocaleString('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const pc = (v) => (v == null ? '–' : num(v) + '%');
  const int = (v) => (v == null ? '–' : String(v));
  const EV_NAMES = { '#': '# Mükemmel / sayı', '+': '+ Pozitif', '!': '! Orta', '-': '− Zayıf', '/': '/ Çok zayıf / blok', '=': '= Hata' };
  const skillName = (id) => SKILLS.find((s) => s.id === id).name;

  const byPlayer = players.map(() => []), byTeam = teams.map(() => []);
  for (const a of actions) { byPlayer[a.player].push(a); byTeam[a.team].push(a); }
  const playerSum = players.map((p) => STATS.summary(byPlayer[p.id]));
  const teamMatches = (t) => matches.filter((m) => m.home === t || m.away === t).sort((a, b) => a.week - b.week);
  const opponent = (m, t) => teams[m.home === t ? m.away : m.home];
  const won = (m, t) => (m.home === t ? m.setsHome : m.setsAway) === 3;

  // Radar eksenleri: [ad, değer fonksiyonu]. Az aksiyonlu beceri değerlendirilmez (null).
  const AXES = [
    ['Sayı / set', (s) => (s.sets ? s.pts.total / s.sets : null)],
    ['Hücum verimi', (s) => (s.skills.A.n >= 30 ? s.skills.A.eff : null)],
    ['Servis pozitif %', (s) => (s.skills.S.n >= 30 ? s.skills.S.positive : null)],
    ['Karşılama pozitif %', (s) => (s.skills.R.n >= 30 ? s.skills.R.positive : null)],
    ['Blok sayı / set', (s) => (s.skills.B.n >= 15 ? s.skills.B.c['#'] / s.sets : null)],
    ['Savunma pozitif %', (s) => (s.skills.D.n >= 20 ? s.skills.D.positive : null)],
  ];
  const axisValues = AXES.map(([, f]) => playerSum.map(f));
  const profile = (pid) => AXES.map((_, i) => STATS.percentile(axisValues[i], axisValues[i][pid]) ?? 0);

  // ---------- grafik yardımcıları ----------
  Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  Chart.defaults.animation = false;
  Chart.defaults.responsive = true;
  Chart.defaults.maintainAspectRatio = false;

  const LABEL_FMT = { pct: (v) => num(v) + '%', num: (v) => num(v), pct0: (v) => num(v, 0) };
  const valueLabels = {
    id: 'valueLabels',
    afterDatasetsDraw(chart, _args, o) {
      const fmt = LABEL_FMT[o && o.kind];
      if (!fmt) return;
      const { ctx } = chart, horiz = chart.options.indexAxis === 'y';
      ctx.save();
      ctx.fillStyle = css('--text-2');
      ctx.font = '11px ' + Chart.defaults.font.family;
      chart.data.datasets.forEach((ds, di) => {
        chart.getDatasetMeta(di).data.forEach((el, i) => {
          const v = ds.data[i];
          if (v == null) return;
          const neg = v < 0;
          if (horiz) { ctx.textAlign = neg ? 'right' : 'left'; ctx.textBaseline = 'middle'; ctx.fillText(fmt(v), el.x + (neg ? -6 : 6), el.y); }
          else { ctx.textAlign = 'center'; ctx.textBaseline = neg ? 'top' : 'bottom'; ctx.fillText(fmt(v), el.x, el.y + (neg ? 4 : -4)); }
        });
      });
      ctx.restore();
    },
  };
  const charts = {};
  function draw(id, type, data, options) {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart($(id), { type, data, options, plugins: [valueLabels] });
  }
  const axis = (o) => Object.assign({ grid: { color: css('--grid') }, border: { color: css('--axis') }, ticks: { color: css('--muted') } }, o);
  const noGrid = (o) => axis(Object.assign({ grid: { display: false } }, o));
  const legend = (display) => ({ display, position: 'bottom', labels: { color: css('--text-2'), boxWidth: 10, boxHeight: 10 } });
  const bar = (label, data, color) => ({ label, data, backgroundColor: css(color), maxBarThickness: 24, borderRadius: 4 });
  const pctTicks = () => ({ color: css('--muted'), callback: (v) => v + "%" });
  const pctTooltip = { callbacks: { label: (c) => `${c.dataset.label}: ${pc(c.raw)}` } };

  function fill(sel, items, value) {
    sel.innerHTML = items.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
    if (value != null) sel.value = value;
  }
  const teamOpts = teams.map((t) => [t.id, t.name]);
  const playerOpts = (t) => players.filter((p) => p.team === +t).map((p) => [p.id, `${p.no} · ${p.name} (${p.pos})`]);
  const table = (el, head, rows) => {
    el.innerHTML = '<thead><tr>' + head.map((h) => `<th>${h}</th>`).join('') + '</tr></thead><tbody>' +
      rows.map((r) => `<tr${r.cls ? ` class="${r.cls}"` : ''}>` + r.cells.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody>';
  };

  // ---------- OYUNCU ANALİZİ ----------
  function renderPlayer() {
    const pid = +$('p-player').value, p = players[pid], s = playerSum[pid];
    const phase = $('p-phase').value, skill = $('p-skill').value;
    const acts = phase ? byPlayer[pid].filter((a) => a.phase === phase) : byPlayer[pid];
    const sk = {};
    for (const x of SKILLS) sk[x.id] = STATS.skillStats(acts, x.id);
    const A = s.skills.A, R = s.skills.R, S = s.skills.S, share = (v) => (s.pts.total ? `sayıların ${pc((100 * v) / s.pts.total)}` : '');

    $('p-tiles').innerHTML = [
      ['Toplam sayı', s.pts.total, `${num(s.sets ? s.pts.total / s.sets : null)} sayı/set · ${s.sets} set`],
      ['<i class="sw so"></i>Sideout sayısı', s.pts.so, share(s.pts.so)],
      ['<i class="sw bp"></i>Break sayısı', s.pts.bp, share(s.pts.bp)],
      ['Hücum verimi', pc(A.eff), `${A.c['#']} sayı / ${A.n} hücum`],
      ['Karşılama pozitif', pc(R.positive), `${R.n} karşılama`],
      ['Servis ası', S.c['#'], `${S.c['=']} hata / ${S.n} servis`],
    ].map(([l, v, d]) => `<div class="tile"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join('');

    draw('p-dist', 'bar', {
      labels: SKILLS.map((x) => `${x.name} (${sk[x.id].n})`),
      datasets: EVALS.map((ev, i) => ({
        label: EV_NAMES[ev], data: SKILLS.map((x) => (sk[x.id].n ? (100 * sk[x.id].c[ev]) / sk[x.id].n : 0)),
        counts: SKILLS.map((x) => sk[x.id].c[ev]),
        backgroundColor: css('--ev' + (i + 1)), borderColor: css('--surface'), borderWidth: { right: 2 }, maxBarThickness: 24,
      })),
    }, {
      indexAxis: 'y',
      scales: { x: axis({ stacked: true, max: 100, ticks: pctTicks() }), y: noGrid({ stacked: true, ticks: { color: css('--text-2') } }) },
      plugins: { legend: legend(true), tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.dataset.counts[c.dataIndex]} (${pc(c.raw)})` } } },
    });

    const ms = teamMatches(p.team), labels = ms.map((m) => `${m.week}. ${opponent(m, p.team).code}`);
    const perMatch = ms.map((m) => byPlayer[pid].filter((a) => a.m === m.id));
    const pts = perMatch.map((a) => STATS.points(a));
    draw('p-points', 'bar', {
      labels,
      datasets: [
        { label: 'Sideout', data: pts.map((x) => x.so), backgroundColor: css('--so'), borderColor: css('--surface'), borderWidth: { top: 2 }, maxBarThickness: 24 },
        { label: 'Break', data: pts.map((x) => x.bp), backgroundColor: css('--bp'), maxBarThickness: 24, borderRadius: 4 },
      ],
    }, {
      scales: { x: noGrid({ stacked: true }), y: axis({ stacked: true, beginAtZero: true, ticks: { color: css('--muted'), precision: 0 } }) },
      plugins: { legend: legend(true) },
    });

    table($('p-table'),
      ['Beceri', 'Toplam', ...EVALS.map((e) => (e === '-' ? '−' : e)), 'Mükemmel %', 'Pozitif %', 'Hata %', 'Verim %'],
      SKILLS.map((x) => {
        const k = sk[x.id];
        return { cls: x.id === skill ? 'sel' : '', cells: [x.name, k.n, ...EVALS.map((e) => k.c[e]), pc(k.perfect), pc(k.positive), pc(k.error), pc(k.eff)] };
      }));

    $('p-trend-title').textContent = `${skillName(skill)} verimi: maç maç` + (phase ? ` (${phase === 'SO' ? 'sideout' : 'break'})` : '');
    const trend = perMatch.map((a) => STATS.skillStats(phase ? a.filter((x) => x.phase === phase) : a, skill).eff);
    $('p-trend-sub').textContent = trend.some((v) => v != null)
      ? 'Maç bazında verim %; o maçta aksiyon yoksa nokta çizilmez'
      : 'Bu oyuncunun seçilen beceride ve fazda aksiyonu yok.';
    draw('p-trend', 'line', {
      labels,
      datasets: [{
        label: skillName(skill) + ' verimi',
        data: trend,
        borderColor: css('--a'), backgroundColor: css('--a'), borderWidth: 2, pointRadius: 5, pointHoverRadius: 7,
        pointBorderColor: css('--surface'), pointBorderWidth: 2,
      }],
    }, {
      scales: { x: noGrid({}), y: axis({ ticks: pctTicks() }) },
      plugins: { legend: legend(false), tooltip: pctTooltip },
      interaction: { mode: 'index', intersect: false },
    });
  }

  // ---------- OYUNCU KIYASLAMA ----------
  const PLAYER_ROWS = [ // [satır adı, değer, biçim, yüksek mi iyi (1) düşük mü (-1)]
    ['Oynadığı set', (s) => s.sets, int, 0],
    ['Toplam sayı', (s) => s.pts.total, int, 1],
    ['Sayı / set', (s) => (s.sets ? s.pts.total / s.sets : null), num, 1],
    ['Sideout sayısı', (s) => s.pts.so, int, 1],
    ['Break sayısı', (s) => s.pts.bp, int, 1],
    ['Servis ası', (s) => s.skills.S.c['#'], int, 1],
    ['Servis hata %', (s) => s.skills.S.error, pc, -1],
    ['Servis pozitif %', (s) => s.skills.S.positive, pc, 1],
    ['Karşılama mükemmel %', (s) => s.skills.R.perfect, pc, 1],
    ['Karşılama pozitif %', (s) => s.skills.R.positive, pc, 1],
    ['Hücum sayısı', (s) => s.skills.A.c['#'], int, 1],
    ['Hücum sayı %', (s) => s.skills.A.perfect, pc, 1],
    ['Hücum hata %', (s) => s.skills.A.error, pc, -1],
    ['Hücum verim %', (s) => s.skills.A.eff, pc, 1],
    ['Blok sayısı', (s) => s.skills.B.c['#'], int, 1],
    ['Savunma pozitif %', (s) => s.skills.D.positive, pc, 1],
  ];
  function compareRows(rows, a, b) {
    return rows.map(([label, f, fmt, dir]) => {
      const va = f(a), vb = f(b);
      const best = dir && va != null && vb != null && va !== vb ? ((va - vb) * dir > 0 ? 0 : 1) : -1;
      return { cells: [label, best === 0 ? `<b>${fmt(va)}</b>` : fmt(va), best === 1 ? `<b>${fmt(vb)}</b>` : fmt(vb)] };
    });
  }

  function renderCompare() {
    const ids = [+$('c-player-a').value, +$('c-player-b').value];
    const ss = ids.map((i) => playerSum[i]);
    const names = ids.map((i) => `${players[i].name} (${teams[players[i].team].code})`);
    const cols = ['--a', '--b'];

    draw('c-radar', 'radar', {
      labels: AXES.map((a) => a[0].split(/ (?=pozitif|verimi|sayı)/)), // dar ekranda sığması için iki satır
      datasets: ids.map((id, i) => ({
        label: names[i], data: profile(id), borderColor: css(cols[i]), backgroundColor: css(cols[i]) + '1a', borderWidth: 2,
        pointBackgroundColor: css(cols[i]), pointBorderColor: css('--surface'), pointBorderWidth: 2, pointRadius: 5,
      })),
    }, {
      scales: { r: { min: 0, max: 100, ticks: { stepSize: 25, color: css('--muted'), backdropColor: 'transparent' }, grid: { color: css('--grid') }, angleLines: { color: css('--grid') }, pointLabels: { color: css('--text-2'), font: { size: 12 } } } },
      plugins: { legend: legend(true), tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${num(c.raw, 0)}. yüzdelik` } } },
    });

    const perSet = (s, k) => (s.sets ? s.pts[k] / s.sets : null);
    draw('c-points', 'bar', {
      labels: ['Toplam', 'Sideout', 'Break'],
      datasets: ss.map((s, i) => bar(names[i], ['total', 'so', 'bp'].map((k) => perSet(s, k)), cols[i])),
    }, {
      layout: { padding: { top: 16 } },
      scales: { x: noGrid({}), y: axis({ beginAtZero: true }) },
      plugins: { legend: legend(true), valueLabels: { kind: 'num' }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${num(c.raw, 2)} sayı/set` } } },
    });

    draw('c-skills', 'bar', {
      labels: SKILLS.map((x) => x.name),
      datasets: ss.map((s, i) => bar(names[i], SKILLS.map((x) => s.skills[x.id].positive), cols[i])),
    }, {
      layout: { padding: { top: 16 } },
      scales: { x: noGrid({}), y: axis({ beginAtZero: true, ticks: pctTicks() }) },
      plugins: { legend: legend(true), valueLabels: { kind: 'pct0' }, tooltip: pctTooltip },
    });

    table($('c-table'), ['', `<i class="sw a"></i>${names[0]}`, `<i class="sw b"></i>${names[1]}`], compareRows(PLAYER_ROWS, ss[0], ss[1]));
  }

  // ---------- TAKIM KARŞILAŞTIRMA ----------
  function teamSum(t, ms) {
    const set = ms && new Set(ms.map((m) => m.id));
    const s = STATS.summary(set ? byTeam[t].filter((a) => set.has(a.m)) : byTeam[t]);
    s.rally = STATS.rallyStats(set ? rallies.filter((r) => set.has(r.m)) : rallies, t);
    const mine = (ms || matches).filter((m) => m.home === t || m.away === t);
    s.wins = mine.filter((m) => won(m, t)).length;
    s.losses = mine.length - s.wins;
    return s;
  }
  const TEAM_ROWS = [
    ['Galibiyet', (s) => s.wins, int, 1],
    ['Oynanan set', (s) => s.sets, int, 0],
    ['Sideout %', (s) => s.rally.so, pc, 1],
    ['Break point %', (s) => s.rally.bp, pc, 1],
    ['Sideout sayısı', (s) => s.pts.so, int, 1],
    ['Break sayısı', (s) => s.pts.bp, int, 1],
    ['Sayı / set', (s) => (s.sets ? s.pts.total / s.sets : null), num, 1],
    ['Servis as %', (s) => s.skills.S.perfect, pc, 1],
    ['Servis hata %', (s) => s.skills.S.error, pc, -1],
    ['Karşılama mükemmel %', (s) => s.skills.R.perfect, pc, 1],
    ['Karşılama pozitif %', (s) => s.skills.R.positive, pc, 1],
    ['Hücum sayı %', (s) => s.skills.A.perfect, pc, 1],
    ['Hücum hata %', (s) => s.skills.A.error, pc, -1],
    ['Hücum verim %', (s) => s.skills.A.eff, pc, 1],
    ['Blok sayı / set', (s) => (s.sets ? s.skills.B.c['#'] / s.sets : null), num, 1],
    ['Savunma pozitif %', (s) => s.skills.D.positive, pc, 1],
  ];

  function renderTeam() {
    const two = $('t-mode').value === 'two';
    $('t-two-filters').hidden = $('t-two').hidden = !two;
    $('t-all-filters').hidden = $('t-all').hidden = two;
    if (two) renderTwoTeams(); else renderAllTeams();
  }

  function renderTwoTeams() {
    const ids = [+$('t-a').value, +$('t-b').value], cols = ['--a', '--b'];
    const h2h = $('t-scope').value === 'h2h';
    const ms = h2h ? matches.filter((m) => ids.includes(m.home) && ids.includes(m.away) && m.home !== m.away) : null;
    const ss = ids.map((t) => teamSum(t, ms));
    const names = ids.map((t) => teams[t].name);
    $('t-two-sub').textContent = h2h ? `Sadece aralarındaki ${ms.length} maç` : 'Sezonun tüm maçları';

    draw('t-sobp', 'bar', {
      labels: ['Sideout %', 'Break point %'],
      datasets: ss.map((s, i) => bar(names[i], [s.rally.so, s.rally.bp], cols[i])),
    }, {
      layout: { padding: { top: 16 } },
      scales: { x: noGrid({}), y: axis({ beginAtZero: true, ticks: pctTicks() }) },
      plugins: { legend: legend(true), valueLabels: { kind: 'pct' }, tooltip: pctTooltip },
    });
    draw('t-skills', 'bar', {
      labels: SKILLS.map((x) => x.name),
      datasets: ss.map((s, i) => bar(names[i], SKILLS.map((x) => s.skills[x.id].eff), cols[i])),
    }, {
      layout: { padding: { top: 16 } },
      scales: { x: noGrid({}), y: axis({ ticks: pctTicks() }) },
      plugins: { legend: legend(true), valueLabels: { kind: 'pct0' }, tooltip: pctTooltip },
    });
    table($('t-two-table'), ['', `<i class="sw a"></i>${names[0]}`, `<i class="sw b"></i>${names[1]}`], compareRows(TEAM_ROWS, ss[0], ss[1]));
  }

  function ranked(id, label, values, color, asc) {
    const order = teams.map((t) => t.id).sort((a, b) => (asc ? values[a] - values[b] : values[b] - values[a]));
    draw(id, 'bar', {
      labels: order.map((t) => teams[t].name),
      datasets: [bar(label, order.map((t) => values[t]), color)],
    }, {
      indexAxis: 'y',
      layout: { padding: { right: 44 } },
      scales: { x: axis({ beginAtZero: true, ticks: pctTicks() }), y: noGrid({ ticks: { color: css('--text-2') } }) },
      plugins: { legend: legend(false), valueLabels: { kind: 'pct' }, tooltip: pctTooltip },
    });
  }

  function renderAllTeams() {
    const ss = teams.map((t) => teamSum(t.id, null));
    const skill = $('t-skill').value, metric = $('t-metric').value;
    const metricName = $('t-metric').selectedOptions[0].textContent;
    ranked('t-so', 'Sideout %', ss.map((s) => s.rally.so), '--so');
    ranked('t-bp', 'Break point %', ss.map((s) => s.rally.bp), '--bp');
    $('t-rank-title').textContent = `${skillName(skill)}: ${metricName}` + (metric === 'error' ? ' (düşük olan daha iyi)' : '');
    ranked('t-rank', `${skillName(skill)} ${metricName}`, ss.map((s) => s.skills[skill][metric]), '--a', metric === 'error');

    const order = teams.map((t) => t.id).sort((a, b) => ss[b].wins - ss[a].wins || ss[b].rally.so - ss[a].rally.so);
    table($('t-all-table'),
      ['Takım', 'G-M', 'Sideout %', 'Break %', 'Sideout sayısı', 'Break sayısı', 'Servis as %', 'Karşılama poz. %', 'Hücum verim %', 'Blok / set', 'Savunma poz. %'],
      order.map((t) => {
        const s = ss[t];
        return { cells: [teams[t].name, `${s.wins}-${s.losses}`, pc(s.rally.so), pc(s.rally.bp), s.pts.so, s.pts.bp, pc(s.skills.S.perfect), pc(s.skills.R.positive), pc(s.skills.A.eff), num(s.skills.B.c['#'] / s.sets), pc(s.skills.D.positive)] };
      }));
  }

  // ---------- kurulum ----------
  const skillOpts = SKILLS.map((s) => [s.id, s.name]);
  fill($('p-team'), teamOpts, 0); fill($('p-player'), playerOpts(0), 1); fill($('p-skill'), skillOpts, 'A');
  fill($('c-team-a'), teamOpts, 0); fill($('c-player-a'), playerOpts(0), 1);
  fill($('c-team-b'), teamOpts, 1); fill($('c-player-b'), playerOpts(1), 8);
  fill($('t-a'), teamOpts, 0); fill($('t-b'), teamOpts, 1); fill($('t-skill'), skillOpts, 'A');

  const renderers = { player: renderPlayer, compare: renderCompare, team: renderTeam };
  let current = 'player';
  const render = () => renderers[current]();
  [['p-team', 'p-player'], ['c-team-a', 'c-player-a'], ['c-team-b', 'c-player-b']].forEach(([t, p]) => {
    $(t).addEventListener('change', () => { fill($(p), playerOpts($(t).value)); });
  });
  document.querySelectorAll('main select').forEach((s) => s.addEventListener('change', render));
  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => {
    current = b.dataset.tab;
    document.querySelectorAll('#tabs button').forEach((x) => x.setAttribute('aria-selected', x === b));
    for (const k in renderers) $('tab-' + k).hidden = k !== current;
    render();
  }));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
  render();
})();
