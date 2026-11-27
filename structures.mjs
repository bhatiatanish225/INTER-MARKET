import { canvasContext, clamp, formatValue, showChart, tickStep } from './chart.mjs';
import {
  contractLabel, curveStarts, historicalPercentiles, keyOf, liveBoardReader, londonDay, marketReader, markets, monthLabel,
  percentileWindows, readStrategy, strategyLegArgs, strategyStarts, typeLabel,
} from './curve-engine.mjs';

const labels = { SR3: 'SR3 · SOFR', I: 'Euribor', SO3: 'SONIA', intermarket: 'Custom markets' };
const presets = [
  ['3MS vs 12MS (4:1)', ['spread', 3, 4], ['spread', 12, -1]],
  ['3MS vs 6MS', ['spread', 3, 1], ['spread', 6, -1]],
  ['3MS vs 6MF', ['spread', 3, 1], ['fly', 6, -1]],
  ['3MS vs 12MS (3:1)', ['spread', 3, 3], ['spread', 12, -1]],
  ['6MF vs 12MF (2:1)', ['fly', 6, 2], ['fly', 12, -1]],
  ['12MF Diff', ['fly', 12, 1], ['fly', 12, -1, 1]],
  ['6MF Diff', ['fly', 6, 1], ['fly', 6, -1, 1]],
  ['6MS vs 12MS', ['spread', 6, 1], ['spread', 12, -1]],
  ['6MS vs 12MF', ['spread', 6, 1], ['fly', 12, -1]],
].map(([name, ...legs], i) => ({ id: `preset-${i}`, name, legs: legs.map(([family, tenor, weight, offset = 0]) => (
  { market: 'same', family, tenor, weight, offset, delivery: null }
)) }));

const storageKey = 'intermarket-structures-v1';
const marketOptions = markets.map(({ id }) => [id, labels[id]]);
const products = [['out/0', 'Outright'], ...['spread', 'fly'].flatMap(family =>
  [3, 6, 12, 24].map(tenor => [`${family}/${tenor}`, typeLabel(family, tenor)]))];
const day = 86_400_000;
const initialBars = 100;
const rangeChoices = [[1, '1D'], [7, '1W'], [30, '1M'], [90, '3M'], [0, 'All']];
const firstDate = '2021-01-01';
const formatDate = value => new Date(value).toISOString().slice(0, 10);
const stampLabel = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' });
const shortDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
const shortTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const referenceDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'medium' });
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
));
const options = (items, selected) => items.map(([key, label]) =>
  `<option value="${escape(key)}"${String(key) === String(selected) ? ' selected' : ''}>${escape(label)}</option>`).join('');
const price = value => Number.isFinite(value) ? formatValue(value, 'bp') : '—';
const noQuote = { value: null };

function formula(structure) {
  return structure.legs.map((leg, i) => {
    const sign = leg.weight < 0 ? '− ' : i ? '+ ' : '';
    const factor = Math.abs(leg.weight) === 1 ? '' : `${Math.abs(leg.weight)} × `;
    const market = leg.market === 'same' ? '' : `${labels[leg.market]} `;
    const timing = leg.delivery != null ? ` [${contractLabel(leg.family, leg.delivery, leg.tenor)}]`
      : leg.offset ? ` [${leg.offset > 0 ? '+' : ''}${leg.offset}Q]` : '';
    return `${sign}${factor}${market}${typeLabel(leg.family, leg.tenor)}${timing}`;
  }).join(' ');
}

function readStructures() {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(stored) ? stored : [];
  } catch { return []; }
}

export function mountStructures(main, book, getFeed) {
  let custom = readStructures();
  let selected, editing, delivery, request, result, boardRows = [];
  let lastFeed, referenceRequest, referenceKey, reference;
  let activeMarket = 'SR3', rankHistory, rankKey, openedCell;
  let viewport, plot, drag, hover;
  const today = formatDate(Date.now());
  const recentRequests = new Map();
  main.innerHTML = `<div class="page-header"><div class="page-title"><h1>Structures</h1>
    <p>Compare weighted spreads and flies across delivery months and markets.</p></div>
    <button type="button" id="structure-new" class="button primary">New structure</button></div>
    <section class="panel" aria-label="Structure prices">
      <div class="panel-head"><div><h2>Live structure prices</h2><p>Select a delivery cell to open its chart.</p></div></div>
      <div class="toolbar structure-board-controls">
        <label class="input-label">Market <select id="structure-market">${options([['all', 'All markets'], ...marketOptions], 'all')}</select></label>
        <label class="input-label">Compare with <select id="structure-comparison"></select></label>
        <label class="input-label">Lookback <select id="structure-lookback">${options(percentileWindows.map(days => [days, `${days} days`]), 30)}</select></label>
        <label class="check"><input type="checkbox" id="structure-board-earlier"> Earlier deliveries</label>
        <span id="structure-board-feed" class="tag"></span>
      </div>
      <div id="structure-board" class="table-scroll heat-scroll structure-matrix-scroll"></div>
    </section>
    <section class="panel lower-section" id="structure-editor" hidden></section>
    <div id="structure-workbench" hidden>
    <section class="panel lower-section" id="structure-history">
      <div class="panel-head wrap"><div><h2 id="structure-title" tabindex="-1"></h2><p id="structure-formula"></p></div>
        <button type="button" class="button small" id="structure-close">Back to table</button></div>
      <form id="structure-history-form" class="toolbar">
        <label class="input-label">Chart delivery <select name="delivery"></select></label>
        <label class="input-label">Interval <select name="interval"><option value="10m">10 minutes</option><option value="1h">1 hour</option><option value="1d">1 day</option></select></label>
        <label class="input-label">From <input name="from" type="date" min="${firstDate}" max="${today}" required></label>
        <label class="input-label">Through <input name="through" type="date" min="${firstDate}" max="${today}" required></label>
        <button class="button small" type="submit">Load candles</button>
      </form>
      <div class="structure-quotes" role="group" aria-label="Selected structure quotes" hidden></div>
      <p id="structure-history-status" role="status" class="notice"></p>
      <div id="structure-candles" hidden>
        <div class="panel-head wrap"><div class="control-group">
          <label class="input-label">Series <select id="structure-candle-series"></select></label>
          <label class="input-label">Chart <select id="structure-chart-view"><option value="candles">Candlesticks</option><option value="line">Close curve</option></select></label>
          </div>
          <div class="control-group structure-zoom" aria-label="Chart zoom and pan">
            <button class="button small" type="button" data-chart-action="left" aria-label="Pan left">←</button>
            <button class="button small" type="button" data-chart-action="out" aria-label="Zoom out">−</button>
            <button class="button small" type="button" data-chart-action="in" aria-label="Zoom in">+</button>
            <button class="button small" type="button" data-chart-action="right" aria-label="Pan right">→</button>
            <button class="button small" type="button" data-chart-action="reset">Reset zoom</button>
          </div></div>
        <div class="structure-chart-info"><div class="segmented" aria-label="Chart range">${rangeChoices.map(([days, label]) =>
          `<button type="button" data-chart-range="${days}">${label}</button>`).join('')}</div>
          <div class="control-group"><span class="structure-chart-help">Scroll to zoom · Drag to pan</span><span id="structure-page"></span></div></div>
        <div class="chart-legend" id="structure-history-legend" hidden></div>
        <div class="chart-shell structure-candle-chart"><canvas tabindex="0" role="img" aria-label="Structure OHLC candlesticks" aria-description="Scroll or press plus and minus to zoom. Drag or use arrow keys to pan. Double-click or press zero to reset."></canvas></div>
        <div class="structure-chart-readout as-num"></div>
        <div class="table-scroll structure-ohlc-table"></div>
      </div>
    </section>
    <section class="panel lower-section" aria-label="Whole strategy curve">
      <div class="panel-head wrap"><div><h2>Whole strategy curve</h2><p>Weighted values by delivery month in basis points.</p></div>
        <label class="check"><input type="checkbox" id="structure-earlier"> Earlier deliveries</label></div>
      <p id="structure-curve-source" class="notice"></p>
      <div class="chart-legend" id="structure-curve-legend"></div>
      <div class="chart-shell" id="structure-curve"></div>
      <div id="structure-deliveries" class="table-scroll"></div>
    </section></div>`;

  const form = main.querySelector('#structure-history-form');
  const fields = form.elements;
  const board = main.querySelector('#structure-board');
  const boardMarket = main.querySelector('#structure-market');
  const boardComparison = main.querySelector('#structure-comparison');
  const boardEarlier = main.querySelector('#structure-board-earlier');
  const lookback = main.querySelector('#structure-lookback');
  const boardFeed = main.querySelector('#structure-board-feed');
  const workbench = main.querySelector('#structure-workbench');
  const editor = main.querySelector('#structure-editor');
  const quotesPanel = main.querySelector('.structure-quotes');
  const status = main.querySelector('#structure-history-status');
  const candlePanel = main.querySelector('#structure-candles');
  const candleSeries = main.querySelector('#structure-candle-series');
  const chartView = main.querySelector('#structure-chart-view');
  const canvas = candlePanel.querySelector('canvas');
  const candleReadout = candlePanel.querySelector('.structure-chart-readout');
  const earlier = main.querySelector('#structure-earlier');
  const resize = new ResizeObserver(drawCandles);
  resize.observe(canvas);

  const hasMarketChoice = structure => structure.legs.some(leg => leg.market === 'same');
  const selectedMarkets = (structure = selected) => {
    if (!hasMarketChoice(structure)) return ['intermarket'];
    return boardComparison.value === 'all' ? [activeMarket, ...markets.map(({ id }) => id).filter(id => id !== activeMarket)]
      : [...new Set([activeMarket, boardComparison.value].filter(Boolean))];
  };
  const boardMarkets = structure => !hasMarketChoice(structure) ? ['intermarket']
    : boardMarket.value === 'all' ? markets.map(({ id }) => id) : [boardMarket.value];
  const selectedLegs = ids => ids.map(id => selected.legs.map(leg => [...strategyLegArgs(leg, id, delivery), Number(leg.weight)]));
  const listsLegs = (structure, id, start) => structure.legs.every(leg => {
    const [market, family, delivery, tenor] = strategyLegArgs(leg, id, start);
    return book.startsByType.get(keyOf(market, family, 0, tenor))?.has(delivery);
  });
  const availableStarts = (structure, allowEarlier = false) => strategyStarts(book, structure, { cadence: 'quarterly', earlier: allowEarlier }).filter(start =>
    selectedMarkets(structure).some(id => listsLegs(structure, id, start)));
  const currentStarts = () => availableStarts(selected, earlier.checked);
  const allStructures = () => [...presets, ...custom];

  function listedVwapReader(feed) {
    const read = liveBoardReader(book, feed.quotes);
    return (...args) => {
      if (feed.state !== 'connected') return null;
      const point = read(...args);
      return point?.source === 'L1 VWAP' ? point : null;
    };
  }

  function drawBoard() {
    const groups = allStructures().map(structure => {
      const starts = strategyStarts(book, structure, { cadence: 'quarterly', earlier: boardEarlier.checked });
      return { structure, rows: boardMarkets(structure).map(id => ({ id, dates: new Set(starts.filter(start => listsLegs(structure, id, start))) })) };
    });
    const dates = [...new Set(groups.flatMap(group => group.rows.flatMap(row => [...row.dates])))].sort((a, b) => a - b);
    const cells = [];
    const bodies = groups.map(({ structure, rows }) => `<tbody>${rows.map(({ id, dates: available }, index) => `<tr>
      ${index === 0 ? `<th class="heat-group" scope="rowgroup" rowspan="${rows.length}" title="${escape(formula(structure))}">${escape(structure.name)}</th>` : ''}
      <th class="heat-market" scope="row"><span class="market-label"><i class="market-bullet ${id}" aria-hidden="true"></i>${escape(labels[id])}</span></th>
      ${dates.map(start => {
        if (!available.has(start)) return '<td class="heat-value value-empty">—</td>';
        const label = `${structure.name} · ${labels[id]} · ${monthLabel(start)}`;
        const index = cells.push({ structure, start, id, label }) - 1;
        return `<td class="heat-value heat-paired as-num"><button class="structure-matrix-cell" type="button" data-structure-cell="${index}" aria-controls="structure-workbench" aria-label="${escape(label)}">
          <span class="heat-price">—</span><span class="structure-rank">—</span></button></td>`;
      }).join('')}
      </tr>`).join('')}</tbody>`).join('');
    board.innerHTML = dates.length ? `<table class="heat-table structure-prices" aria-label="Live structure prices by market and delivery">
      <thead><tr><th class="heat-group" scope="col">Structure</th><th class="heat-market" scope="col">Market</th>
      ${dates.map(start => `<th class="heat-value" scope="col">${monthLabel(start)}</th>`).join('')}</tr></thead>${bodies}</table>`
      : '<p class="empty">No listed structures for these filters.</p>';
    boardRows = [...board.querySelectorAll('[data-structure-cell]')].map((button, index) => ({ ...cells[index], button,
      cell: button.parentElement, level: button.querySelector('.heat-price'), rank: button.querySelector('.structure-rank') }));
    paintBoardValues();
  }

  function paintBoardValues() {
    const feed = getFeed();
    const reader = listedVwapReader(feed);
    boardFeed.textContent = feed.state === 'connected' ? 'Live feed' : ['checking', 'signing-in', 'connecting'].includes(feed.state)
      ? 'Connecting live' : feed.state === 'offline' ? 'Live feed disconnected' : 'Live feed unavailable';
    const today = londonDay();
    const window = Number(lookback.value);
    const key = `${today}/${window}`;
    if (feed.state === 'connected' && key !== rankKey) {
      rankHistory = historicalPercentiles(book, today, window);
      rankKey = key;
    }
    for (const { structure, start, id, label, button, cell, level, rank } of boardRows) {
      const point = readStrategy(structure, id, start, reader);
      const percentile = point && rankHistory?.strategyRank(structure, id, start, point, reader);
      const value = price(point?.value);
      const rankText = Number.isFinite(percentile?.value) ? `${Math.round(percentile.value)}%` : '—';
      const offset = Number.isFinite(percentile?.value) ? percentile.value - 50 : 0;
      const magnitude = Math.abs(offset);
      const direction = magnitude < 5 ? '' : offset > 0 ? 'heat-up' : 'heat-down';
      const strength = magnitude >= 30 ? 'heat-high' : magnitude >= 15 ? 'heat-mid' : 'heat-low';
      const css = `heat-value heat-paired as-num${point ? '' : ' value-empty'}${direction ? ` ${direction} ${strength}` : ''}`;
      if (cell.className !== css) cell.className = css;
      if (level.textContent !== value) level.textContent = value;
      if (rank.textContent !== rankText) rank.textContent = rankText;
      const details = `${label}. ${point ? `Live VWAP ${value} bp.` : 'Live VWAP unavailable.'} ${rankText === '—'
        ? 'Percentile unavailable.' : `${window}-day percentile ${rankText} (${percentile.count} observations).`} Open chart.`;
      if (button.title !== details) {
        button.title = details;
        button.setAttribute('aria-label', details);
      }
    }
  }

  function syncComparison() {
    const choices = marketOptions.filter(([key]) => key !== activeMarket);
    boardComparison.innerHTML = options([['', 'None'], ['all', 'All three markets'], ...choices], boardComparison.value);
  }

  function syncDelivery(wanted = delivery) {
    const starts = currentStarts();
    fields.delivery.innerHTML = options(starts.map(start => [start, monthLabel(start)]), wanted);
    fields.delivery.disabled = !starts.length;
    delivery = fields.delivery.value === '' ? undefined : Number(fields.delivery.value);
  }

  function resetDates() {
    const days = { '10m': 7, '1h': 30, '1d': 90 }[fields.interval.value];
    fields.from.value = formatDate(Math.max(Date.parse(firstDate), Date.parse(today) - (days - 1) * day));
    fields.through.value = today;
  }

  function openStructure(structure, { start = delivery, id = activeMarket, focus = true } = {}) {
    selected = structure;
    if (id !== 'intermarket') activeMarket = id;
    syncComparison();
    workbench.hidden = false;
    if (boardEarlier.checked) earlier.checked = true;
    syncDelivery(start);
    const title = main.querySelector('#structure-title');
    title.textContent = selected.name;
    const heading = main.querySelector('#structure-formula');
    heading.replaceChildren(document.createTextNode(formula(selected) + ' '));
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'button small';
    edit.textContent = selected.id.startsWith('preset-') ? 'Copy to builder' : 'Edit structure';
    edit.addEventListener('click', () => openEditor(selected));
    heading.append(edit);
    paintCurve();
    loadCandles();
    if (focus) {
      workbench.scrollIntoView({ block: 'start' });
      title.focus({ preventScroll: true });
    }
  }

  function closeStructure() {
    request?.abort();
    referenceRequest?.abort();
    selected = result = reference = referenceKey = undefined;
    workbench.hidden = true;
    if (openedCell?.isConnected) openedCell.focus();
    else boardMarket.focus();
  }

  function paintCurve() {
    const feed = getFeed();
    const live = feed.state === 'connected';
    const reader = live ? liveBoardReader(book, feed.quotes) : marketReader(book, 'snapshot', feed.quotes);
    const reference = marketReader(book, 'settlement', feed.quotes);
    const ids = selectedMarkets();
    const starts = currentStarts();
    const series = ids.map((id, i) => ({ id, label: labels[id], dashed: i > 0,
      points: starts.map(start => readStrategy(selected, id, start, reader) ?? noQuote) }));
    showChart(main.querySelector('#structure-curve'), { label: 'Whole strategy by delivery month', starts,
      series, unit: 'bp', describe: monthLabel, empty: 'No structure values for this selection.' });
    main.querySelector('#structure-curve-source').textContent = `${live ? 'Live VWAP and implied legs when available' : 'Export snapshot'} · ${ids.map(id => labels[id]).join(' / ')}`;
    main.querySelector('#structure-curve-legend').innerHTML = ids.map((id, i) =>
      `<span><i class="legend-line ${i > 0 ? 'dashed' : ''} ${escape(id)}" aria-hidden="true"></i>${escape(labels[id])}</span>`).join('');
    const headers = ids.map(id => `<th scope="col">${escape(labels[id])}</th>`).join('');
    const differenceHeaders = ids.slice(1).map(id => `<th scope="col">${escape(`${labels[ids[0]]} − ${labels[id]}`)}</th>`).join('');
    const rows = starts.map((start, i) => {
      const values = series.map(line => line.points[i].value);
      const ref = readStrategy(selected, ids[0], start, reference)?.value;
      const differences = values.slice(1).map(value => Number.isFinite(values[0]) && Number.isFinite(value) ? values[0] - value : null);
      const change = Number.isFinite(values[0]) && Number.isFinite(ref) ? values[0] - ref : null;
      return `<tr><th scope="row"><button class="button small" type="button" data-structure-delivery="${start}" aria-pressed="${delivery === start}">${escape(monthLabel(start))}</button></th>
        ${values.map(value => `<td class="as-num">${price(value)}</td>`).join('')}
        ${differences.map(value => `<td class="as-num">${price(value)}</td>`).join('')}
        <td class="as-num">${price(ref)}</td><td class="as-num">${price(change)}</td></tr>`;
    }).join('');
    main.querySelector('#structure-deliveries').innerHTML = `<table aria-label="Structure delivery values in basis points"><thead><tr>
      <th scope="col">Delivery</th>${headers}${differenceHeaders}
      <th scope="col">${ids.length > 1 ? 'Primary settlement' : 'Settlement reference'}</th><th scope="col">${ids.length > 1 ? 'Primary ' : ''}Δ vs settlement</th>
      </tr></thead><tbody>${rows}</tbody></table>`;
  }

  function say(message, warning = false) {
    status.textContent = message;
    status.classList.toggle('warning', warning);
  }

  function paintQuotes() {
    quotesPanel.hidden = delivery === undefined;
    if (delivery === undefined) return;
    const feed = getFeed();
    const connected = feed.state === 'connected';
    const onlyVwap = listedVwapReader(feed);
    quotesPanel.innerHTML = selectedMarkets().map((id, index) => {
      const live = connected ? readStrategy(selected, id, delivery, onlyVwap)?.value : null;
      const close = reference?.closes?.[index];
      const change = Number.isFinite(live) && Number.isFinite(close?.value) ? live - close.value : null;
      const dayChange = change === null ? '—' : formatValue(change, 'bp', true);
      const liveStatus = Number.isFinite(live) ? '' : connected ? 'Waiting for leg VWAPs' : 'Feed disconnected';
      const closeStatus = close ? referenceDate.format(Date.parse(close.date))
        : !reference ? 'Loading…' : reference.warning ? 'Close unavailable' : 'No recent common close';
      return `<article class="structure-quote" aria-label="${escape(labels[id])} ${escape(monthLabel(delivery))}">
        <h3>${escape(labels[id])} <small>${escape(monthLabel(delivery))} · bp</small></h3>
        <dl><div><dt>Live VWAP</dt><dd>${price(live)}</dd>${liveStatus ? `<small>${liveStatus}</small>` : ''}</div>
        <div><dt>Previous day close</dt><dd>${price(close?.value)}</dd><small>${closeStatus}</small></div>
        <div><dt>Day change</dt><dd class="${change > 0 ? 'quote-up' : change < 0 ? 'quote-down' : ''}">${dayChange}</dd></div></dl>
      </article>`;
    }).join('');
  }

  function refreshReference(retry = false) {
    if (!selected) return;
    if (delivery === undefined) {
      referenceRequest?.abort();
      referenceKey = undefined;
      reference = undefined;
      paintQuotes();
      return;
    }
    const legs = JSON.stringify(selectedLegs(selectedMarkets()));
    const key = `${formatDate(Date.now())}/${legs}`;
    if (key === referenceKey && !(retry && reference?.warning)) return;
    referenceRequest?.abort();
    const current = referenceRequest = new AbortController();
    referenceKey = key;
    reference = undefined;
    paintQuotes();
    fetch(`/api/structure-reference?${new URLSearchParams({ legs })}`, { signal: current.signal })
      .then(response => response.json())
      .then(data => {
        if (current.signal.aborted) return;
        reference = { closes: data.closes, warning: data.warning || data.error };
        paintQuotes();
      }).catch(() => {
        if (current.signal.aborted) return;
        reference = { warning: true };
        paintQuotes();
      });
  }

  async function loadCandles(keepChart = false) {
    request?.abort();
    if (!keepChart) {
      candlePanel.hidden = true;
      result = undefined;
      viewport = undefined;
    }
    if (delivery === undefined || !form.reportValidity() || fields.from.value > fields.through.value) {
      refreshReference(true);
      say(delivery === undefined ? 'No delivery months are available for this structure.' : 'Choose a valid date range.', true);
      return;
    }
    const current = request = new AbortController();
    const ids = selectedMarkets();
    const legs = selectedLegs(ids);
    const params = new URLSearchParams({ legs: JSON.stringify(legs), interval: fields.interval.value,
      from: fields.from.value, through: fields.through.value });
    say(keepChart ? 'Loading more history…' : `Loading ${monthLabel(delivery)} structure candles…`);
    const end = Date.parse(fields.through.value);
    const recent = new URLSearchParams(params);
    const previewDays = { '10m': 3, '1h': 3, '1d': 21 }[fields.interval.value];
    recent.set('from', formatDate(Math.max(Date.parse(fields.from.value), end - (previewDays - 1) * day)));
    const partial = !keepChart && recent.get('from') !== params.get('from');
    try {
      const cached = recentRequests.get(params.toString());
      if (cached && Date.now() - cached.time < 60_000) {
        refreshReference(true);
        showResult(cached.data, ids);
      } else {
        if (partial) {
          try {
            const previewRequest = fetchCandles(recent, current.signal);
            refreshReference(true);
            const preview = await previewRequest;
            if (current.signal.aborted) return;
            if (preview.series.some(bars => bars.length)) showResult(preview, ids, true);
          } catch { if (current.signal.aborted) return; }
        }
        const full = fetchCandles(params, current.signal);
        refreshReference(true);
        const data = await full;
        if (!current.signal.aborted) showResult(data, ids);
      }
    } catch (error) {
      if (!current.signal.aborted) say(result ? `Recent candles shown. ${error.message}` : error.message, true);
    }
  }

  async function fetchCandles(params, signal) {
    const key = params.toString();
    const cached = recentRequests.get(key);
    if (cached && Date.now() - cached.time < 60_000) return cached.data;
    const response = await fetch(`/api/structure-bars?${params}`, { signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || data.warnings?.join(' ') || 'Structure candles could not be loaded.');
    if (!data.warnings.length) {
      if (recentRequests.size >= 24) recentRequests.delete(recentRequests.keys().next().value);
      recentRequests.set(key, { time: Date.now(), data });
    }
    return data;
  }

  function showResult(data, ids, partial = false) {
    if (!data.series.some(bars => bars.length)) {
      say('No matching traded observations for these legs in the selected dates.', true);
      return;
    }
    const oldSeries = result ? candleSeries.value : '';
    const oldOffset = viewport ? currentBars().length - viewport.end : 0;
    const oldSpan = viewport ? viewport.end - viewport.start : initialBars;
    const series = [...ids.map(id => labels[id]), ...ids.slice(1).map(id => `${labels[ids[0]]} − ${labels[id]}`)];
    const marketCloses = data.series.slice(0, ids.length).map(bars => new Map(bars.map(bar => [bar[0], bar[4]])));
    const times = ids.length > 1 ? [...new Set(marketCloses.flatMap(closes => [...closes.keys()]))].sort((a, b) => a - b) : [];
    const overlay = times.map(stamp => [stamp, ...marketCloses.map(closes => closes.get(stamp))]);
    result = { ...data, ids, overlay };
    const choices = series.map((label, i) => [i, label]);
    if (overlay.length) choices.unshift(['overlay', ids.length === 3 ? 'All three markets' : 'Both markets']);
    candleSeries.innerHTML = options(choices, oldSeries || (ids.length === 3 ? 'overlay' : '0'));
    if (!currentBars().length) candleSeries.value = String(data.series.findIndex(bars => bars.length));
    const sampling = data.sample === '5M' ? '5-minute' : 'hourly';
    say([`${monthLabel(delivery)} · Synthetic OHLC from matched ${sampling} leg closes · UTC · Basis points`,
      ...(partial ? ['Loading the rest of the date range…'] : []), ...data.warnings].join(' · '), data.warnings.length > 0);
    candlePanel.hidden = false;
    if (viewport?.range !== undefined) applyRange(viewport.range);
    else {
      const end = currentBars().length - oldOffset;
      setViewport(end - oldSpan, oldSpan);
    }
  }

  function currentBars() {
    if (candleSeries.value === 'overlay') return result?.overlay ?? [];
    return result?.series[Number(candleSeries.value)] ?? [];
  }

  function visibleBars() {
    return viewport ? currentBars().slice(viewport.start, viewport.end) : [];
  }

  function setViewport(start, size, range, table = true) {
    const count = currentBars().length;
    const span = count ? clamp(Math.round(size), Math.min(8, count), count) : 0;
    const first = clamp(Math.round(start), 0, count - span);
    viewport = { start: first, end: first + span, range };
    hover = undefined;
    if (table) paintCandles();
    else drawCandles();
  }

  function useRange(days) {
    applyRange(days);
    if (!days) return;
    const earliest = Math.max(Date.parse(firstDate), Date.parse(fields.through.value) - (days - 1) * day);
    if (earliest < Date.parse(fields.from.value)) {
      fields.from.value = formatDate(earliest);
      loadCandles(true);
    }
  }

  function applyRange(days) {
    const bars = currentBars();
    const last = bars.at(-1)?.[0];
    const first = days && last !== undefined ? bars.findIndex(bar => bar[0] >= last - days * day) : 0;
    setViewport(first, bars.length - first, days);
  }

  function zoom(factor, anchor = 0.5) {
    if (!viewport) return;
    const size = viewport.end - viewport.start;
    const next = clamp(Math.round(size * factor), Math.min(8, currentBars().length), currentBars().length);
    setViewport(viewport.start + (size - next) * anchor, next);
  }

  function chartAction(action) {
    if (!viewport) return;
    const size = viewport.end - viewport.start;
    if (action === 'in' || action === 'out') zoom(action === 'in' ? 0.65 : 1.55);
    else if (action === 'reset') setViewport(currentBars().length - initialBars, initialBars);
    else setViewport(viewport.start + Math.max(1, Math.round(size * 0.25)) * (action === 'left' ? -1 : 1), size);
  }

  function paintCandles() {
    const bars = visibleBars();
    const count = currentBars().length;
    const windowSize = bars.length;
    const overlay = candleSeries.value === 'overlay';
    const line = chartView.value === 'line';
    canvas.setAttribute('aria-label', overlay ? 'Intermarket structure close comparison' : line ? 'Structure close curve' : 'Structure OHLC candlesticks');
    chartView.closest('label').hidden = overlay;
    const legend = candlePanel.querySelector('#structure-history-legend');
    legend.hidden = !overlay;
    if (overlay) legend.innerHTML = result.ids.map(id => `<span><i class="legend-line ${escape(id)}" aria-hidden="true"></i>${escape(labels[id])}</span>`).join('');
    main.querySelector('#structure-page').textContent = count
      ? Math.min(windowSize, count).toLocaleString('en-GB') + ' of ' + count.toLocaleString('en-GB') + (overlay ? ' time buckets' : ' candles')
      : 'No candles';
    for (const button of candlePanel.querySelectorAll('[data-chart-range]')) {
      button.setAttribute('aria-pressed', String(Number(button.dataset.chartRange) === viewport.range));
    }
    for (const button of candlePanel.querySelectorAll('[data-chart-action]')) {
      const action = button.dataset.chartAction;
      button.disabled = !count || (action === 'in' && windowSize <= 8)
        || (action === 'out' && windowSize === count) || (action === 'left' && viewport.start === 0)
        || (action === 'right' && viewport.end === count);
    }
    const table = candlePanel.querySelector('.structure-ohlc-table');
    table.hidden = overlay;
    if (!overlay) {
      const rows = bars.slice(-60).reverse().map(([stamp, open, high, low, close, samples]) =>
      '<tr><th scope="row">' + escape(stampLabel.format(stamp)) + '</th><td>' + price(open) +
      '</td><td>' + price(high) + '</td><td>' + price(low) + '</td><td>' + price(close) +
      '</td><td>' + samples + '</td></tr>').join('');
      table.innerHTML = '<table aria-label="Structure OHLC in basis points"><thead>' +
        '<tr><th scope="col">Time (UTC)</th><th scope="col">Open</th><th scope="col">High</th><th scope="col">Low</th>' +
        '<th scope="col">Close</th><th scope="col">Samples</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }
    drawCandles();
  }

  function paintReadout(bar) {
    if (!bar) {
      candleReadout.textContent = '';
      return;
    }
    const [stamp, open, high, low, close] = bar;
    const info = document.createElement('strong');
    info.textContent = stampLabel.format(stamp) + ' UTC';
    const levels = document.createElement('span');
    levels.textContent = candleSeries.value === 'overlay'
      ? result.ids.map((id, i) => `${labels[id]} ${price(bar[i + 1])}`).join('  ·  ') + ' bp'
      : 'O ' + price(open) + '   H ' + price(high) + '   L ' + price(low) + '   C ' + price(close) + ' bp';
    candleReadout.replaceChildren(info, levels);
  }

  function drawCandles() {
    if (candlePanel.hidden) return;
    const area = canvasContext(canvas);
    if (!area) return;
    const { context: ctx, width, height } = area;
    const bars = visibleBars();
    const overlay = candleSeries.value === 'overlay';
    const line = chartView.value === 'line';
    const palette = getComputedStyle(canvas);
    const color = name => palette.getPropertyValue('--' + name).trim();
    const muted = color('muted'), grid = color('plot-grid'), accent = color('plot-SR3');
    ctx.font = '12px "Segoe UI", sans-serif';
    ctx.fillStyle = muted;
    if (!bars.length) {
      plot = undefined;
      ctx.textAlign = 'center';
      ctx.fillText('No matching candles for this series.', width / 2, height / 2);
      paintReadout();
      return;
    }
    const left = 61, right = width - 15, bottom = height - 34, top = 16;
    if (right <= left) return;
    const stride = (right - left) / bars.length;
    plot = { left, right, stride };
    let lowest = Infinity, highest = -Infinity;
    for (const bar of bars) {
      if (overlay) {
        for (let i = 1; i < bar.length; i++) {
          if (!Number.isFinite(bar[i])) continue;
          lowest = Math.min(lowest, bar[i]);
          highest = Math.max(highest, bar[i]);
        }
      } else {
        lowest = Math.min(lowest, bar[line ? 4 : 3]);
        highest = Math.max(highest, bar[line ? 4 : 2]);
      }
    }
    const padding = Math.max((highest - lowest) * 0.09, 0.04);
    const low = lowest - padding, high = highest + padding;
    const step = tickStep(high - low);
    const y = value => bottom - (value - low) / (high - low) * (bottom - top);
    const x = index => left + (index + 0.5) * stride;
    ctx.textAlign = 'right';
    for (let tick = Math.ceil(low / step); tick <= Math.floor(high / step); tick++) {
      const level = y(tick * step);
      ctx.strokeStyle = tick === 0 ? color('plot-origin') : grid;
      ctx.beginPath(); ctx.moveTo(left, level); ctx.lineTo(right, level); ctx.stroke();
      ctx.fillText(price(tick * step), left - 7, level + 4);
    }
    const labels = Math.min(bars.length, Math.max(1, Math.floor((right - left) / 96)));
    const multiDay = bars.at(-1)[0] - bars[0][0] > day;
    ctx.textAlign = 'center';
    for (let i = 0; i < labels; i++) {
      const index = Math.floor((i + 0.5) * bars.length / labels);
      const stamp = bars[index][0];
      const label = fields.interval.value === '1d' ? shortDate.format(stamp)
        : multiDay ? `${shortDate.format(stamp)} ${shortTime.format(stamp)}` : shortTime.format(stamp);
      ctx.fillText(label, x(index), height - 10);
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
    if (overlay) {
      result.ids.forEach((id, marketIndex) => {
        ctx.beginPath();
        let drawn = 0, lastIndex;
        bars.forEach((bar, index) => {
          const value = bar[marketIndex + 1];
          if (!Number.isFinite(value)) return;
          if (drawn) ctx.lineTo(x(index), y(value));
          else ctx.moveTo(x(index), y(value));
          drawn++;
          lastIndex = index;
        });
        ctx.fillStyle = ctx.strokeStyle = color(`plot-${id}`);
        ctx.lineWidth = 2;
        ctx.stroke();
        if (drawn === 1) {
          ctx.beginPath(); ctx.arc(x(lastIndex), y(bars[lastIndex][marketIndex + 1]), 3, 0, 2 * Math.PI); ctx.fill();
        }
      });
    } else if (line) {
      const path = () => {
        ctx.beginPath();
        ctx.moveTo(x(0), y(bars[0][4]));
        for (let i = 1; i < bars.length; i++) ctx.lineTo(x(i), y(bars[i][4]));
      };
      path();
      ctx.lineTo(x(bars.length - 1), bottom); ctx.lineTo(x(0), bottom); ctx.closePath();
      const shading = ctx.createLinearGradient(0, top, 0, bottom);
      shading.addColorStop(0, palette.getPropertyValue('--selection-bg').trim());
      shading.addColorStop(1, 'transparent');
      ctx.fillStyle = shading; ctx.fill();
      path();
      ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.stroke();
      if (bars.length === 1) {
        ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(x(0), y(bars[0][4]), 3, 0, Math.PI * 2); ctx.fill();
      }
    } else {
      const strideCount = Math.max(1, Math.ceil(1.3 / stride));
      const body = Math.max(1, Math.min(stride * strideCount * 0.65, 12));
      const up = color('positive'), down = color('negative');
      for (let index = 0; index < bars.length; index += strideCount) {
        const stop = Math.min(index + strideCount, bars.length);
        const opening = bars[index][1], close = bars[stop - 1][4];
        let maximum = bars[index][2], minimum = bars[index][3];
        for (let i = index + 1; i < stop; i++) {
          maximum = Math.max(maximum, bars[i][2]); minimum = Math.min(minimum, bars[i][3]);
        }
        const at = x((index + stop - 1) / 2);
        ctx.strokeStyle = ctx.fillStyle = close >= opening ? up : down;
        ctx.beginPath(); ctx.moveTo(at, y(maximum)); ctx.lineTo(at, y(minimum)); ctx.stroke();
        ctx.fillRect(at - body / 2, y(Math.max(opening, close)), body, Math.max(1, Math.abs(y(close) - y(opening))));
      }
    }
    const index = hover === undefined ? bars.length - 1 : clamp(hover, 0, bars.length - 1);
    if (hover !== undefined) {
      ctx.strokeStyle = color('plot-crosshair'); ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(x(index), top); ctx.lineTo(x(index), bottom); ctx.stroke();
      if (!overlay) {
        ctx.beginPath(); ctx.moveTo(left, y(bars[index][4])); ctx.lineTo(right, y(bars[index][4])); ctx.stroke();
      }
    }
    ctx.restore();
    paintReadout(bars[index]);
  }

  function deliveryOptions(leg) {
    const ids = leg.market === 'same' ? markets.map(({ id }) => id) : [leg.market];
    const starts = curveStarts(book, ids, leg.family, leg.tenor, { earlier: true, cadence: 'all' });
    return [['', 'Use offset'], ...starts.map(start => [start, monthLabel(start)])];
  }

  function editLeg(leg, i) {
    return `<div class="leg-fields" data-structure-leg="${i}">
      <label>Market <select name="market">${options([['same', 'Selected market'], ...marketOptions], leg.market)}</select></label>
      <label>Product <select name="product">${options(products, `${leg.family}/${leg.tenor}`)}</select></label>
      <label>Delivery month <select name="delivery">${options(deliveryOptions(leg), leg.delivery ?? '')}</select></label>
      <label>Weight <input type="number" name="weight" value="${escape(leg.weight)}" step="any" required></label>
      <label>Offset (quarters) <input type="number" name="offset" value="${escape(leg.offset)}" step="1" required${leg.delivery != null ? ' disabled' : ''}></label>
      <button type="button" class="icon-button" data-structure-remove="${i}" aria-label="Remove leg ${i + 1}"${editing.legs.length < 2 ? ' disabled' : ''}>×</button></div>`;
  }

  function openEditor(structure) {
    editing = structure ? structuredClone(structure) : { name: '', legs: [{ market: 'same', family: 'spread', tenor: 3, weight: 1, offset: 0, delivery: null }] };
    if (editing.id?.startsWith('preset-')) {
      delete editing.id;
      editing.name += ' (custom)';
    }
    paintEditor();
    editor.querySelector('[name="name"]').focus();
  }

  function paintEditor() {
    editor.hidden = false;
    editor.innerHTML = `<div class="panel-head"><h2>${editing.id ? 'Edit structure' : 'New structure'}</h2></div>
      <form class="builder"><div class="form-top"><label>Name <input name="name" maxlength="75" required value="${escape(editing.name)}"></label></div>
      ${editing.legs.map(editLeg).join('')}
      <div class="button-row"><button type="button" class="button small" data-structure-action="add">Add leg</button>
      <button type="submit" class="button primary small">Save structure</button>
      <button type="button" class="button small" data-structure-action="cancel">Cancel</button></div>
      <p class="error-text" role="status" hidden></p></form>`;
  }

  editor.addEventListener('input', event => {
    const field = event.target;
    if (field.name === 'name') editing.name = field.value;
    const row = field.closest('[data-structure-leg]');
    if (row && ['weight', 'offset'].includes(field.name)) editing.legs[Number(row.dataset.structureLeg)][field.name] = field.value;
  });
  editor.addEventListener('change', event => {
    const field = event.target;
    if (field.tagName !== 'SELECT') return;
    const row = field.closest('[data-structure-leg]');
    const leg = editing.legs[Number(row.dataset.structureLeg)];
    if (field.name === 'delivery') leg.delivery = field.value === '' ? null : Number(field.value);
    else {
      if (field.name === 'market') leg.market = field.value;
      else {
        const [family, tenor] = field.value.split('/');
        Object.assign(leg, { family, tenor: Number(tenor) });
      }
      const select = row.querySelector('[name="delivery"]');
      select.innerHTML = options(deliveryOptions(leg), leg.delivery ?? '');
      if (!select.value) leg.delivery = null;
    }
    row.querySelector('[name="offset"]').disabled = leg.delivery != null;
  });
  editor.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (button?.dataset.structureAction === 'cancel') editor.hidden = true;
    if (button?.dataset.structureAction === 'add') {
      editing.legs.push({ ...editing.legs[0], weight: -1 });
      paintEditor();
    }
    if (button?.dataset.structureRemove !== undefined && editing.legs.length > 1) {
      editing.legs.splice(Number(button.dataset.structureRemove), 1);
      paintEditor();
    }
  });
  editor.addEventListener('submit', event => {
    event.preventDefault();
    const message = editor.querySelector('[role="status"]');
    const name = editing.name.trim();
    const duplicate = [...presets, ...custom].some(item => item.id !== editing.id && item.name.toLowerCase() === name.toLowerCase());
    if (!name || duplicate || editing.legs.some(leg => !Number.isFinite(Number(leg.weight)) || !Number(leg.weight))) {
      message.textContent = 'Use a unique name and a nonzero weight for every leg.';
      message.hidden = false;
      return;
    }
    const entry = { ...editing, name, id: editing.id ?? crypto.randomUUID(),
      legs: editing.legs.map(leg => ({ ...leg, offset: Number(leg.offset), weight: Number(leg.weight) })) };
    const next = [...custom.filter(item => item.id !== entry.id), entry];
    try { localStorage.setItem(storageKey, JSON.stringify(next)); }
    catch { message.textContent = 'Browser storage is unavailable.'; message.hidden = false; return; }
    custom = next;
    editor.hidden = true;
    drawBoard();
    openStructure(entry);
  });

  main.querySelector('#structure-new').addEventListener('click', () => openEditor());
  board.addEventListener('click', event => {
    const button = event.target.closest('[data-structure-cell]');
    if (!button) return;
    openedCell = button;
    const { structure, start, id } = boardRows[Number(button.dataset.structureCell)];
    openStructure(structure, { start, id });
  });
  main.querySelector('#structure-close').addEventListener('click', closeStructure);
  boardMarket.addEventListener('change', () => {
    if (boardMarket.value !== 'all') activeMarket = boardMarket.value;
    syncComparison();
    drawBoard();
    if (selected) openStructure(selected, { focus: false });
  });
  boardComparison.addEventListener('change', () => {
    if (selected) openStructure(selected, { focus: false });
  });
  boardEarlier.addEventListener('change', drawBoard);
  lookback.addEventListener('change', paintBoardValues);
  form.addEventListener('submit', event => { event.preventDefault(); loadCandles(); });
  form.addEventListener('change', event => {
    if (event.target === fields.interval) { resetDates(); loadCandles(); return; }
    if (event.target === fields.delivery) {
      delivery = Number(fields.delivery.value);
      paintCurve();
      loadCandles();
    }
  });
  earlier.addEventListener('change', () => { syncDelivery(); paintCurve(); loadCandles(); });
  main.querySelector('#structure-deliveries').addEventListener('click', event => {
    const button = event.target.closest('[data-structure-delivery]');
    if (!button) return;
    delivery = Number(button.dataset.structureDelivery);
    fields.delivery.value = delivery;
    paintCurve();
    loadCandles();
    main.querySelector('#structure-history').scrollIntoView({ block: 'start' });
  });
  candleSeries.addEventListener('change', () => chartAction('reset'));
  chartView.addEventListener('change', paintCandles);
  candlePanel.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (button?.dataset.chartAction) chartAction(button.dataset.chartAction);
    if (button?.dataset.chartRange !== undefined) useRange(Number(button.dataset.chartRange));
  });
  canvas.addEventListener('pointerdown', event => {
    if (!plot || event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, start: viewport.start, stride: plot.stride, span: viewport.end - viewport.start };
  });
  canvas.addEventListener('pointermove', event => {
    if (!plot) return;
    if (drag) setViewport(drag.start + (drag.x - event.clientX) / drag.stride, drag.span, undefined, false);
    else {
      const index = event.offsetX >= plot.left && event.offsetX <= plot.right ? Math.floor((event.offsetX - plot.left) / plot.stride) : undefined;
      if (hover !== index) { hover = index; drawCandles(); }
    }
  });
  canvas.addEventListener('lostpointercapture', () => { if (drag) { drag = undefined; paintCandles(); } });
  canvas.addEventListener('pointerleave', () => { hover = undefined; drawCandles(); });
  canvas.addEventListener('wheel', event => {
    if (!plot || !event.deltaY || event.offsetX < plot.left || event.offsetX > plot.right) return;
    if (event.deltaY > 0 && viewport.end - viewport.start >= currentBars().length) return;
    event.preventDefault();
    zoom(event.deltaY < 0 ? 0.82 : 1.22, (event.offsetX - plot.left) / (plot.right - plot.left));
  }, { passive: false });
  canvas.addEventListener('dblclick', () => chartAction('reset'));
  canvas.addEventListener('keydown', event => {
    const action = { '+': 'in', '=': 'in', '-': 'out', '0': 'reset', ArrowLeft: 'left', ArrowRight: 'right' }[event.key];
    if (action) { event.preventDefault(); chartAction(action); }
  });

  resetDates();
  syncComparison();
  drawBoard();
  return {
    draw: drawCandles,
    update() {
      const feed = getFeed();
      const signal = `${feed.state}/${feed.received ?? ''}`;
      if (selected) refreshReference();
      if (lastFeed !== signal) {
        lastFeed = signal;
        paintBoardValues();
        if (selected) { paintCurve(); paintQuotes(); }
      }
    },
    dispose() { request?.abort(); referenceRequest?.abort(); resize.disconnect(); },
  };
}
