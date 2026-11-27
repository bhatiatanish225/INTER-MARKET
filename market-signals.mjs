import { curveStarts, historicalCloseReader, liveBoardReader, londonDay, markets,
  monthLabel, readStrategy, strategyLegArgs, strategyStarts, strategySeries, typeLabel } from './curve-engine.mjs';
import { formatValue, showChart } from './chart.mjs';

const dayMs = 86_400_000;
const dateName = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'medium' });
const date = day => Number.isFinite(day) ? dateName.format(day * dayMs) : '—';
const unit = (value, suffix = 'bp') => Number.isFinite(value) ? `${formatValue(value, 'bp', true)} ${suffix}` : '—';
const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const deviation = values => {
  if (values.length < 10) return null;
  const mean = average(values);
  return Math.sqrt(average(values.map(value => (value - mean) ** 2)));
};
const instruments = ['spread', 'fly'].flatMap(family => [3, 6, 12].map(tenor => ({
  id: `${family}/${tenor}`, name: typeLabel(family, tenor), family, tenor,
})));
const macro = [
  ['2s10s', 'Treasury 2s10s', rates => (rates[2] - rates[0]) * 100],
  ['10s30s', 'Treasury 10s30s', rates => (rates[3] - rates[2]) * 100],
  ['2s5s10s', 'Treasury 2s5s10s fly', rates => (2 * rates[1] - rates[0] - rates[2]) * 100],
];

export function dailyMoves(levels) {
  return levels.map((level, i) => Number.isFinite(level) && Number.isFinite(levels[i - 1]) ? level - levels[i - 1] : null);
}

function fit(rows) {
  if (rows.length < 10) return null;
  const x = average(rows.map(pair => pair[0])), y = average(rows.map(pair => pair[1]));
  let xx = 0, yy = 0, xy = 0;
  for (const [a, b] of rows) {
    xx += (a - x) ** 2;
    yy += (b - y) ** 2;
    xy += (a - x) * (b - y);
  }
  if (!(xx > 0 && yy > 0)) return null;
  const beta = xy / xx;
  return { correlation: xy / Math.sqrt(xx * yy), beta, intercept: y - beta * x };
}

export function lagEvidence(leader, follower, lag) {
  const pairs = [];
  for (let i = lag; i < follower.length; i++) {
    const a = leader[i - lag], b = follower[i];
    if (Number.isFinite(a) && Number.isFinite(b)) pairs.push([a, b]);
  }
  const split = Math.floor(pairs.length * .7);
  const train = fit(pairs.slice(0, split)), validation = pairs.slice(split);
  if (!train || validation.length < 10) return { pairs: pairs.length };
  const directional = validation.filter(([a, b]) => a !== 0 && b !== 0);
  const hit = directional.length
    ? directional.filter(([a, b]) => Math.sign(train.intercept + train.beta * a) === Math.sign(b)).length / directional.length
    : null;
  return { ...train, pairs: pairs.length, validation: validation.length, testCorrelation: fit(validation)?.correlation, hit,
    directional: directional.length };
}

export function mountMarketSignals(main, getBook, getFeed, structures, getSaved) {
  main.innerHTML = `<div class="page-header"><div class="page-title"><h1>Market Signals</h1>
    <p>Track moves across rates, Treasury curvature and gold.</p></div></div>
    <section class="panel signals-context" aria-label="Cross-asset context"></section>
    <div class="signals-grid">
      <section class="panel"><div class="panel-head"><div><h2>Lead–lag lab</h2>
        <p>Positive lag means the leader moved first. Fit uses the earliest 70% of matched sessions and validation uses the rest.</p></div></div>
        <div class="toolbar signals-controls">
          <label class="input-label">Leader <select id="signal-lead"></select></label>
          <label class="input-label">Leader delivery <select id="signal-lead-month"></select></label>
          <label class="input-label">Follower <select id="signal-follow"></select></label>
          <label class="input-label">Follower delivery <select id="signal-follow-month"></select></label>
          <label class="input-label">History <select id="signal-window"><option value="60">60 sessions</option><option value="120" selected>120 sessions</option><option value="240">240 sessions</option></select></label>
          <label class="input-label">Chart lag <select id="signal-lag"><option value="0">Same session</option><option value="1" selected>1 session</option><option value="2">2 sessions</option><option value="3">3 sessions</option></select></label>
        </div>
        <p class="notice" id="signal-reading" role="status"></p>
        <div class="chart-shell" id="signal-chart"></div><div class="chart-legend" id="signal-legend"></div>
        <div id="signal-stats" class="table-scroll"></div>
      </section>
      <section class="panel signals-plan">
        <div class="panel-head"><div><h2>Paper trade plan</h2><p>Set your own entry, stop, and target for the selected rates follower.</p></div></div>
        <form id="signal-plan">
          <label class="input-label">Direction <select name="side"><option value="1">Long</option><option value="-1">Short</option></select></label>
          <label class="input-label">Entry (bp) <input name="entry" type="number" step="0.01" required></label>
          <button type="button" class="button small" id="signal-use-live">Use live follower</button>
          <label class="input-label">Stop distance (bp) <input name="stop" type="number" min="0.01" step="0.01" required></label>
          <label class="input-label">Target distance (bp) <input name="target" type="number" min="0.01" step="0.01" required></label>
          <output id="signal-plan-result"></output>
        </form>
      </section>
    </div>
    <section class="panel lower-section">
      <div class="panel-head wrap"><div><h2>Catch-up watchlist</h2>
        <p>Two peers moved the same way in the last completed session. See how the third market is moving today across the first six deliveries.</p></div>
        <label class="input-label">Peer move threshold <select id="signal-shock"><option value="0.75">0.75σ</option><option value="1" selected>1σ</option><option value="1.5">1.5σ</option><option value="2">2σ</option></select></label></div>
      <div class="table-scroll signals-scanner" id="signal-scanner"></div>
    </section>
    <div class="signals-grid signals-market-charts">
      <section class="panel"><div class="panel-head"><div><h2>U.S. Treasury par yield curve</h2><p id="signal-treasury-dates"></p></div></div>
        <div class="chart-shell" id="signal-treasury-chart"></div></section>
      <section class="panel"><div class="panel-head"><div><h2>COMEX gold intraday</h2><p id="signal-gold-move"></p></div></div>
        <div class="chart-shell" id="signal-gold-chart"></div></section>
    </div>`;
  main.scrollTop = 0;
  const find = id => main.querySelector(`#${id}`);
  const lead = find('signal-lead'), follow = find('signal-follow'), leadMonth = find('signal-lead-month'), followMonth = find('signal-follow-month');
  const lookback = find('signal-window'), lagPicker = find('signal-lag'), shock = find('signal-shock');
  const plan = find('signal-plan');
  const goldDefault = 'GCG27';
  let gold = goldDefault, context, contextError, controller, lastContext = 0, closed = false;
  let selectedFollower, followerKey, watchRows = [], observedBook, definitions, catalogue;
  let moveCache = new Map(), scannerSignature = '';

  function refreshDefinitions(book) {
    const saved = getSaved();
    if (book === observedBook && saved === catalogue) return;
    observedBook = book;
    catalogue = saved;
    moveCache = new Map();
    scannerSignature = '';
    const configs = [...instruments, ...[...structures, ...saved].map(strategy => ({ id: `strategy/${strategy.id}`, name: strategy.name, strategy }))];
    definitions = configs.flatMap(config => (config.strategy ? strategySeries(config.strategy) : markets).map(market => ({
      ...config, key: `${market.id}/${config.id}`, market: market.id, label: `${market.name} · ${config.name}`, unit: 'bp',
    })));
    const leaders = [...definitions, ...macro.map(([key, label]) => ({ key, label })), { key: 'gold', label: 'COMEX gold futures' }];
    for (const [select, choices, fallback] of [[lead, leaders, 'SR3/fly/6'], [follow, definitions, 'I/fly/6']]) {
      const selected = select.value || fallback;
      select.innerHTML = choices.map(option => `<option value="${esc(option.key)}">${esc(option.label)}</option>`).join('');
      if (choices.some(option => option.key === selected)) select.value = selected;
    }
  }

  function setupMonth(select, book, def) {
    const choices = def ? (def.strategy ? strategyStarts(book, def.strategy, { cadence: 'quarterly' })
      : curveStarts(book, [def.market], def.family, def.tenor, { cadence: 'quarterly' })) : [];
    const markup = choices.map(month => `<option value="${month}">${monthLabel(month)}</option>`).join('');
    if (select.dataset.options !== markup) {
      const old = select.value;
      select.innerHTML = markup;
      select.dataset.options = markup;
      if (old && choices.includes(Number(old))) select.value = old;
    }
    select.disabled = !choices.length;
    return select.value ? Number(select.value) : null;
  }

  function rateSeries(book, days, def, start, live) {
    if (!def || start === null) return { levels: days.map(() => null), live: null };
    const read = reader => def.strategy ? readStrategy(def.strategy, def.market, start, reader) : reader(def.market, def.family, start, def.tenor);
    const legs = def.strategy ? def.strategy.legs.map(leg => strategyLegArgs(leg, def.market, start))
      : [[def.market, def.family, start, def.tenor]];
    const modes = legs.map(args => live(...args)?.source ?? '');
    const key = JSON.stringify([def.key, start, days[0], days.at(-1), modes]);
    if (!moveCache.has(key)) {
      const levels = days.map(day => read(historicalCloseReader(book, day, live))?.value ?? null);
      if (moveCache.size >= 600) moveCache.clear();
      moveCache.set(key, { levels, moves: dailyMoves(levels) });
    }
    return { ...moveCache.get(key), live: read(live)?.value ?? null };
  }

  function renderContext() {
    const treasury = context?.treasury ?? [], last = treasury.at(-1), prior = treasury.at(-2);
    const closes = context?.gold.closes ?? [], intraday = context?.gold.intraday ?? [], recent = intraday.at(-1);
    const previous = recent ? closes.findLast(row => row[0] < Math.floor(recent[0] / dayMs)) : closes.at(-1);
    const goldMove = recent && previous ? 100 * (recent[1] / previous[1] - 1) : null;
    const goldVol = deviation(closes.slice(-61).flatMap(([_, value], i, rows) => i ? [100 * (value / rows[i - 1][1] - 1)] : []));
    const markup = macro.map(([, label, read]) => `<div><h2>${label}</h2><strong>${last ? unit(read(last[1])) : '—'}</strong>
      <small>${last && prior ? `${unit(read(last[1]) - read(prior[1]))} change · ${date(last[0])}` : 'Daily published yields'}</small></div>`).join('')
      + `<div><label class="input-label">COMEX gold <select id="signal-gold">
          <option value="GCG27"${gold === 'GCG27' ? ' selected' : ''}>Feb 27</option><option value="GCZ26"${gold === 'GCZ26' ? ' selected' : ''}>Dec 26</option>
        </select></label><strong>${unit(goldMove, '%')}</strong><small>${recent
          ? `${new Date(recent[0] + 300_000).toISOString().slice(0, 16).replace('T', ' ')} UTC · 5m close${goldVol && Number.isFinite(goldMove) ? ` · ${formatValue(goldMove / goldVol, 'bp', true)}σ vs daily moves` : ''}`
          : 'Awaiting QuantHub candles'}</small></div>`
      + (contextError || context?.warnings.length ? `<p class="notice warning">${esc([contextError, ...context?.warnings ?? []].filter(Boolean).join(' · '))}</p>` : '');
    const host = main.querySelector('.signals-context');
    if (host.dataset.markup !== markup) { host.dataset.markup = markup; host.innerHTML = markup; }
    find('signal-treasury-dates').textContent = last ? `${date(last[0])} solid${prior ? ` · ${date(prior[0])} dashed` : ''}` : 'Published daily yields';
    showChart(find('signal-treasury-chart'), {
      label: 'U.S. Treasury par yields by tenor', axisTitle: 'Yield (%)', unit: 'price',
      starts: [2, 5, 10, 30], describe: year => `${year}Y`, tickLabel: year => `${year}Y`, empty: 'No published Treasury yields loaded.',
      series: [last, prior].filter(Boolean).map(([day, rates], index) => ({
        id: 'SR3', dashed: index === 1, label: date(day), points: rates.map(value => ({ value })),
      })),
    });
    const intradayMoves = intraday.map(([stamp, price], i) =>
      i && stamp - intraday[i - 1][0] === 300_000 ? price - intraday[i - 1][1] : null);
    const lastMove = intradayMoves.at(-1);
    const intradayVol = deviation(intradayMoves.slice(0, -1).filter(Number.isFinite));
    const impulse = intradayVol > 0 && Number.isFinite(lastMove) ? ` · ${formatValue(lastMove / intradayVol, 'bp', true)}σ` : '';
    const clockLabel = stamp => new Date(stamp).toISOString().slice(11, 16);
    find('signal-gold-move').textContent = recent
      ? `${gold} · Last 5-minute change ${unit(lastMove, 'USD')}${impulse} · UTC` : `${gold} · Awaiting QuantHub candles`;
    showChart(find('signal-gold-chart'), {
      label: 'COMEX gold five-minute closes', axisTitle: 'USD per troy ounce', unit: 'price',
      starts: intraday.map(row => row[0] + 300_000), describe: stamp => `${clockLabel(stamp)} UTC`, tickLabel: clockLabel,
      empty: 'No gold candles loaded.',
      series: [{ id: 'SO3', label: gold, points: intraday.map(row => ({ value: row[1] })) }],
    });
  }

  function renderPlan() {
    const output = find('signal-plan-result');
    find('signal-use-live').disabled = !Number.isFinite(selectedFollower);
    const [entry, stop, target] = ['entry', 'stop', 'target'].map(name => plan.elements[name].valueAsNumber);
    if (!Number.isFinite(entry) || !(stop > 0) || !(target > 0)) {
      output.textContent = 'Enter the three levels to calculate the plan.';
      return;
    }
    const sign = Number(plan.elements.side.value);
    output.textContent = `Stop ${unit(entry - sign * stop)} · Target ${unit(entry + sign * target)} · ${(target / stop).toFixed(2)}× reward to risk`;
  }

  function renderScanner(book, days, live) {
    const host = find('signal-scanner');
    const previous = days.at(-1);
    const configs = new Map(definitions.filter(def => def.market !== 'intermarket').map(def => [def.id, def]));
    const candidates = [];
    for (const config of configs.values()) {
      const members = definitions.filter(def => def.id === config.id);
      if (members.length !== 3) continue;
      const starts = config.strategy ? strategyStarts(book, config.strategy, { cadence: 'quarterly' })
        : curveStarts(book, markets.map(m => m.id), config.family, config.tenor, { cadence: 'quarterly' });
      for (const start of starts.slice(0, 6)) {
        const quotes = members.map(def => {
          const rates = rateSeries(book, days, def, start, live);
          const vol = deviation(rates.moves.slice(-61, -1).filter(Number.isFinite));
          return { def, now: rates.live, prior: rates.levels.at(-1), move: rates.moves.at(-1), vol };
        });
        for (const follower of quotes) {
          const peers = quotes.filter(item => item !== follower);
          if (![follower.now, follower.prior, follower.move].every(Number.isFinite)
            || !peers.every(peer => Number.isFinite(peer.move) && peer.vol > 0)) continue;
          const sign = Math.sign(peers[0].move);
          const strength = Math.min(...peers.map(peer => sign * peer.move / peer.vol));
          if (strength < Number(shock.value)) continue;
          const current = follower.now - follower.prior;
          const status = sign * follower.move > Math.abs(peers[0].move + peers[1].move) / 4 ? 'Moved with peers'
            : sign * current > 0 ? 'Following today' : sign * current < 0 ? 'Diverging today' : 'Flat today';
          candidates.push({ config, start, follower, peers, current, strength, status });
        }
      }
    }
    candidates.sort((a, b) => b.strength - a.strength);
    watchRows = candidates;
    const markup = candidates.length ? `<table aria-label="Catch-up candidates"><thead><tr><th>Strategy / Delivery</th><th>Peer moves · ${date(previous)}</th>
      <th>Follower · prior move</th><th>Follower · live vs close</th><th>Pattern</th></tr></thead><tbody>
      ${candidates.map(({ config, start, follower, peers, current, strength, status }, i) => `<tr>
        <th scope="row"><button type="button" class="button small" data-signal-candidate="${i}">${esc(config.name)} · ${monthLabel(start)}</button></th>
        <td>${peers.map(peer => `${esc(peer.def.market)} ${unit(peer.move)}`).join(' · ')}</td>
        <td>${esc(follower.def.market)} ${unit(follower.move)}</td><td>${unit(current)}</td>
        <td>${status} · ${strength.toFixed(1)}σ peer move</td></tr>`).join('')}</tbody></table>`
      : '<p class="empty">No matched moves at this threshold.</p>';
    if (host.dataset.markup !== markup) { host.dataset.markup = markup; host.innerHTML = markup; }
  }

  function update() {
    if (closed) return;
    const book = getBook(), feed = getFeed();
    refreshDefinitions(book);
    renderContext();
    const today = londonDay();
    const sessions = book.closeDays.filter(day => day < today);
    const days = sessions.slice(-Math.max(120, Number(lookback.value)) - 1);
    const active = feed.state === 'connected';
    const live = liveBoardReader(book, active ? feed.quotes : {});
    const leadDef = definitions.find(def => def.key === lead.value), followDef = definitions.find(def => def.key === follow.value);
    const left = setupMonth(leadMonth, book, leadDef), right = setupMonth(followMonth, book, followDef);
    const a = leadDef ? rateSeries(book, days, leadDef, left, live) : {};
    const b = rateSeries(book, days, followDef, right, live);
    const maturity = macro.find(([key]) => key === lead.value);
    const extra = new Map(maturity ? (context?.treasury ?? []).map(([day, values]) => [day, maturity[2](values)]) : context?.gold.closes ?? []);
    const leadMoves = a.moves ?? dailyMoves(days.map(day => extra.get(day)));
    const followMoves = b.moves ?? days.map(() => null);
    const window = Number(lookback.value), shift = Number(lagPicker.value);
    const evidence = [0, 1, 2, 3].map(lag => lagEvidence(leadMoves.slice(-window), followMoves.slice(-window), lag));
    const recentMove = leadMoves.at(-1 - Math.max(0, shift - 1)), followerMove = Number.isFinite(b.live) && Number.isFinite(b.levels.at(-1)) ? b.live - b.levels.at(-1) : null;
    const leadVol = deviation(leadMoves.slice(-61, -Math.max(1, shift)).filter(Number.isFinite));
    const signal = evidence[shift];
    const reading = find('signal-reading');
    let message = `Leader ${date(days.at(-Math.max(1, shift)))} ${unit(recentMove, lead.value === 'gold' ? 'USD' : 'bp')} · Follower live vs ${date(days.at(-1))} ${unit(followerMove)}`;
    if (shift && active && Number.isFinite(recentMove) && leadVol > 0 && Math.abs(recentMove) >= leadVol
      && Math.abs(signal.correlation) >= .25 && signal.hit >= .55 && signal.directional >= 10) {
      const fittedMove = signal.intercept + recentMove * signal.beta;
      message += ` · Historical fit ${unit(fittedMove)} · ${Math.round(signal.hit * 100)}% direction agreement in ${signal.directional} later nonzero sessions`;
    }
    if (reading.textContent !== message) reading.textContent = message;
    const stats = `<table aria-label="Lag evidence"><thead><tr><th>Leader ahead</th><th>Fit correlation</th><th>Later-period correlation</th><th>Later-period direction</th><th>Matched sessions</th></tr></thead>
      <tbody>${evidence.map((row, i) => `<tr><th scope="row">${i ? `${i} session${i === 1 ? '' : 's'}` : 'Same session'}</th>
        <td>${formatValue(row.correlation, 'bp')}</td><td>${formatValue(row.testCorrelation, 'bp')}</td>
        <td>${Number.isFinite(row.hit) ? `${Math.round(row.hit * 100)}% (${row.directional})` : '—'}</td><td>${row.pairs}</td></tr>`).join('')}</tbody></table>`;
    const statsHost = find('signal-stats');
    if (statsHost.dataset.markup !== stats) { statsHost.dataset.markup = stats; statsHost.innerHTML = stats; }
    const startIndex = Math.max(0, days.length - Math.min(window, 90));
    const leadScale = deviation(leadMoves.slice(-window).filter(Number.isFinite)), followScale = deviation(followMoves.slice(-window).filter(Number.isFinite));
    const standardized = (values, scale, lag = 0) => days.slice(startIndex).map((_, i) => {
      const value = values[startIndex + i - lag];
      return scale && Number.isFinite(value) ? { value: value / scale } : null;
    });
    const labels = [lead.selectedOptions[0]?.textContent ?? 'Leader', follow.selectedOptions[0]?.textContent ?? 'Follower'];
    showChart(find('signal-chart'), { label: 'Standardized daily moves', axisTitle: 'Standard deviations (σ)', unit: 'bp',
      starts: days.slice(startIndex), describe: date, tickLabel: date, empty: 'Not enough aligned history for this selection.',
      series: [{ id: 'SR3', label: `${labels[0]}${shift ? ` · shifted +${shift} sessions` : ''}`, points: standardized(leadMoves, leadScale, shift) },
        { id: 'SO3', label: labels[1], points: standardized(followMoves, followScale) }],
    });
    find('signal-legend').textContent = `Blue · ${labels[0]}${shift ? ` shifted forward ${shift}` : ''}     Gold · ${labels[1]}`;
    if (followerKey !== `${follow.value}/${right}`) {
      followerKey = `${follow.value}/${right}`;
      plan.elements.entry.value = '';
    }
    selectedFollower = b.live;
    renderPlan();
    const scannerKey = `${feed.received}/${feed.state}/${shock.value}/${days[0]}/${days.at(-1)}`;
    if (scannerKey !== scannerSignature) {
      scannerSignature = scannerKey;
      renderScanner(book, sessions.slice(-101), live);
    }
  }

  async function loadContext() {
    controller?.abort();
    const request = controller = new AbortController();
    lastContext = Date.now();
    try {
      const response = await fetch(`/api/market-context?gold=${encodeURIComponent(gold)}`, {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(28_000)]),
      });
      if (!response.ok) throw new Error('Cross-asset data could not be loaded.');
      const data = await response.json();
      if (request.signal.aborted) return;
      context = data;
      contextError = '';
    } catch (error) {
      if (request.signal.aborted) return;
      contextError = context ? 'Showing the last received cross-asset data.' : 'Treasury or gold data is currently unavailable.';
    }
    update();
  }

  const changed = event => {
    if (event.target.id === 'signal-gold') {
      gold = event.target.value;
      if (context) context = { ...context, gold: { code: gold, closes: [], intraday: [] } };
      loadContext();
    }
    update();
  };
  const clicked = event => {
    const button = event.target.closest('button');
    if (button?.id === 'signal-use-live' && Number.isFinite(selectedFollower)) {
      plan.elements.entry.value = selectedFollower.toFixed(2);
      renderPlan();
    } else if (button?.dataset.signalCandidate !== undefined) {
      const candidate = watchRows[Number(button.dataset.signalCandidate)];
      if (!candidate) return;
      lead.value = candidate.peers[0].def.key;
      follow.value = candidate.follower.def.key;
      update();
      leadMonth.value = String(candidate.start);
      followMonth.value = String(candidate.start);
      lagPicker.value = '1';
      update();
      lead.focus();
    }
  };
  main.addEventListener('change', changed);
  main.addEventListener('click', clicked);
  plan.addEventListener('input', renderPlan);
  plan.addEventListener('submit', event => event.preventDefault());
  const timer = setInterval(() => { if (!document.hidden && Date.now() - lastContext >= 120_000) loadContext(); }, 30_000);
  update();
  loadContext();
  return {
    update,
    dispose() {
      closed = true;
      clearInterval(timer);
      controller?.abort();
      main.removeEventListener('change', changed);
      main.removeEventListener('click', clicked);
    },
  };
}
