import {
  markets, tenors, buildBook, closingRanges, compareHistoricalClose, contractLabel, currentMonth, curveStarts, historicalCloseReader, historicalPercentiles, keyOf, liveBoardReader, londonDay,
  marketReader, minimumPercentileDays, monthLabel, newScenario, outOfScaleOutright, percentileWindows, scenarioModel, scenarioMonths, strategySeries, strategyStarts,
  packageDeliveries, readStrategy, strategyLegArgs, strategyRangeWindows, strategyTenors, typeLabel,
} from './curve-engine.mjs';
import { formatValue, redrawCharts, showChart, sparkline } from './chart.mjs';
import { mountHourly } from './hourly.mjs';
import { createPriceOhlc, mountStrategyHistory } from './strategy-history.mjs';
import { mountStructures } from './structures.mjs';
import { mountMarketSignals } from './market-signals.mjs';

const main = document.querySelector('#main');
const titles = { vwap: 'VWAP Board', prices: 'Live Prices', hourly: 'Hourly History', curves: 'Curves', strategies: 'Strategies', structures: 'Structures', simulator: 'Simulator', signals: 'Market Signals' };
const descriptions = {
  vwap: 'Compare listed futures, calendar spreads, and butterflies across the three rates markets.',
  prices: 'Watch live spreads, flies, and saved strategies across quarterly deliveries.',
  curves: 'Plot the term structure by delivery across SR3, Euribor, and SONIA.',
  strategies: 'Build a weighted package with fixed delivery months or quarterly offsets.',
  simulator: 'Enter spread levels and compare the resulting market and strategy curves.',
};
const marketName = { SR3: 'SR3 · SOFR', I: 'Euribor', SO3: 'SONIA' };
const intermarketPairs = [
  ['SR3', 'I', 'SOFR − Euribor'],
  ['SR3', 'SO3', 'SOFR − SONIA'],
  ['I', 'SO3', 'Euribor − SONIA'],
];
const intermarketCurveSeries = intermarketPairs.map(([left, right, label], index) => ({
  id: markets[index].id, left, right, label,
}));
const intermarketGroups = Object.fromEntries(['spread', 'fly'].map(family => [family, [3, 6, 12].map(tenor => ({
  family, tenor, label: typeLabel(family, tenor),
  rows: intermarketPairs.map(([left, right, label]) => ({
    id: `${left}-${right}`, left, right, label,
    strategy: { legs: [
      { market: left, family, tenor, offset: 0, weight: 1 },
      { market: right, family, tenor, offset: 0, weight: -1 },
    ] },
  })),
}))]));
const allMarketOptions = [['all', 'All markets'], ...markets.map(m => [m.id, marketName[m.id]])];
const priceStructures = [
  ['3MS vs 12MS (4:1) · Q−1', ['spread', 3, 4], ['spread', 12, -1, -1]],
  ['3MS vs 6MS · Q+1', ['spread', 3, 1], ['spread', 6, -1, 1]],
  ['3MS vs 12MS (3:1) · Q−1', ['spread', 3, 3], ['spread', 12, -1, -1]],
  ['6MF vs 12MF (2:1) · Same Q', ['fly', 6, 2], ['fly', 12, -1, 0]],
  ['3MS vs 6MF · Q+1', ['spread', 3, 1], ['fly', 6, -1, 1]],
  ['6MS vs 12MS · Q+2', ['spread', 6, 1], ['spread', 12, -1, 2]],
  ['6MS vs 12MF · Q+1', ['spread', 6, 1], ['fly', 12, -1, 1]],
].map(([name, ...terms]) => ({
  id: name, name,
  legs: terms.map(([family, tenor, weight, offset = 0]) => ({ market: 'same', family, tenor, weight, offset })),
}));
const productOptions = periods => [
  ['out/0', 'Outright'],
  ...['spread', 'fly'].flatMap(family => periods.map(t => [`${family}/${t}`, typeLabel(family, t)])),
];
const typeOptions = productOptions(tenors);
const strategyTypeOptions = productOptions(strategyTenors);
const defaultFilter = () => ({ family: 'out', tenor: 3, market: 'all', cadence: 'quarterly', earlier: false, implied: true });
const filters = { vwap: defaultFilter(), curves: { ...defaultFilter(), from: '', through: '', scale: 'focused' } };
const priceFilters = { market: 'all', family: 'all', mode: 'percentile', horizon: '12', earlier: false, lookback: '30', alertGap: 0.25 };
const lookbackOptions = percentileWindows.map(days => [days, days === 365 ? '1 year (365 days)' : `${days} days`]);
let priceHistory;
let rangeHistory;
const rangeEntries = [];
const rangeFilters = { alerts: false, group: 'all', alertGap: 0.25 };
const rangeGroups = [['all', 'All products and strategies'], ['package', 'Spreads & flies'],
  ['spread', 'Intermarket spreads'], ['fly', 'Intermarket flies'], ['quarterly-structure', 'Quarterly structures'], ['saved', 'Saved strategies']];
const historicalDateFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric',
});
const historicalTickFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', day: 'numeric', month: 'short',
});
const percentileNumberFormat = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 10 });
const historicalDate = day => historicalDateFormat.format(day * 86_400_000);
const historicalTick = day => historicalTickFormat.format(day * 86_400_000);
const londonRefreshTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const curveKey = 'intermarket-curve-view-v1';
try { Object.assign(filters.curves, JSON.parse(sessionStorage.getItem(curveKey) ?? '{}')); }
catch { /* Use the default curve view. */ }
const presets = {
  custom: { name: 'Custom strategy', legs: [{ family: 'spread', tenor: 3, market: 'same', weight: 1, offset: 0 }] },
  fly: { name: '6M fly − 2 × 3M fly', legs: [
    { family: 'fly', tenor: 6, market: 'same', weight: 1, offset: 0 },
    { family: 'fly', tenor: 3, market: 'same', weight: -2, offset: 0 },
  ] },
  spread: { name: '6M spread − 2 × 3M spread', legs: [
    { family: 'spread', tenor: 6, market: 'same', weight: 1, offset: 0 },
    { family: 'spread', tenor: 3, market: 'same', weight: -2, offset: 0 },
  ] },
  cross: { name: 'SR3 − SONIA 6M spread', legs: [
    { family: 'spread', tenor: 6, market: 'SR3', weight: 1, offset: 0 },
    { family: 'spread', tenor: 6, market: 'SO3', weight: -1, offset: 0 },
  ] },
};
const readStored = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
};
const strategyKey = 'intermarket-strategies-v1';
const scenarioKey = 'intermarket-scenarios-v1';
const themeKey = 'intermarket-theme-v1';
const priceLookbackKey = 'intermarket-price-lookback-v1';
const priceAlertGapKey = 'intermarket-price-alert-gap-v1';
const rangeAlertGapKey = 'intermarket-range-alert-gap-v1';
const priceHighlightsKey = 'intermarket-price-highlights-v1';
const savedHighlights = readStored(priceHighlightsKey, {});
const priceHighlights = { price: savedHighlights.price !== false, range: savedHighlights.range !== false };
const savedLookback = Number(readStored(priceLookbackKey, 30));
if (percentileWindows.includes(savedLookback)) priceFilters.lookback = String(savedLookback);
const savedAlertGap = readStored(priceAlertGapKey, priceFilters.alertGap);
if (Number.isFinite(savedAlertGap) && savedAlertGap >= 0) priceFilters.alertGap = savedAlertGap;
const savedRangeAlertGap = readStored(rangeAlertGapKey, rangeFilters.alertGap);
if (Number.isFinite(savedRangeAlertGap) && savedRangeAlertGap >= 0) rangeFilters.alertGap = savedRangeAlertGap;
const themeButton = document.querySelector('#theme-toggle');
let saved = readStored(strategyKey, []);
let draft = { ...structuredClone(presets.fly), preset: 'fly', id: null };
const visiblePercentiles = new Map();
const visibleOhlc = new Map();
const visiblePriceCurves = new Map();
let openPercentile;
let openPriceCurve;
const percentileDialog = document.querySelector('#percentile-dialog');
const priceCurveDialog = document.querySelector('#price-curve-dialog');
const priceCurveView = document.querySelector('#price-curve-view');
const priceCurveCompare = document.querySelector('#price-curve-compare');
const priceCurveDate = document.querySelector('#price-curve-date');
const priceCurveCloseStatus = priceCurveDialog.querySelector('.price-curve-close-status');
const priceCurveLegend = priceCurveDialog.querySelector('.price-curve-legend');
const hiddenPriceCurveLines = { markets: new Set(), differences: new Set() };
const popupLookback = document.querySelector('#percentile-lookback');
const strategyDates = { cadence: 'quarterly', earlier: false, scale: 'focused' };
let scenarios = readStored(scenarioKey, { A: newScenario(), B: newScenario() });
const sim = { active: 'A', market: 'SR3', outputMarket: 'all', output: 'spread/3', compare: 'none', scale: 'focused' };
let source = 'snapshot';
let preferLive = true;
let feed = { state: 'checking', quotes: {} };
let flaggedOutrights = 0;
let screen;
let book;
let catalogueText;
let historyCheckRunning = false;
let hourlyScreen;
let strategyHistory;
let structuresScreen;
let signalsScreen;
let priceOhlc;

function applyTheme(value) {
  const dark = value === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  themeButton.setAttribute('aria-pressed', String(dark));
  themeButton.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  redrawCharts();
  hourlyScreen?.draw();
  structuresScreen?.draw();
  if (book && screen === 'vwap') marketCards(marketReader(book, source, feed.quotes), filters.vwap);
}

applyTheme(readStored(themeKey, 'dark'));
themeButton.addEventListener('click', () => {
  const value = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(value);
  try { localStorage.setItem(themeKey, JSON.stringify(value)); }
  catch { /* The selected theme still applies to the open tab. */ }
});

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const checked = value => value ? ' checked' : '';
const disabled = value => value ? ' disabled' : '';
const badge = (label, color = '') => `<span class="tag ${color}">${escape(label)}</span>`;
const optionList = (choices, val) => choices.map(([value, label]) =>
  `<option value="${escape(value)}"${String(value) === String(val) ? ' selected' : ''}>${escape(label)}</option>`,
).join('');
popupLookback.innerHTML = optionList(lookbackOptions, priceFilters.lookback);
const select = (name, choices, val, attributes = '') =>
  `<select aria-label="${escape(name)}" ${attributes}>${optionList(choices, val)}</select>`;
const segmented = (name, choices, val, attribute) => `
  <div class="segmented" role="group" aria-label="${escape(name)}">
    ${choices.map(([value, label]) => `<button type="button" ${attribute}="${value}" aria-pressed="${val === value}">${label}</button>`).join('')}
  </div>`;
const button = (label, action, cls = '') => `<button type="button" class="button ${cls}" data-action="${action}">${label}</button>`;
const marketLabel = id => id === 'intermarket' ? 'Intermarket'
  : `<span class="market-label"><i class="market-bullet ${id}"></i>${marketName[id]}</span>`;
const range = (month, family, tenor) => contractLabel(family, month, tenor);
const snapshotMode = () => source === 'snapshot' ? 'Export snapshot' : feed.state === 'connected' ? 'Lightstreamer L1' : 'Lightstreamer L1 · disconnected';
const filterDates = () => ({ cadence: 'quarterly', now: currentMonth() });
const activeMarkets = id => id === 'all' ? markets : markets.filter(market => market.id === id);

function header() {
  return `<div class="page-header">
    <div class="page-title"><h1>${titles[screen]}</h1><p>${descriptions[screen]}</p></div>
    ${screen === 'prices' ? badge('Lightstreamer VWAP') : `<label class="input-label">Data source ${select('Data source', [
      ['snapshot', 'Export snapshot'], ['live', 'Live VWAP'],
    ], source, 'id="data-source"')}</label>`}
  </div>`;
}

function updateFeedNotice() {
  const notice = main.querySelector('#feed-notice');
  if (!notice) return;
  const dataSource = screen === 'prices' ? 'live' : source;
  let message = '';
  if (dataSource === 'snapshot') message = 'Snapshot prices come from the supplied export last trade or settlement.';
  if (dataSource === 'live' && feed.state !== 'connected') {
    message = Object.keys(feed.quotes).length
      ? 'Feed interrupted. The latest received VWAP values remain visible.'
      : 'Live VWAP is unavailable. Use Connect live to start the feed.';
  }
  if (dataSource === 'live' && feed.state === 'connected' && feed.failedBatches) {
    message = `${feed.failedBatches} Lightstreamer subscription batches failed. Some contracts may be missing.`;
  }
  if (dataSource === 'live' && flaggedOutrights) {
    const warning = screen === 'prices' ? 'Off-scale input VWAPs are excluded from implied prices.'
      : `${flaggedOutrights} outright VWAPs are out of scale and excluded from calculations.`;
    message = message ? `${message} ${warning}` : warning;
  }
  notice.hidden = !message;
  notice.textContent = message;
  notice.classList.toggle('warning', dataSource === 'live' && !!message);
}

function dateControls(filter) {
  return `<label class="input-label">Delivery ${select('Delivery', [
    ['quarterly', 'Quarterly'], ['all', 'All deliveries'],
  ], filter.cadence, 'data-filter="cadence"')}</label>
  <label class="check"><input type="checkbox" data-filter="earlier"${checked(filter.earlier)}>Earlier contracts</label>`;
}

function marketToolbar(filter) {
  return `<div class="toolbar grouped">
    <div class="control-group">
      ${segmented('Instrument type', [['out', 'Outrights'], ['spread', 'Spreads'], ['fly', 'Flies']], filter.family, 'data-family')}
      ${filter.family === 'out' ? '' : segmented('Tenor', tenors.map(t => [t, `${t}M`]), filter.tenor, 'data-tenor')}
    </div>
    <div class="control-group">
      ${select('Markets', allMarketOptions, filter.market, 'data-filter="market"')}
      ${dateControls(filter)}
      ${filter.family === 'out' ? '' : `<label class="check"><input type="checkbox" data-filter="implied"${checked(filter.implied)}>Include implied</label>`}
    </div>
  </div>`;
}

function persistCurveView() {
  try { sessionStorage.setItem(curveKey, JSON.stringify(filters.curves)); }
  catch { /* The open view remains usable. */ }
}

function scaleSelector(scale, attributes) {
  return `<label class="input-label scale-choice">Y-axis ${select('Y-axis scale', [
    ['focused', 'Focused range'], ['full', 'Full range'],
  ], scale, attributes)}</label>`;
}

function curveWindow(starts, filter) {
  const options = starts.map(start => [String(start), monthLabel(start)]);
  const from = options.filter(([start]) => !filter.through || Number(start) <= Number(filter.through));
  const through = options.filter(([start]) => !filter.from || Number(start) >= Number(filter.from));
  return `<div class="control-group chart-window">
    <span class="input-label">Start delivery</span>
    <label class="input-label">From ${select('From delivery', [['', 'Earliest'], ...from], filter.from, 'data-window="from"')}</label>
    <label class="input-label">Through ${select('Through delivery', [['', 'Latest'], ...through], filter.through, 'data-window="through"')}</label>
    ${scaleSelector(filter.scale, 'data-window="scale"')}
    ${filter.from || filter.through ? button('Reset range', 'curve-reset', 'small') : ''}
  </div>`;
}

function emptyPoints(data) {
  return source === 'live' && !data.series.some(line => line.points.some(Boolean))
    ? 'No live values for this selection.' : 'No values for this selection.';
}

function pointCell(point, unit, rankButton) {
  if (!point) return '<td class="number-cell value-empty" aria-label="Unavailable">—</td>';
  const tone = {
    'L1 VWAP': 'live', 'VWAP legs': 'live', Implied: 'implied', 'Implied legs': 'implied', Scenario: 'scenario',
  }[point.source] ?? '';
  const rankMarkup = point.percentile && rankButton ? percentileButton(point, rankButton, 'tag strategy-percentile') : '';
  return `<td class="number-cell as-num">${formatValue(point.value, unit)}${badge(point.source, tone)}${rankMarkup}</td>`;
}

function curveData(starts, series, reader, unit, label, describe) {
  return {
    starts, unit, label, describe,
    series: series.map(line => ({
      ...line, label: line.label ?? marketName[line.id] ?? line.name,
      points: starts.map(start => reader(line.id, start)),
    })),
  };
}

function valueTable(data, { tall = false, rowType = 'Delivery', strategyFormula = null } = {}) {
  if (!data.starts.length) return '<p class="empty">No contracts match these filters.</p>';
  const heads = data.series.map(line => `<th scope="col" class="number-cell">${escape(line.label)}</th>`).join('');
  const rows = data.starts.map((start, index) => `<tr>
    <th scope="row">${escape(data.describe(start))}</th>
    ${data.series.map(line => {
      const label = `${line.label} · ${monthLabel(start)}`;
      return pointCell(line.points[index], data.unit, strategyFormula === null ? null : {
        key: ['preview', line.id, start], label, context: `${strategyFormula} · ${label}`, kind: 'strategy',
      });
    }).join('')}
  </tr>`).join('');
  const count = data.series.flatMap(line => line.points).filter(Boolean).length;
  return `<div class="table-scroll ${tall ? 'tall' : ''}"><table aria-label="${escape(data.label)}">
    <thead><tr><th class="product-column" scope="col">${rowType}</th>${heads}</tr></thead>
    <tbody>${rows}</tbody></table></div>
    <div class="table-foot"><span>${data.starts.length} delivery dates · ${count} values</span><span>${data.unit === 'bp' ? 'Basis points' : 'Price points'}</span></div>`;
}

function rankSelector(key) {
  return `[data-rank-key="${CSS.escape(key)}"]`;
}

function paintScrollableTable(id, markup) {
  const host = document.getElementById(id);
  if (host.dataset.markup === markup) return;
  host.dataset.markup = markup;
  const scroll = host.querySelector('.table-scroll');
  if (!scroll) {
    host.innerHTML = markup;
    return;
  }
  const template = document.createElement('template');
  template.innerHTML = markup;
  const next = template.content.querySelector('.table-scroll');
  if (!next) {
    host.replaceChildren(template.content);
    return;
  }
  const { scrollTop, scrollLeft } = scroll;
  const active = document.activeElement;
  const focusedRank = scroll.contains(active) ? active.dataset.rankKey : null;
  const focusedOhlc = scroll.contains(active) ? active.dataset.ohlcKey : null;
  const focusedCurve = scroll.contains(active) ? active.dataset.priceCurveKey : null;
  scroll.className = next.className;
  scroll.replaceChildren(...next.childNodes);
  const footer = scroll.nextElementSibling;
  const nextFooter = next.nextElementSibling;
  if (footer?.outerHTML !== nextFooter?.outerHTML) {
    footer?.remove();
    if (nextFooter) scroll.after(nextFooter);
  }
  scroll.scrollTop = scrollTop;
  scroll.scrollLeft = scrollLeft;
  if (focusedRank) scroll.querySelector(rankSelector(focusedRank))?.focus({ preventScroll: true });
  if (focusedOhlc) scroll.querySelector(ohlcSelector(focusedOhlc))?.focus({ preventScroll: true });
  if (focusedCurve) scroll.querySelector(priceCurveSelector(focusedCurve))?.focus({ preventScroll: true });
}

function paintChart(id, data, legendMarkup) {
  const canvas = document.querySelector(`#${id}`);
  const scale = { 'market-chart': filters.curves.scale, 'strategy-chart': strategyDates.scale, 'sim-chart': sim.scale }[id];
  const clipped = showChart(canvas, {
    ...data, empty: data.empty ?? emptyPoints(data), focused: scale === 'focused',
  });
  const legend = canvas.nextElementSibling;
  const entries = legendMarkup ?? data.series.map(line => {
    const sample = `<i class="legend-line ${line.id} ${line.dashed ? 'dashed' : ''}"></i>${escape(line.label)}`;
    return id === 'market-chart'
      ? `<button type="button" data-isolate-market="${line.id}" aria-pressed="${data.series.length === 1}"
        title="${data.series.length === 1 ? 'Show all markets' : `Focus ${escape(line.label)}`}">${sample}</button>`
      : `<span>${sample}</span>`;
  }).join('');
  const markup = entries + (clipped ? `<span class="clipped-note">${clipped} outside scale · see table or Full range</span>` : '')
    + '<span class="zoom-hint">Scroll to zoom · Double-click to reset</span>';
  if (legend.innerHTML !== markup) legend.innerHTML = markup;
}

const chartShell = id => `<div class="chart-shell" id="${id}"></div><div class="chart-legend"></div>`;

function marketShell() {
  const filter = filters[screen];
  const board = screen === 'vwap';
  main.innerHTML = `${header()}${board ? '<div class="market-grid" id="market-cards"></div>' : ''}
    <section class="panel">
      <div class="panel-head"><h2>${board ? 'Instrument ladder' : 'Term structure'}</h2><span id="market-unit"></span></div>
      ${marketToolbar(filter)}
      <p class="notice" id="feed-notice" hidden></p>
      ${board ? '<div id="market-table"></div>' : `<div id="curve-window"></div>${chartShell('market-chart')}`}
    </section>
    ${board ? '' : '<section class="panel"><div class="panel-head"><h2>Curve values</h2></div><div id="market-table"></div></section>'}`;
  updateMarket();
}

function marketCards(reader, filter) {
  const cards = document.querySelector('#market-cards');
  const active = activeMarkets(filter.market).map(market => market.id);
  if (!cards.children.length) {
    cards.innerHTML = markets.map(market => `
      <button type="button" class="market-card" data-market-card="${market.id}">
        <span><span class="card-title"><i class="market-bullet ${market.id}"></i>${market.name}
        <span class="code">${market.exchangeCode}</span></span><strong class="card-value"></strong><span class="card-meta"></span></span>
        <canvas class="sparkline" aria-hidden="true"></canvas>
      </button>`).join('');
  }
  markets.forEach(market => {
    const card = cards.querySelector(`[data-market-card="${market.id}"]`);
    const front = curveStarts(book, [market.id], 'out', 0, filterDates());
    const closest = front[0];
    const point = closest ? reader(market.id, 'out', closest, 0) : null;
    card.setAttribute('aria-pressed', active.length === 1 && active.includes(market.id));
    card.querySelector('.card-value').textContent = formatValue(point?.value, 'price');
    card.querySelector('.card-meta').textContent = closest ? `${monthLabel(closest)} · ${point?.source ?? 'Unavailable'}` : 'No upcoming contracts';
    sparkline(card.querySelector('canvas'), front.slice(0, 12).map(start => reader(market.id, 'out', start)?.value), market);
  });
}

function updateMarket() {
  const filter = filters[screen];
  const { family, market } = filter;
  const tenor = family === 'out' ? 0 : filter.tenor;
  const showMarkets = activeMarkets(market);
  const allStarts = curveStarts(book, showMarkets.map(item => item.id), family, tenor, filter);
  const window = document.querySelector('#curve-window');
  if (window) {
    if (!allStarts.includes(Number(filter.from))) filter.from = '';
    if (!allStarts.includes(Number(filter.through))) filter.through = '';
    const markup = curveWindow(allStarts, filter);
    if (window.dataset.range !== markup) {
      window.innerHTML = markup;
      window.dataset.range = markup;
    }
  }
  const starts = allStarts.filter(start =>
    (!filter.from || start >= Number(filter.from)) && (!filter.through || start <= Number(filter.through)),
  );
  const reader = marketReader(book, source, feed.quotes, filter.implied);
  const unit = family === 'out' ? 'price' : 'bp';
  const data = curveData(starts, showMarkets, (id, start) => reader(id, family, start, tenor),
    unit, typeLabel(family, tenor), start => range(start, family, tenor));
  document.querySelector('#market-unit').innerHTML = badge(`${typeLabel(family, tenor)} · ${unit === 'bp' ? 'bp' : 'price'}`);
  paintScrollableTable('market-table', valueTable(data, { tall: screen === 'vwap', rowType: family === 'out' ? 'Contract' : 'Contract legs' }));
  if (screen === 'vwap') marketCards(reader, filter);
  else paintChart('market-chart', data);
  updateFeedNotice();
}

function priceBoardShell() {
  main.innerHTML = `
    <div class="price-board-overview">
    <div class="price-board-controls">
      <div class="price-board-heading">
        <h1>Live Prices</h1>
        <div class="price-timestamps">
          <button class="button small" type="button" id="range-jump">Range monitor</button>
          <span id="history-refreshed" class="price-updated"></span>
          <span id="price-updated" class="price-updated"></span>
        </div>
      </div>
      <div class="toolbar grouped">
        <div class="control-group">
          ${select('Price board market', allMarketOptions, priceFilters.market, 'data-price-filter="market"')}
          ${select('Package type', [['all', 'Spreads & flies'], ['spread', 'Spreads'], ['fly', 'Flies']],
            priceFilters.family, 'data-price-filter="family"')}
        </div>
        <div class="control-group">
          <label class="input-label">Deliveries ${select('Price board deliveries', [
            ['12', '12 starts'], ['24', '24 starts'], ['all', 'All starts'],
          ], priceFilters.horizon, 'data-price-filter="horizon"')}</label>
          <label class="check"><input type="checkbox" data-price-filter="earlier"${checked(priceFilters.earlier)}>Earlier contracts</label>
          ${select('Display values', [['percentile', 'Price + percentile'], ['level', 'Level (bp)'], ['change', 'Change (bp)']],
            priceFilters.mode, 'data-price-filter="mode"')}
          <label id="price-history-filter" class="input-label" hidden>Lookback
            ${select('Percentile lookback', lookbackOptions,
              priceFilters.lookback, 'data-price-filter="lookback"')}</label>
          <label class="input-label">Alert gap (bp)
            <input id="price-alert-gap" type="number" min="0" step="0.01" value="${priceFilters.alertGap}" required>
          </label>
        </div>
      </div>
      <p id="history-refresh-warning" class="notice warning" role="status" hidden></p>
      <p id="feed-notice" class="notice" hidden></p>
    </div>
    <div class="price-board-grid">
      <section class="panel price-board-panel price-board-wide">
        <div class="panel-head"><h2>Spreads &amp; flies</h2></div>
        <div class="price-panel-table" id="price-packages"></div>
      </section>
      <section class="panel price-board-panel price-board-wide">
        <div class="panel-head"><h2>Quarterly structures</h2></div>
        <div class="price-panel-table" id="price-structures"></div>
      </section>
      ${[['spread', 'Intermarket spread differences'], ['fly', 'Intermarket fly differences']].map(([family, title]) => `
        <section class="panel price-board-panel">
          <div class="panel-head"><h2>${title}</h2></div>
          <div class="price-panel-table" id="price-intermarket-${family}"></div>
        </section>`).join('')}
      <section class="panel price-board-panel price-board-saved">
        <div class="panel-head"><h2>Saved strategies</h2><a href="#strategies" class="button small">Manage strategies</a></div>
        <div class="price-panel-table" id="price-strategies"></div>
      </section>
    </div>
    <footer class="price-board-footer">
      <div class="price-key price-actions-key"><span>Names open curves · Prices open OHLC</span>
        <button type="button" class="highlight-toggle" data-alert-highlight="price" aria-label="Matching market prices">
          <i class="price-match-key" aria-hidden="true"></i><span id="price-alert-key"></span><small aria-hidden="true"></small>
        </button>
        <button type="button" class="highlight-toggle" data-alert-highlight="range">
          <i class="price-range-key" aria-hidden="true"></i>Range high / low alert<small aria-hidden="true"></small>
        </button></div>
      <div id="settlement-key" class="price-key"><span><i class="heat-up heat-mid"></i>Above settlement</span>
        <span><i class="heat-down heat-mid"></i>Below settlement</span>
        <span><i class="heat-flag-key"></i>Off-scale listed quote</span></div>
      <div id="percentile-key" class="price-key" hidden><span><i class="heat-up heat-mid"></i>Higher rank</span>
        <span><i class="heat-down heat-mid"></i>Lower rank</span>
        <span id="price-history-status"></span></div>
    </footer>
    </div>
    <section class="panel price-range-panel" id="range-monitor" aria-labelledby="range-heading">
      <div class="panel-head wrap"><div><h2 id="range-heading" tabindex="-1">Range monitor</h2>
        <p>QuantHub daily-close lows and highs in bp. The range alert covers prices near, at, or beyond a boundary.</p></div>
        <div class="control-group">
          ${select('Range monitor products', rangeGroups, rangeFilters.group, 'id="range-group"')}
          <label class="input-label">Range alert gap (bp)
            <input id="range-alert-gap" type="number" min="0" step="0.01" value="${rangeFilters.alertGap}" required>
          </label>
          <label class="check"><input id="range-alerts-only" type="checkbox"${checked(rangeFilters.alerts)}>Alerts only</label>
        </div>
      </div>
      <div id="price-ranges"></div>
    </section>`;
  for (const button of main.querySelectorAll('[data-alert-highlight]')) {
    const kind = button.dataset.alertHighlight;
    const setHighlight = () => {
      const enabled = priceHighlights[kind];
      main.toggleAttribute(`data-show-${kind}-highlights`, enabled);
      button.setAttribute('aria-pressed', enabled);
      button.querySelector('small').textContent = enabled ? 'On' : 'Off';
    };
    setHighlight();
    button.addEventListener('click', () => {
      priceHighlights[kind] = !priceHighlights[kind];
      setHighlight();
      try { localStorage.setItem(priceHighlightsKey, JSON.stringify(priceHighlights)); }
      catch { /* The setting still applies to the open tab. */ }
    });
  }
  main.querySelector('#range-jump').addEventListener('click', () => {
    const heading = main.querySelector('#range-heading');
    heading.focus({ preventScroll: true });
    heading.closest('section').scrollIntoView({ block: 'start' });
  });
  main.scrollTop = 0;
  updatePriceBoard();
}

function heatCell(point, mode, inspection) {
  const title = inspection.label;
  const flag = `${point?.note ? ' heat-flag' : ''}${inspection.match ? ' heat-price-match' : ''}${inspection.exactMatch ? ' heat-price-exact' : ''}${inspection.rangeAlert ? ' heat-range-alert' : ''}`;
  const tooltipTitle = [title, point?.note, inspection.match, inspection.rangeAlert].filter(Boolean).join('\n');
  if (!Number.isFinite(point?.value)) return `<td class="heat-value value-empty${flag}"
    title="${escape(tooltipTitle)}">${ohlcPrice('—', inspection)}</td>`;
  const levelText = formatValue(point.value, 'bp');
  if (mode === 'percentile') {
    const rank = point.percentile;
    const deviation = rank.value === null ? 0 : rank.value - 50;
    const magnitude = Math.abs(deviation);
    const direction = magnitude < 5 ? '' : deviation > 0 ? 'heat-up' : 'heat-down';
    const strength = magnitude >= 30 ? 'heat-high' : magnitude >= 15 ? 'heat-mid' : 'heat-low';
    const level = `${point.source} ${levelText} bp`;
    const tooltip = `${tooltipTitle}\n${level}\n${rankDetails(rank)}`;
    return `<td class="heat-value heat-paired as-num ${direction} ${direction ? strength : ''}${flag}"
      title="${escape(tooltip)}" aria-label="${escape(tooltip)}">
      ${ohlcPrice(levelText, inspection, point.value)}
      ${percentileButton(point, inspection, `heat-rank${rank.value === null ? ' value-empty' : ''}`)}
    </td>`;
  }
  const change = Number.isFinite(point.reference) ? point.value - point.reference : null;
  const magnitude = Math.abs(change ?? 0);
  const direction = magnitude < .005 ? '' : change > 0 ? 'heat-up' : 'heat-down';
  const strength = magnitude >= 2 ? 'heat-high' : magnitude >= .5 ? 'heat-mid' : 'heat-low';
  const text = mode === 'level' ? levelText : formatValue(change, 'bp', true);
  const details = Number.isFinite(change)
    ? `Export settlement ${formatValue(point.reference, 'bp')} bp · Change ${formatValue(change, 'bp', true)} bp`
    : 'Export settlement unavailable';
  const tooltip = `${tooltipTitle}\n${point.source} ${levelText} bp\n${details}`;
  return `<td class="heat-value as-num ${direction ? `${direction} ${strength}` : ''} ${text === '—' ? 'value-empty' : ''}${flag}"
    title="${escape(tooltip)}"${inspection.match || inspection.rangeAlert ? ` aria-label="${escape(tooltip)}"` : ''}>${ohlcPrice(text, inspection, point.value)}</td>`;
}

function ohlcSelector(key) {
  return `[data-ohlc-key="${CSS.escape(key)}"]`;
}

function ohlcPrice(text, inspection, livePrice) {
  if (!inspection.chart) return `<span class="heat-price">${text}</span>`;
  const key = JSON.stringify(inspection.key);
  visibleOhlc.set(key, { makeTarget: inspection.chart, livePrice, ranges: inspection.ranges });
  return `<button class="heat-price price-ohlc-button" type="button" data-ohlc-key="${escape(key)}" aria-haspopup="dialog"
    aria-label="${escape(`Open OHLC chart for ${inspection.label}${text === '—' ? '' : `, ${text} bp`}`)}">${text}</button>`;
}

function ohlcTarget(label, orders, reader, preferListed = false) {
  const legs = orders.flatMap(order => {
    const [market, family, delivery, tenor, weight] = order;
    const listed = book.listed.has(keyOf(market, family, delivery, tenor));
    if (family === 'out' || (listed && (preferListed || reader(market, family, delivery, tenor)?.source !== 'Implied'))) return [order];
    const multipliers = family === 'spread' ? [1, -1] : [1, -2, 1];
    return packageDeliveries(family, delivery, tenor).map((month, i) => [market, 'out', month, 0, weight * multipliers[i]]);
  });
  return { label, legs, native: legs.length === 1 ? legs[0] : null };
}

function rankedPoint(point, history, rankFor) {
  return { ...point, percentile: rankFor(history), rankFor };
}

function strategyBoardPoint(strategy, id, start, reader, history) {
  const point = readStrategy(strategy, id, start, reader);
  if (!point) return null;
  if (history) return rankedPoint(point, history, sample => sample.strategyRank(strategy, id, start, point, reader, true));
  const reference = readStrategy(strategy, id, start, (...args) => {
    const value = reader(...args)?.reference;
    return Number.isFinite(value) ? { value, source: 'Export settle' } : null;
  });
  return { ...point, reference: reference?.value };
}

function strategyPriceRow(strategy, id, reader, history, available) {
  const hasChart = start => (!available || available.has(start)) && strategy.legs.every(leg => {
    const [market, family, delivery, tenor] = strategyLegArgs(leg, id, start);
    return book.startsByType.get(keyOf(market, family, 0, tenor))?.has(delivery);
  });
  return {
    id, hasChart,
    label: start => `${strategy.name} · ${marketName[id] ?? 'Intermarket'} · ${monthLabel(start)}`,
    chart: (start, label) => ohlcTarget(label, strategy.legs.map(leg => [...strategyLegArgs(leg, id, start), Number(leg.weight)]), reader),
    historyRows: (sample, start) => sample.strategyRows(strategy, id, start, reader),
    read: start => !available || available.has(start) ? strategyBoardPoint(strategy, id, start, reader, history) : null,
  };
}

function boardRanges(row, start, point) {
  const rows = row.historyRows(rangeHistory.history, start, point);
  if (!rangeHistory.ranges.has(rows)) rangeHistory.ranges.set(rows, closingRanges(rows, rangeHistory.today));
  return rangeHistory.ranges.get(rows);
}

function rangeBoundary(price, range, gap) {
  if (feed.state !== 'connected' || !Number.isFinite(price) || range.count < minimumPercentileDays) return '';
  const atLow = compareHistoricalClose(price, range.low) <= 0;
  const atHigh = compareHistoricalClose(price, range.high) >= 0;
  if (atLow && atHigh) return 'At both';
  if (atLow) return 'At low';
  if (atHigh) return 'At high';
  const nearLow = compareHistoricalClose(price - range.low, gap) <= 0;
  const nearHigh = compareHistoricalClose(range.high - price, gap) <= 0;
  return nearLow && nearHigh ? 'Near both' : nearLow ? 'Near low' : nearHigh ? 'Near high' : '';
}

function paintRangeMonitor() {
  const alerts = rangeEntries.filter(entry => entry.extremes.some(Boolean)).length;
  const jump = main.querySelector('#range-jump');
  const jumpLabel = alerts ? `Range monitor · ${alerts} alerts` : 'Range monitor';
  if (jump.textContent !== jumpLabel) jump.textContent = jumpLabel;
  const rows = rangeEntries.filter(entry =>
    (rangeFilters.group === 'all' || entry.group === rangeFilters.group) && (!rangeFilters.alerts || entry.extremes.some(Boolean)),
  ).map(({ name, market, start, price, inspection, extremes }) => `<tr>
    <th scope="row">${escape(name)}</th><td>${escape(market)}</td><td>${monthLabel(start)}</td>
    <td class="number-cell as-num${inspection.rangeAlert ? ' heat-range-alert' : ''}"
      title="${escape(inspection.rangeAlert)}">${ohlcPrice(formatValue(price, 'bp'), inspection, price)}</td>
    ${inspection.ranges.map(({ low, high, count }, index) => {
      const extreme = extremes[index];
      return `<td class="number-cell as-num" title="${count} daily observations">
        ${formatValue(low, 'bp')} / ${formatValue(high, 'bp')}
        ${extreme ? `<span class="range-extreme ${extreme.endsWith('low') ? 'range-low' : extreme.endsWith('high') ? 'range-high' : ''}">${extreme}</span>` : ''}
      </td>`;
    }).join('')}</tr>`).join('');
  paintScrollableTable('price-ranges', rows ? `<div class="table-scroll range-table-scroll" tabindex="0" role="region" aria-label="Scroll strategy ranges">
    <table aria-label="Strategy high and low ranges"><thead><tr><th scope="col">Product / Strategy</th><th scope="col">Market</th>
      <th scope="col">Delivery</th><th scope="col" class="number-cell">Live</th>
      ${strategyRangeWindows.map(days => `<th scope="col" class="number-cell">${days}D low / high</th>`).join('')}
    </tr></thead><tbody>${rows}</tbody></table></div>
    <div class="table-foot"><span>Alerts require at least ${minimumPercentileDays} closes in the window</span><span>Low / high in bp</span></div>`
    : `<p class="empty">${rangeFilters.alerts ? 'No range alerts for this selection.' : 'No products or strategies match these filters.'}</p>`);
}

function percentileButton(point, { key, label, context = label, kind }, className) {
  const { percentile: rank } = point;
  const id = JSON.stringify(key);
  visiblePercentiles.set(id, { point, context, kind, lookback: priceHistory.window, today: priceHistory.today });
  const name = rank.value === null ? 'percentile history' : `percentile ${rank.value.toFixed(1)}`;
  return `<button type="button" class="${className}" data-rank-key="${escape(id)}" aria-haspopup="dialog"
    title="${escape(rankDetails(rank))}" aria-label="${escape(`Inspect ${label} ${name}`)}"
    >${rank.value === null ? '—' : `${Math.round(rank.value)}%`}</button>`;
}

function rankDetails(rank) {
  const result = rank.value === null
    ? `Percentile unavailable · ${rank.count} of at least ${minimumPercentileDays} daily observations`
    : `Percentile ${rank.value.toFixed(1)} · ${rank.below} below, ${rank.tied} tied, ${rank.count} total`;
  const period = rank.count ? ` · ${historicalDate(rank.first)} to ${historicalDate(rank.last)}` : '';
  const rangeLabel = rank.count ? `\nHistorical range ${formatValue(rank.low, 'bp')} to ${formatValue(rank.high, 'bp')} bp` : '';
  return `${priceFilters.lookback}-day ${result}\n${rank.basis}${period}${rangeLabel}`;
}

function selectedHistory() {
  const today = londonDay();
  const window = Number(priceFilters.lookback);
  if (priceHistory?.today !== today || priceHistory.window !== window) {
    priceHistory = { today, window, series: historicalPercentiles(book, today, window) };
  }
  return priceHistory.series;
}

const priceCurveSelector = key => `[data-price-curve-key="${CSS.escape(key)}"]`;

function priceCurveButton(group, starts) {
  const key = JSON.stringify(group.key);
  visiblePriceCurves.set(key, { label: group.label, detail: group.detail, ...group.curve, starts });
  return `<button class="heat-group-button" type="button" data-price-curve-key="${escape(key)}" aria-haspopup="dialog"
    aria-label="${escape(`Show delivery curve for ${group.label}`)}">${escape(group.label)}</button>`;
}

function updateOpenPriceCurve() {
  if (!priceCurveDialog.open) return;
  const curve = visiblePriceCurves.get(openPriceCurve);
  if (!curve) { priceCurveDialog.close(); return; }
  const { describe = monthLabel, starts, label, detail, comparison, liveReader } = curve;
  priceCurveView.closest('label').hidden = !comparison;
  const differences = comparison && priceCurveView.value === 'differences';
  const { series, read } = differences ? comparison : curve;
  const title = differences ? `${label} intermarket difference curve` : `${label} delivery curve`;
  const data = curveData(starts, series, read, 'bp', title, describe);
  const today = londonDay();
  const previous = book.closeDays.findLast(day => day < today);
  const custom = priceCurveCompare.value === 'custom';
  const compare = priceCurveCompare.value !== 'none';
  const isoDate = day => new Date(day * 86_400_000).toISOString().slice(0, 10);
  priceCurveDate.closest('label').hidden = !custom;
  priceCurveDate.min = book.closeDays.length ? isoDate(book.closeDays[0]) : '';
  priceCurveDate.max = isoDate(today - 1);
  const day = custom ? priceCurveDate.valueAsNumber / 86_400_000 : previous;
  const compareLabel = Number.isFinite(day) ? historicalDate(day) : '';
  let historical = null;
  let message = '';
  if (compare && Number.isFinite(day) && day < today) {
    const closeReader = historicalCloseReader(book, day, liveReader);
    historical = curveData(starts, series, (id, start) => read(id, start, closeReader), 'bp', compareLabel, describe);
    message = historical.series.some(line => line.points.some(Boolean))
      ? `QuantHub close · ${compareLabel}`
      : `No QuantHub closes for this selection on ${compareLabel}.`;
  } else if (compare) {
    message = custom ? 'Choose a past closing date.' : 'No previous QuantHub close is published.';
  }
  priceCurveDialog.querySelector('h2').textContent = label;
  const description = differences ? 'First market minus second market, in basis points' : 'Live levels in basis points by delivery';
  priceCurveDialog.querySelector('#price-curve-description').textContent = detail ? `${detail} · ${description}` : description;
  if (priceCurveCloseStatus.textContent !== message) priceCurveCloseStatus.textContent = message;
  const overlay = historical?.series.filter(line => line.points.some(Boolean)).map(line => ({
    ...line, dashed: true, label: `${line.label} · Close`,
  })) ?? [];
  const hidden = hiddenPriceCurveLines[priceCurveView.value];
  const chartLines = [...data.series.map(line => ({ ...line, label: `${line.label} · Live` })), ...overlay].map(line => ({
    ...line, toggleKey: `${line.id}:${line.dashed ? 'close' : 'live'}`,
  }));
  const legend = chartLines.map(line => {
    return `<button type="button" data-price-curve-line="${escape(line.toggleKey)}" aria-pressed="${!hidden.has(line.toggleKey)}">
      <i class="legend-line ${escape(line.id)}${line.dashed ? ' dashed' : ''}" aria-hidden="true"></i>
      ${escape(line.label)}</button>`;
  }).join('');
  const activeLine = document.activeElement?.dataset.priceCurveLine;
  const visibleSeries = chartLines.filter(line => !hidden.has(line.toggleKey));
  paintChart('price-delivery-chart', {
    ...data, series: visibleSeries,
    empty: visibleSeries.length ? undefined : 'Select a line in the legend to show it.',
  }, legend);
  if (activeLine) priceCurveLegend.querySelector(`[data-price-curve-line="${CSS.escape(activeLine)}"]`)?.focus({ preventScroll: true });
  paintScrollableTable('price-delivery-values', historical
    ? comparisonTable(data, historical, compareLabel, { baseLabel: 'Live', rowType: 'Delivery', tableLabel: 'Delivery curve comparison' })
    : valueTable(data));
}

priceCurveLegend.addEventListener('click', event => {
  const id = event.target.closest('[data-price-curve-line]')?.dataset.priceCurveLine;
  if (!id) return;
  const hidden = hiddenPriceCurveLines[priceCurveView.value];
  if (hidden.has(id)) hidden.delete(id);
  else hidden.add(id);
  updateOpenPriceCurve();
});

priceCurveView.addEventListener('change', updateOpenPriceCurve);
priceCurveCompare.addEventListener('change', () => {
  if (priceCurveCompare.value === 'custom' && !priceCurveDate.value) {
    const previous = book.closeDays.findLast(day => day < londonDay());
    if (previous != null) priceCurveDate.valueAsNumber = previous * 86_400_000;
  }
  updateOpenPriceCurve();
});
priceCurveDate.addEventListener('input', updateOpenPriceCurve);
priceCurveDate.addEventListener('change', updateOpenPriceCurve);
priceCurveDialog.addEventListener('close', () => {
  if (openPriceCurve) main.querySelector(priceCurveSelector(openPriceCurve))?.focus({ preventScroll: true });
  openPriceCurve = undefined;
});

function matchingStrategyPrices({ series, read }, starts, maxGap) {
  const limit = Math.round(maxGap * 100);
  return new Map(starts.map(start => {
    const quotes = series.flatMap(({ id }) => {
      const value = read(id, start)?.value;
      return Number.isFinite(value) ? [{ id, ticks: Math.round(Number(formatValue(value, 'bp')) * 100) }] : [];
    });
    const peers = new Map(quotes.map(({ id, ticks }) => [id, quotes.flatMap(other => {
      const gap = Math.abs(ticks - other.ticks);
      return id !== other.id && gap <= limit ? [{ market: marketName[other.id], gap }] : [];
    })]));
    return [start, peers];
  }));
}

function priceMatrix(starts, groups, title, groupName, empty, mode, rowName = 'Market') {
  if (!starts.length || !groups.length) return `<p class="empty">${empty}</p>`;
  const headers = starts.map(start => `<th scope="col" class="heat-value">${monthLabel(start)}</th>`).join('');
  const bodies = groups.map(group => {
    const matches = feed.state === 'connected' && group.matchPrices && group.curve.series.length > 1
      ? matchingStrategyPrices(group.curve, starts, priceFilters.alertGap) : null;
    return `<tbody>${group.rows.map((row, index) => `<tr>
    ${index === 0 ? `<th class="heat-group" scope="rowgroup" rowspan="${group.rows.length}" title="${escape(group.detail ?? group.label)}">${priceCurveButton(group, starts)}</th>` : ''}
    <th class="heat-market" scope="row">${row.marketPair ? escape(row.marketPair) : marketLabel(row.id)}</th>
    ${starts.map(start => {
      const label = row.label(start);
      const point = row.read(start);
      const peers = matches?.get(start).get(row.id);
      const hasChart = row.hasChart(start);
      const ranges = row.historyRows && (hasChart || Number.isFinite(point?.value)) ? boardRanges(row, start, point) : undefined;
      const extremes = ranges?.map(range => rangeBoundary(point?.value, range, rangeFilters.alertGap));
      const rangeAlert = ranges?.flatMap(({ days, low, high }, index) => {
        const extreme = extremes[index];
        return extreme ? [`${days}D ${extreme.toLowerCase()} (${formatValue(low, 'bp')} / ${formatValue(high, 'bp')} bp)`] : [];
      }).join(' · ');
      const inspection = {
        key: [...group.key, row.id, start], label, kind: group.kind,
        match: peers?.length ? `Live price alert · ${peers.map(({ market, gap }) =>
          `${market} (${formatValue(gap / 100, 'bp')} bp apart)`).join(', ')}` : '',
        exactMatch: peers?.some(({ gap }) => gap === 0),
        rangeAlert: rangeAlert ? `Range alert · ${rangeAlert}` : '',
        chart: hasChart ? () => row.chart(start, label) : null, ranges,
        context: group.detail && group.detail !== group.label ? `${label} · ${group.detail}` : label,
      };
      if (ranges) rangeEntries.push({
        group: group.key[0] === 'difference' ? group.key[1] : group.kind === 'strategy' ? group.key[0] : 'package',
        name: group.curve.label ?? group.label, market: row.marketPair ?? marketName[row.id] ?? 'Intermarket',
        start, price: point?.value, inspection, extremes,
      });
      return heatCell(point, mode, inspection);
    }).join('')}
  </tr>`).join('')}</tbody>`;
  }).join('');
  return `<div class="table-scroll heat-scroll" tabindex="0" role="region" aria-label="Scroll ${title.toLowerCase()}"><table class="heat-table" aria-label="${title}">
    <thead><tr><th class="heat-group" scope="col">${groupName}</th><th class="heat-market" scope="col">${rowName}</th>${headers}</tr></thead>
    ${bodies}</table></div>`;
}

function updatePriceBoard() {
  const today = londonDay();
  if (rangeHistory?.today !== today) {
    rangeHistory = { today, history: historicalPercentiles(book, today, strategyRangeWindows.at(-1)), ranges: new WeakMap() };
  }
  rangeEntries.length = 0;
  visiblePercentiles.clear();
  visibleOhlc.clear();
  visiblePriceCurves.clear();
  const selectedMarkets = activeMarkets(priceFilters.market);
  const marketIds = selectedMarkets.map(market => market.id);
  const dates = { ...filterDates(), earlier: priceFilters.earlier };
  const deliveries = new Set();
  for (const family of ['spread', 'fly']) {
    for (const tenor of tenors) {
      for (const start of curveStarts(book, marketIds, family, tenor, dates)) deliveries.add(start);
    }
  }
  const reader = liveBoardReader(book, feed.quotes);
  const percentileMode = priceFilters.mode === 'percentile';
  const history = percentileMode ? selectedHistory() : null;
  if (percentileMode) {
    const window = Number(priceFilters.lookback);
    document.querySelector('#price-history-status').textContent = history.latest === null
      ? `No QuantHub closes in the last ${window} days`
      : `QuantHub daily closes through ${historicalDate(history.latest)} · at least ${minimumPercentileDays} observations`;
  }
  document.querySelector('#price-history-filter').hidden = !percentileMode;
  document.querySelector('#settlement-key').hidden = percentileMode;
  document.querySelector('#percentile-key').hidden = !percentileMode;
  const alertText = priceFilters.alertGap === 0 ? 'Matching market prices blink'
    : `Matching market prices blink · Within ${formatValue(priceFilters.alertGap, 'bp')} bp outlined`;
  const alertKey = document.querySelector('#price-alert-key');
  if (alertKey.textContent !== alertText) alertKey.textContent = alertText;
  const families = priceFilters.family === 'all' ? ['spread', 'fly'] : [priceFilters.family];
  const packages = families.flatMap(family => tenors.map(tenor => ({
    key: [family, tenor], kind: family, label: typeLabel(family, tenor),
    curve: {
      series: markets, liveReader: reader, read: (id, start, quotes = reader) => quotes(id, family, start, tenor),
      describe: start => range(start, family, tenor),
    },
    rows: selectedMarkets.map(({ id }) => ({
      id,
      hasChart: start => book.startsByType.get(keyOf(id, family, 0, tenor))?.has(start),
      chart: (start, label) => ohlcTarget(label, [[id, family, start, tenor, 1]], reader, true),
      historyRows: (sample, start, point) => sample.packageRows(id, family, start, tenor, point),
      read(start) {
        const point = reader(id, family, start, tenor);
        return percentileMode && Number.isFinite(point?.value)
          ? rankedPoint(point, history, sample => sample.rank(id, family, start, tenor, point))
          : point;
      },
      label: start => `${marketName[id]} · ${typeLabel(family, tenor)} · ${range(start, family, tenor)}`,
    })),
  })));
  const strategies = saved.flatMap(strategy => {
    const available = new Set(strategyStarts(book, strategy, dates));
    const rows = strategySeries(strategy).filter(({ id }) =>
      marketIds.includes(id) || (id === 'intermarket' && strategy.legs.some(leg => marketIds.includes(leg.market))),
    ).map(({ id }) => strategyPriceRow(strategy, id, reader, history, available));
    if (!rows.length) return [];
    for (const start of available) deliveries.add(start);
    return [{
      key: ['saved', strategy.id], kind: 'strategy', label: strategy.name, detail: formulaFor(strategy), rows, matchPrices: true,
      curve: {
        series: strategySeries(strategy), liveReader: reader,
        read: (id, start, quotes = reader) => available.has(start) ? readStrategy(strategy, id, start, quotes) : null,
      },
    }];
  });
  const starts = [...deliveries].sort((a, b) => a - b);
  if (priceFilters.horizon !== 'all') starts.length = Math.min(starts.length, Number(priceFilters.horizon));
  paintScrollableTable('price-packages', priceMatrix(starts, packages, 'Live spread and fly prices', 'Package',
    'No upcoming quarterly deliveries.', priceFilters.mode));
  for (const [family, groups] of Object.entries(intermarketGroups)) {
    const differences = groups.map(({ tenor, label, rows }) => ({
      key: ['difference', family, tenor], kind: 'strategy', label,
      curve: {
        label: `${label} · Intermarket differences`,
        series: intermarketCurveSeries,
        liveReader: reader,
        read: (id, start, quotes = reader) => readStrategy(rows[markets.findIndex(market => market.id === id)].strategy, 'intermarket', start, quotes),
        describe: start => range(start, family, tenor),
      },
      rows: rows.filter(({ left, right }) => marketIds.includes(left) || marketIds.includes(right))
        .map(({ id, left, right, label: marketPair, strategy }) => ({
          id, marketPair,
          label: start => `${label} · ${marketPair} · ${range(start, family, tenor)}`,
          hasChart: start => [left, right].every(market => book.startsByType.get(keyOf(market, family, 0, tenor))?.has(start)),
          chart: (start, title) => ohlcTarget(title, [[left, family, start, tenor, 1], [right, family, start, tenor, -1]], reader),
          historyRows: (sample, start) => sample.strategyRows(strategy, 'intermarket', start, reader),
          read: start => strategyBoardPoint(strategy, 'intermarket', start, reader, history),
        })),
    }));
    paintScrollableTable(`price-intermarket-${family}`, priceMatrix(starts, differences, `Live intermarket ${family} differences`,
      'Package', 'No upcoming quarterly deliveries.', priceFilters.mode, 'Market pair'));
  }
  const structures = priceStructures.map(strategy => {
    const read = (id, start, quotes = reader) => readStrategy(strategy, id, start, quotes);
    const comparison = {
      series: intermarketCurveSeries,
      read(id, start, quotes = reader) {
        const { left, right } = intermarketCurveSeries.find(pair => pair.id === id);
        const first = read(left, start, quotes), second = read(right, start, quotes);
        if (!first || !second) return null;
        return { value: first.value - second.value, source: first.source === second.source ? first.source : 'Mixed inputs' };
      },
    };
    return {
      key: ['quarterly-structure', strategy.id], kind: 'strategy', label: strategy.name, detail: formulaFor(strategy),
      matchPrices: true,
      curve: { series: markets, liveReader: reader, read, comparison },
      rows: marketIds.map(id => strategyPriceRow(strategy, id, reader, history)),
    };
  });
  paintScrollableTable('price-structures', priceMatrix(starts, structures, 'Live quarterly structures', 'Structure',
    'No upcoming quarterly deliveries.', priceFilters.mode));
  paintScrollableTable('price-strategies', priceMatrix(starts, strategies, 'Live saved strategy prices', 'Strategy',
    saved.length ? 'No saved strategies match this market.' : 'Strategies appear here when you save them.',
    priceFilters.mode));
  paintRangeMonitor();
  const updated = document.querySelector('#price-updated');
  updated.textContent = feed.received
    ? `Last VWAP update ${new Date(feed.received * 1000).toLocaleTimeString('en-GB', { timeZone: 'Europe/London' })} London`
    : 'Awaiting live prices';
  const refreshed = document.querySelector('#history-refreshed');
  const refreshText = book.historyRefreshedAt === null
    ? 'QuantHub refresh time unavailable'
    : `Last successful QuantHub refresh ${londonRefreshTime.format(book.historyRefreshedAt)} London`;
  if (refreshed.textContent !== refreshText) refreshed.textContent = refreshText;
  const warning = document.querySelector('#history-refresh-warning');
  const failedAt = book.historyRefreshFailedAt;
  const latestFailed = failedAt !== null && (book.historyRefreshedAt === null || failedAt > book.historyRefreshedAt);
  let warningText = '';
  if (latestFailed) {
    const impact = book.historyRefreshedAt === null
      ? 'Awaiting the first successful refresh.'
      : 'Percentiles use the last successful history and may be stale.';
    warningText = `QuantHub refresh failed ${londonRefreshTime.format(failedAt)} London. ${impact}`;
  }
  if (warning.textContent !== warningText) warning.textContent = warningText;
  warning.hidden = !latestFailed;
  updateFeedNotice();
  updateOpenPercentile();
  updateOpenPriceCurve();
  priceOhlc?.updateLivePrice();
}

function formulaFor(strategy) {
  return strategy.legs.map((leg, index) => {
    const weight = Number(leg.weight);
    const sign = weight < 0 ? '− ' : index ? '+ ' : '';
    const terms = [leg.market !== 'same' ? marketName[leg.market] : '', typeLabel(leg.family, leg.tenor)].filter(Boolean).join(' ');
    const shift = Number(leg.offset);
    const timing = leg.delivery != null ? ` [${contractLabel(leg.family, leg.delivery, leg.tenor)}]`
      : shift ? ` [${shift > 0 ? '+' : ''}${shift}Q]` : '';
    return `${sign}${Math.abs(weight) === 1 ? '' : `${Math.abs(weight)} × `}${terms}${timing}`;
  }).join(' ');
}

function savedList() {
  return saved.length ? saved.map(item => {
    const formula = formulaFor(item);
    return `<button type="button" class="saved-strategy" data-strategy-id="${escape(item.id)}"
      aria-pressed="${item.id === draft.id}">${escape(item.name)}
      ${formula === item.name ? '' : `<small>${escape(formula)}</small>`}</button>`;
  }).join('')
    : '<p class="empty">No saved strategies yet.</p>';
}

function legDeliveryChoices(leg) {
  const scope = leg.market === 'same' ? markets.map(market => market.id) : [leg.market];
  const starts = curveStarts(book, scope, leg.family, leg.tenor, { cadence: 'all', earlier: true });
  const choices = new Set(starts);
  if (leg.delivery != null) choices.add(leg.delivery);
  return [['', 'Use offset'], ...[...choices].sort((a, b) => a - b).map(start => [start, monthLabel(start)])];
}

function strategyShell() {
  strategyHistory?.dispose();
  main.innerHTML = `${header()}<div class="strategy-layout">
    <section class="panel">
      <div class="panel-head"><h2>Strategy builder</h2>${button('New strategy', 'strategy-new', 'small')}</div>
      <form class="builder" id="strategy-form">
        <div class="form-top">
          <label>Strategy type ${select('Strategy type', Object.entries(presets).map(([id, item]) => [id, item.name]), draft.preset, 'id="strategy-preset"')}</label>
          <label>Strategy name <input id="strategy-name" required maxlength="75" value="${escape(draft.name)}"></label>
        </div>
        ${draft.legs.map((leg, index) => `<div class="leg-fields" data-leg="${index}">
          <label>Market ${select(`Leg ${index + 1} market`, [['same', 'Same market (each)'], ...markets.map(m => [m.id, marketName[m.id]])], leg.market, 'data-leg-field="market"')}</label>
          <label>Product ${select(`Leg ${index + 1} product`, strategyTypeOptions, `${leg.family}/${leg.tenor}`, 'data-leg-field="product"')}</label>
          <label>Delivery month ${select(`Leg ${index + 1} delivery month`, legDeliveryChoices(leg), leg.delivery ?? '', 'data-leg-field="delivery"')}</label>
          <label>Weight <input type="number" step="any" value="${escape(leg.weight)}" required data-leg-field="weight"></label>
          <label>Start offset (Q) <input type="number" step="1" min="-40" max="40" value="${escape(leg.offset)}" required data-leg-field="offset"${disabled(leg.delivery != null)}></label>
          <button type="button" class="icon-button" data-remove-leg="${index}" aria-label="Remove leg ${index + 1}"${disabled(draft.legs.length === 1)}>×</button>
        </div>`).join('')}
        <div id="formula" class="formula"></div>
        <div class="button-row">
          ${button('Add leg', 'strategy-add', 'small')}
          <button type="submit" class="button primary small">${draft.id ? 'Save changes' : 'Save strategy'}</button>
          ${draft.id ? button('Delete', 'strategy-delete', 'small danger') : ''}
        </div>
        <p id="strategy-status" class="error-text" role="status" hidden></p>
      </form>
    </section>
    <section class="panel"><div class="panel-head"><h2>Saved strategies</h2></div><div class="saved-list">${savedList()}</div></section>
  </div>
  <section class="panel lower-section" id="strategy-hourly" hidden></section>
  <section class="panel lower-section">
    <div class="panel-head"><div><h2>Strategy preview</h2><p>Values are in basis points. Outright price points are multiplied by 100.</p></div></div>
    <div class="toolbar">
      <div class="control-group" id="strategy-delivery-filters">${dateControls(strategyDates)}</div>
      <label class="input-label">Lookback ${select('Strategy percentile lookback',
        lookbackOptions, priceFilters.lookback, 'id="strategy-lookback"')}</label>
    </div>
    <p class="notice" id="feed-notice" hidden></p>
    <div id="strategy-table"></div>
    <p class="scenario-help" id="strategy-history-note"></p>
  </section>
  <section class="panel lower-section" id="strategy-curve-panel">
    <div class="panel-head"><h2>Strategy curve</h2>${badge('bp')}</div>
    <div class="toolbar">${scaleSelector(strategyDates.scale, 'data-filter="scale"')}</div>
    ${chartShell('strategy-chart')}
  </section>`;
  strategyHistory = mountStrategyHistory(main.querySelector('#strategy-hourly'), marketName);
  updateStrategy();
}

const validLegs = strategy => strategy.legs.every(leg =>
  leg.weight !== '' && Number.isFinite(Number(leg.weight)) && Number(leg.weight) !== 0
  && (leg.delivery != null ? Number.isInteger(leg.delivery)
    : leg.offset !== '' && Number.isInteger(Number(leg.offset)) && Math.abs(leg.offset) <= 40),
);

function updateStrategy() {
  visiblePercentiles.clear();
  const valid = validLegs(draft);
  const formula = valid ? formulaFor(draft) : 'Enter nonzero weights and choose a delivery month or a whole-quarter offset for each leg.';
  document.querySelector('#formula').textContent = formula;
  strategyHistory?.update(draft, valid);
  const fixed = draft.legs.every(leg => leg.delivery != null);
  document.querySelector('#strategy-delivery-filters').hidden = fixed;
  document.querySelector('#strategy-curve-panel').hidden = fixed;
  const starts = valid ? strategyStarts(book, draft, strategyDates) : [];
  const history = source === 'live' ? selectedHistory() : null;
  const reader = source === 'live' ? liveBoardReader(book, feed.quotes) : marketReader(book, source, feed.quotes);
  const strategy = draft;
  const data = curveData(starts, strategySeries(strategy), (id, start) => {
    const point = readStrategy(strategy, id, start, reader);
    return history && point ? rankedPoint(point, history, sample => sample.strategyRank(strategy, id, start, point, reader, true)) : point;
  }, 'bp', 'Strategy value by start delivery', monthLabel);
  if (!fixed) paintChart('strategy-chart', data);
  paintScrollableTable('strategy-table', valueTable(data, { tall: true, rowType: 'Start delivery', strategyFormula: formula }));
  document.querySelector('#strategy-lookback').disabled = !history;
  document.querySelector('#strategy-history-note').textContent = history
    ? 'Select a percentile to see the QuantHub dates, leg closes, and strategy values behind it.'
    : 'Select Live VWAP to preview percentiles.';
  updateFeedNotice();
  updateOpenPercentile();
}

function inspectPercentile(key) {
  if (!visiblePercentiles.has(key)) return;
  openPercentile = { key };
  percentileDialog.querySelector('#percentile-chart').replaceChildren();
  updateOpenPercentile();
}

function paintPercentileHistory(rank, kind, observations) {
  const hasLegs = rank.legs.length > 0;
  const headers = rank.legs.map(leg => {
    const label = `${leg.weight.toString().replace(/^-/, '−')} × ${marketName[leg.market]} ${typeLabel(leg.family, leg.tenor)}`;
    const unit = leg.family === 'out' ? 'price points' : 'bp';
    return `<th scope="col" class="number-cell">${escape(label)}
      <small>${escape(contractLabel(leg.family, leg.start, leg.tenor))} · ${unit}</small>
      <small>${escape(leg.basis)}</small></th>`;
  }).join('');
  const rows = observations.map(([day, value, closes = []]) => `<tr>
    <th scope="row">${historicalDate(day)}</th>
    ${closes.map(close => `<td class="number-cell as-num">${percentileNumberFormat.format(close)}</td>`).join('')}
    <td class="number-cell as-num">${percentileNumberFormat.format(value)}</td>
    <td></td>
  </tr>`).join('');
  const valueHeader = hasLegs ? `${kind[0].toUpperCase()}${kind.slice(1)} value (bp)` : 'Listed close (bp)';
  paintScrollableTable('percentile-observations', rows
    ? `<div class="table-scroll tall percentile-scroll" tabindex="0" role="region" aria-label="Daily observations">
        <table><thead><tr><th scope="col">Date</th>${headers}
        <th scope="col" class="number-cell">${valueHeader}</th><th scope="col">Versus shown price</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`
    : `<p class="empty">${hasLegs ? 'No dates with a close for every leg' : 'No listed daily closes'} in this lookback.</p>`);
  const method = hasLegs ? 'Each day uses the sum of the weighted leg closes.' : `Each observation is the listed ${kind} close.`;
  const conversion = rank.legs.some(leg => leg.family === 'out') ? ' Outright price points are multiplied by 100 to convert to bp.' : '';
  percentileDialog.querySelector('#percentile-method').textContent =
    `Percentile = 100 × (below + 0.5 × tied) ÷ observation count. ${method}${conversion}`;
  return percentileDialog.querySelectorAll('#percentile-observations tbody td:last-child');
}

function updateOpenPercentile() {
  if (!openPercentile) return;
  const { key, inspection: previous } = openPercentile;
  if (previous && !percentileDialog.open) return;
  const next = visiblePercentiles.get(key);
  let inspection = next ?? previous;
  if (!next && previous.lookback !== Number(priceFilters.lookback)) {
    const history = selectedHistory();
    const { point } = previous;
    inspection = { ...previous, today: priceHistory.today, lookback: priceHistory.window,
      point: rankedPoint(point, history, point.rankFor) };
  }
  const { point, context, kind, lookback, today } = inspection;
  const { percentile: rank } = point;
  const live = Boolean(next) && feed.state === 'connected';
  const historyChanged = !previous || previous.point.percentile.rows !== rank.rows ||
    previous.lookback !== lookback || previous.today !== today;
  if (!historyChanged && previous.point.value === point.value && previous.context === context && openPercentile.live === live) return;

  const { scrollTop } = percentileDialog;
  const chart = percentileDialog.querySelector('#percentile-chart');
  openPercentile.inspection = inspection;
  openPercentile.live = live;
  if (historyChanged) {
    const observations = [...rank.rows].sort(([a], [b]) => b - a);
    const chronological = [...observations].reverse();
    openPercentile.observations = observations;
    openPercentile.comparisons = paintPercentileHistory(rank, kind, observations);
    openPercentile.chartData = {
      label: `Daily closes and live price over ${lookback} calendar days`,
      starts: chronological.map(([day]) => day),
      series: [{ id: 'SR3', label: 'Daily close', points: chronological.map(([, value]) => ({ value })) }],
      unit: 'bp', describe: historicalDate, tickLabel: historicalTick,
      xRange: [today - lookback, today - 1],
    };
    chart.closest('figure').hidden = observations.length === 0;
  }

  const contextText = `${context} · ${lookback} calendar days`;
  const contextElement = percentileDialog.querySelector('#percentile-context');
  if (contextElement.textContent !== contextText) contextElement.textContent = contextText;
  if (popupLookback.value !== String(lookback)) popupLookback.value = String(lookback);
  const result = rank.value === null ? `Percentile unavailable · requires ${minimumPercentileDays} daily observations`
    : `${rank.value.toFixed(1)} percentile`;
  const priceStatus = live ? 'Live' : 'Last available';
  const referenceLabel = `${priceStatus} price`;
  percentileDialog.querySelector('#percentile-summary').textContent =
    `${priceStatus} ${kind} ${percentileNumberFormat.format(point.value)} bp · ${result} · ${rank.below} below · ${rank.tied} tied · ${rank.count} observations`;
  percentileDialog.querySelector('#percentile-live-key').textContent = `${referenceLabel} · ${formatValue(point.value, 'bp')} bp`;
  const relation = ['Below', 'Tied', 'Above'];
  openPercentile.observations.forEach(([, value], index) => {
    const cell = openPercentile.comparisons[index];
    const label = relation[compareHistoricalClose(value, point.value) + 1];
    if (cell.textContent !== label) cell.textContent = label;
  });

  if (!previous) {
    percentileDialog.showModal();
    const table = percentileDialog.querySelector('.percentile-scroll');
    if (table) table.scrollTo(0, 0);
  }
  if (openPercentile.observations.length) showChart(chart, {
    ...openPercentile.chartData, reference: { label: referenceLabel, value: point.value },
  });
  percentileDialog.scrollTop = previous ? scrollTop : 0;
}

percentileDialog.addEventListener('close', () => {
  if (openPercentile) main.querySelector(rankSelector(openPercentile.key))?.focus({ preventScroll: true });
  openPercentile = null;
});

popupLookback.addEventListener('change', () => {
  savePriceLookback(popupLookback.value);
  updateScreen();
});

function saveStrategy(event) {
  event.preventDefault();
  const status = document.querySelector('#strategy-status');
  const name = draft.name.trim();
  if (!name || !validLegs(draft) || saved.some(item => item.id !== draft.id && item.name.toLowerCase() === name.toLowerCase())) {
    status.textContent = 'Use a unique name, nonzero weights, and delivery months or whole-quarter offsets.';
    status.hidden = false;
    return;
  }
  const entry = { ...structuredClone(draft), name, id: draft.id ?? crypto.randomUUID() };
  const list = [...saved.filter(item => item.id !== entry.id), entry];
  try {
    localStorage.setItem(strategyKey, JSON.stringify(list));
  } catch {
    status.textContent = 'Browser storage is unavailable. The strategy could not be saved.';
    status.hidden = false;
    return;
  }
  saved = list;
  draft = structuredClone(entry);
  strategyShell();
}

function makeModels(scenario, baseline) {
  return Object.fromEntries(markets.map(({ id }) => {
    const starts = scenarioMonths(book, id, filterDates());
    return [id, scenarioModel(starts, scenarios[scenario][id], start => baseline(id, 'out', start)?.value)];
  }));
}

function simulatorShell() {
  const setup = scenarios[sim.active][sim.market];
  const start = scenarioMonths(book, sim.market, filterDates())[0];
  const sameFront = setup.frontMonth == null || setup.frontMonth === start;
  main.innerHTML = `${header()}<div class="simulator-layout">
    <section class="panel">
      <div class="panel-head"><h2>Spread inputs</h2>${segmented('Edit scenario', [['A', 'Scenario A'], ['B', 'Scenario B']], sim.active, 'data-scenario')}</div>
      <div class="toolbar">
        ${select('Input market', allMarketOptions.slice(1), sim.market, 'id="sim-input-market"')}
        ${segmented('Input tenor', [[3, '3M'], [6, '6M']], setup.tenor, 'data-input-tenor')}
      </div>
      <div class="scenario-anchors">
        <label>Front outright anchor <input type="number" step="any" data-sim-field="anchor" value="${sameFront ? escape(setup.anchor) : ''}"></label>
        ${setup.tenor === 6 ? `<label>Front 3M bridge (bp) <input type="number" step="any" data-sim-field="bridge" value="${sameFront ? escape(setup.bridge) : ''}"></label>` : ''}
      </div>
      <div class="table-scroll tall scenario-inputs"><table class="scenario-numbers">
        <thead><tr><th scope="col">Calendar</th><th scope="col" class="number-cell">Base (bp)</th><th scope="col" class="number-cell">Input (bp)</th></tr></thead>
        <tbody id="scenario-inputs"></tbody>
      </table></div>
      <p class="scenario-help" id="scenario-rules"></p>
    </section>
    <section class="panel scenario-results">
      <div class="panel-head"><h2>Scenario ${sim.active} curve</h2><span id="sim-unit"></span></div>
      <div class="toolbar">
        <label class="input-label">Curve ${select('Scenario curve', [...typeOptions, ...saved.map(item => [`saved/${item.id}`, item.name])], sim.output, 'id="sim-output"')}</label>
        ${select('Output market', allMarketOptions, sim.outputMarket, 'id="sim-output-market"')}
        <label class="input-label">Compare with ${select('Compare curves', [
          ['none', 'None'], ['market', 'Market baseline'], ['scenario', `Scenario ${sim.active === 'A' ? 'B' : 'A'}`],
        ], sim.compare, 'id="sim-compare"')}</label>
        ${scaleSelector(sim.scale, 'id="sim-scale"')}
      </div>
      <p class="notice" id="feed-notice" hidden></p>
      ${chartShell('sim-chart')}
    </section>
  </div>
  <section class="panel lower-section"><div class="panel-head"><h2>Scenario values</h2></div><div id="sim-table"></div></section>`;
  updateSimulator(true);
}

function simulatorInputs(model, reset) {
  const area = document.querySelector('#scenario-inputs');
  const setup = scenarios[sim.active][sim.market];
  if (reset) area.innerHTML = model.inputs.map(({ start }) => `<tr>
    <th scope="row">${range(start, 'spread', setup.tenor)}</th>
    <td class="number-cell as-num" data-base="${start}"></td>
    <td class="number-cell"><input aria-label="${range(start, 'spread', setup.tenor)} in basis points"
      type="number" step="any" data-sim-month="${start}" value="${escape(setup.overrides[setup.tenor][start] ?? '')}"></td>
  </tr>`).join('');
  for (const { start, base } of model.inputs) {
    area.querySelector(`[data-base="${start}"]`).textContent = formatValue(base, 'bp');
  }
  const anchor = main.querySelector('[data-sim-field="anchor"]');
  anchor.placeholder = formatValue(model.anchor, 'price');
  const bridge = main.querySelector('[data-sim-field="bridge"]');
  if (bridge) bridge.placeholder = formatValue(model.bridge, 'bp');
  if (reset) {
    const delivery = Number.isFinite(model.first) ? monthLabel(model.first) : 'the first delivery';
    document.querySelector('#scenario-rules').textContent = setup.tenor === 6
      ? `Blank rows use base spreads implied by the outright curve. The ${delivery} anchor sets the price level. The front 3M bridge links the two 6M chains.`
      : `Blank rows use base spreads implied by the outright curve. The ${delivery} anchor sets the outright price level.`;
  }
}

function comparisonTable(data, comparison, compareLabel, {
  baseLabel = `Scenario ${sim.active}`, rowType = 'Contract legs / start', tableLabel = 'Scenario comparison',
} = {}) {
  if (!comparison || !data.starts.length) return valueTable(data, { tall: true, rowType });
  const heads = data.series.map(line => `<th colspan="3" scope="colgroup" class="number-cell">${escape(line.label)}</th>`).join('');
  const metrics = data.series.map(() => `<th scope="col" class="number-cell">${escape(baseLabel)}</th>
    <th scope="col" class="number-cell">${escape(compareLabel)}</th><th scope="col" class="number-cell">Δ</th>`).join('');
  const rows = data.starts.map((month, index) => `<tr><th scope="row">${escape(data.describe(month))}</th>
    ${data.series.map((line, lineIndex) => {
      const a = line.points[index], b = comparison.series[lineIndex].points[index];
      const diff = a && b ? a.value - b.value : null;
      const tone = diff > 0 ? 'delta-positive' : diff < 0 ? 'delta-negative' : 'value-empty';
      return `${pointCell(a, data.unit)}${pointCell(b, data.unit)}<td class="number-cell as-num ${tone}">${formatValue(diff, data.unit, true)}</td>`;
    }).join('')}</tr>`).join('');
  return `<div class="table-scroll"><table aria-label="${escape(tableLabel)}">
    <thead><tr><th rowspan="2" scope="col">${escape(rowType)}</th>${heads}</tr><tr>${metrics}</tr></thead><tbody>${rows}</tbody>
    </table></div><div class="table-foot"><span>Δ = ${escape(baseLabel)} minus ${escape(compareLabel)}</span><span>${data.unit === 'bp' ? 'Basis points' : 'Price points'}</span></div>`;
}

function updateSimulator(reset = false) {
  const baseline = marketReader(book, source, feed.quotes);
  const other = sim.active === 'A' ? 'B' : 'A';
  const models = makeModels(sim.active, baseline);
  simulatorInputs(models[sim.market], reset);
  const [family, code] = sim.output.split('/');
  const tenor = Number(code);
  const strategy = family === 'saved' ? saved.find(item => item.id === code) : null;
  const scope = strategy ? strategySeries(strategy).filter(line =>
    sim.outputMarket === 'all' || line.id === sim.outputMarket || line.id === 'intermarket') : activeMarkets(sim.outputMarket);
  const series = scope.map(line => ({ ...line, label: marketName[line.id] ?? line.name }));
  const dates = filterDates();
  const starts = strategy ? strategyStarts(book, strategy, dates) : curveStarts(book, scope.map(line => line.id), family, tenor, dates);
  const describe = strategy ? monthLabel : start => range(start, family, tenor);
  const unit = family === 'out' ? 'price' : 'bp';
  const label = strategy?.name ?? typeLabel(family, tenor);
  const asReader = model => (market, kind, month, term) => model[market].read(kind, month, term);
  const create = read => curveData(starts, series, (id, start) =>
    strategy ? readStrategy(strategy, id, start, read) : read(id, family, start, tenor), unit, label, describe);
  const active = create(asReader(models));
  let chart = active, comparison = null, compareLabel = '';
  if (sim.compare !== 'none') {
    compareLabel = sim.compare === 'market' ? 'Market baseline' : `Scenario ${other}`;
    comparison = create(sim.compare === 'market' ? baseline : asReader(makeModels(other, baseline)));
    chart = { ...active, series: [
      ...active.series.map(line => ({ ...line, label: `${line.label} · ${sim.active}` })),
      ...comparison.series.map(line => ({ ...line, dashed: true, label: `${line.label} · ${compareLabel}` })),
    ] };
  }
  document.querySelector('#sim-unit').innerHTML = badge(unit === 'bp' ? 'bp' : 'price');
  paintChart('sim-chart', chart);
  paintScrollableTable('sim-table', comparisonTable(active, comparison, compareLabel));
  updateFeedNotice();
}

function showScreen() {
  priceOhlc?.close();
  if (priceCurveDialog.open) priceCurveDialog.close();
  hourlyScreen?.dispose();
  hourlyScreen = undefined;
  strategyHistory?.dispose();
  strategyHistory = undefined;
  structuresScreen?.dispose();
  structuresScreen = undefined;
  signalsScreen?.dispose();
  signalsScreen = undefined;
  const route = location.hash.slice(1);
  screen = Object.hasOwn(titles, route) ? route : 'vwap';
  document.body.classList.toggle('price-board-screen', screen === 'prices' || screen === 'signals');
  document.body.classList.toggle('signals-screen', screen === 'signals');
  document.querySelector('#breadcrumb').textContent = titles[screen];
  document.querySelectorAll('nav a').forEach(link => {
    if (link.hash === `#${screen}`) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if (!book) return;
  if (screen === 'prices') priceBoardShell();
  else if (screen === 'hourly') hourlyScreen = mountHourly(main, book, marketName, () => feed);
  else if (screen === 'strategies') strategyShell();
  else if (screen === 'structures') structuresScreen = mountStructures(main, book, () => feed);
  else if (screen === 'signals') signalsScreen = mountMarketSignals(main, () => book, () => feed, priceStructures, () => saved);
  else if (screen === 'simulator') simulatorShell();
  else marketShell();
  main.removeAttribute('aria-busy');
}

function updateScreen() {
  if (!book || screen === 'hourly' || screen === 'structures') return;
  if (screen === 'prices') updatePriceBoard();
  else if (screen === 'signals') signalsScreen?.update();
  else if (screen === 'strategies') updateStrategy();
  else if (screen === 'simulator') updateSimulator();
  else updateMarket();
}

main.addEventListener('click', event => {
  const target = event.target.closest('button');
  if (!target) return;
  if (target.dataset.priceCurveKey) {
    openPriceCurve = target.dataset.priceCurveKey;
    for (const hidden of Object.values(hiddenPriceCurveLines)) hidden.clear();
    priceCurveView.value = 'markets';
    priceCurveCompare.value = 'previous';
    priceCurveDate.value = '';
    priceCurveDialog.showModal();
    updateOpenPriceCurve();
    return;
  }
  if (target.dataset.rankKey) {
    inspectPercentile(target.dataset.rankKey);
    return;
  }
  if (target.dataset.ohlcKey) {
    const key = target.dataset.ohlcKey;
    const entry = visibleOhlc.get(key);
    if (entry) {
      priceOhlc ??= createPriceOhlc();
      const priceHost = target.closest('.price-panel-table, #price-ranges');
      priceOhlc.open(entry.makeTarget(), () => target.isConnected ? target.focus({ preventScroll: true })
        : priceHost?.querySelector(ohlcSelector(key))?.focus({ preventScroll: true }), key,
        () => feed.state === 'connected' ? visibleOhlc.get(key)?.livePrice : undefined, entry.ranges);
    }
    return;
  }
  const { family, tenor, marketCard, isolateMarket, scenario, inputTenor, strategyId, removeLeg, action } = target.dataset;
  if (family || tenor || marketCard || isolateMarket) {
    const filter = filters[screen];
    if (family) filter.family = family;
    if (tenor) filter.tenor = Number(tenor);
    if (marketCard) filter.market = filter.market === marketCard ? 'all' : marketCard;
    if (isolateMarket) filter.market = filter.market === isolateMarket ? 'all' : isolateMarket;
    marketShell();
    if (screen === 'curves') persistCurveView();
  } else if (action === 'curve-reset') {
    Object.assign(filters.curves, { from: '', through: '' });
    updateMarket();
    persistCurveView();
  } else if (scenario || inputTenor) {
    if (scenario) sim.active = scenario;
    if (inputTenor) {
      scenarios[sim.active][sim.market].tenor = Number(inputTenor);
      saveScenarios();
    }
    simulatorShell();
  } else if (strategyId) {
    draft = structuredClone(saved.find(item => item.id === strategyId));
    strategyShell();
  } else if (removeLeg !== undefined && draft.legs.length > 1) {
    draft.legs.splice(Number(removeLeg), 1);
    strategyShell();
  } else if (action === 'strategy-new') {
    draft = { ...structuredClone(presets.custom), preset: 'custom', id: null };
    strategyShell();
  } else if (action === 'strategy-add') {
    draft.legs.push(structuredClone(presets.custom.legs[0]));
    strategyShell();
  } else if (action === 'strategy-delete' && window.confirm(`Delete “${draft.name}”?`)) {
    const list = saved.filter(item => item.id !== draft.id);
    try {
      localStorage.setItem(strategyKey, JSON.stringify(list));
    } catch {
      const status = document.querySelector('#strategy-status');
      status.hidden = false;
      status.textContent = 'The saved strategy could not be removed from browser storage.';
      return;
    }
    if (sim.output === `saved/${draft.id}`) sim.output = 'spread/3';
    saved = list;
    draft = { ...structuredClone(presets.fly), preset: 'fly', id: null };
    strategyShell();
  }
});

main.addEventListener('input', event => {
  const field = event.target;
  if (field.id === 'price-alert-gap' || field.id === 'range-alert-gap') {
    savePriceAlertGap(field);
    return;
  }
  const { legField, simField, simMonth } = field.dataset;
  if (field.id === 'strategy-name') draft.name = field.value;
  if (legField && field.tagName === 'INPUT') {
    draft.legs[Number(field.closest('[data-leg]').dataset.leg)][legField] = field.value;
    updateStrategy();
  }
  if (simField || simMonth) {
    if (field.validity.badInput) return;
    const setup = scenarios[sim.active][sim.market];
    if (simField) {
      const start = scenarioMonths(book, sim.market, filterDates())[0];
      if (setup.frontMonth != null && setup.frontMonth !== start) {
        setup.anchor = '';
        setup.bridge = '';
      }
      setup.frontMonth = start;
      setup[simField] = field.value;
    } else if (field.value === '') delete setup.overrides[setup.tenor][simMonth];
    else setup.overrides[setup.tenor][simMonth] = field.value;
    saveScenarios();
    updateSimulator();
  }
});

function saveScenarios() {
  try { localStorage.setItem(scenarioKey, JSON.stringify(scenarios)); }
  catch { /* Inputs remain available for this session. */ }
}

function savePriceLookback(value) {
  priceFilters.lookback = value;
  const field = main.querySelector('#strategy-lookback, [data-price-filter="lookback"]');
  if (field && field.value !== value) field.value = value;
  try { localStorage.setItem(priceLookbackKey, JSON.stringify(Number(value))); }
  catch { /* The selected lookback still applies to the open tab. */ }
}

function savePriceAlertGap(field) {
  const gap = field.valueAsNumber;
  const isRange = field.id === 'range-alert-gap';
  const filters = isRange ? rangeFilters : priceFilters;
  if (!field.validity.valid || !Number.isFinite(gap) || gap === filters.alertGap) return;
  filters.alertGap = gap;
  try { localStorage.setItem(isRange ? rangeAlertGapKey : priceAlertGapKey, JSON.stringify(gap)); }
  catch { /* The selected gap still applies to the open tab. */ }
  updatePriceBoard();
}

main.addEventListener('change', event => {
  const field = event.target;
  if (field.id === 'range-group' || field.id === 'range-alerts-only') {
    if (field.id === 'range-group') rangeFilters.group = field.value;
    else rangeFilters.alerts = field.checked;
    paintRangeMonitor();
    return;
  }
  if (field.id === 'price-alert-gap' || field.id === 'range-alert-gap') {
    savePriceAlertGap(field);
    field.value = (field.id === 'range-alert-gap' ? rangeFilters : priceFilters).alertGap;
    return;
  }
  if (field.id === 'strategy-lookback') {
    savePriceLookback(field.value);
    updateStrategy();
    return;
  }
  if (field.dataset.priceFilter) {
    priceFilters[field.dataset.priceFilter] = field.type === 'checkbox' ? field.checked : field.value;
    if (field.dataset.priceFilter === 'lookback') savePriceLookback(field.value);
    updatePriceBoard();
    if (field.dataset.priceFilter === 'mode') checkPublishedHistory();
    return;
  }
  if (field.id === 'data-source') {
    source = field.value;
    preferLive = false;
    updateScreen();
    checkPublishedHistory();
    return;
  }
  if (field.dataset.filter) {
    const settings = screen === 'strategies' ? strategyDates : filters[screen];
    settings[field.dataset.filter] = field.type === 'checkbox' ? field.checked : field.value;
    updateScreen();
    if (screen !== 'strategies') document.querySelector('[data-filter="market"]').value = settings.market;
    if (screen === 'curves') persistCurveView();
    return;
  }
  if (field.dataset.window) {
    filters.curves[field.dataset.window] = field.value;
    updateMarket();
    persistCurveView();
    return;
  }
  if (field.id === 'strategy-preset') {
    const preset = presets[field.value];
    draft = { ...structuredClone(preset), preset: field.value, id: draft.id };
    strategyShell();
    return;
  }
  if (field.dataset.legField && field.tagName === 'SELECT') {
    const row = field.closest('[data-leg]');
    const leg = draft.legs[Number(row.dataset.leg)];
    if (field.dataset.legField === 'market') leg.market = field.value;
    else if (field.dataset.legField === 'delivery') {
      leg.delivery = field.value === '' ? null : Number(field.value);
      row.querySelector('[data-leg-field="offset"]').disabled = leg.delivery != null;
    }
    else {
      const [family, tenor] = field.value.split('/');
      Object.assign(leg, { family, tenor: Number(tenor) });
    }
    if (field.dataset.legField !== 'delivery') {
      row.querySelector('[data-leg-field="delivery"]').innerHTML = optionList(legDeliveryChoices(leg), leg.delivery ?? '');
    }
    updateStrategy();
  }
  if (field.id === 'sim-input-market') {
    sim.market = field.value;
    simulatorShell();
  }
  const simSelects = { 'sim-output': 'output', 'sim-output-market': 'outputMarket', 'sim-compare': 'compare', 'sim-scale': 'scale' };
  if (simSelects[field.id]) {
    sim[simSelects[field.id]] = field.value;
    updateSimulator();
  }
});

main.addEventListener('submit', event => {
  if (event.target.id === 'strategy-form') saveStrategy(event);
});

const dialog = document.querySelector('#feed-dialog');
const signIn = document.querySelector('#signin-form');
let detailState;
let signInError = '';

function paintConnection() {
  const state = feed.state;
  const connected = state === 'connected';
  const active = ['signing-in', 'connecting', 'connected'].includes(state);
  const checking = state === 'checking' || state === 'unreachable';
  const status = document.querySelector('#feed-status');
  const count = Object.keys(feed.quotes).length - flaggedOutrights;
  status.className = `feed-status ${connected && count ? 'is-live' : active ? 'is-pending' : state === 'error' ? 'is-error' : ''}`;
  const statusLabel = connected ? (count ? `Live · ${count} VWAPs` : 'Awaiting VWAP')
    : { checking: 'Checking connection', 'signing-in': feed.device ? 'Sign-in pending' : 'Connecting', connecting: 'Connecting', error: 'Feed error', unreachable: 'Server unavailable' }[state] ?? 'Snapshot mode';
  status.innerHTML = `<span></span>${escape(statusLabel)}`;
  status.title = feed.received ? `Last new VWAP ${new Date(feed.received * 1000).toLocaleTimeString('en-GB', { timeZone: 'Europe/London' })} London time` : snapshotMode();
  document.querySelector('#feed-open').textContent = active || checking || state === 'error' ? 'Feed details' : 'Connect live';
  signIn.hidden = active || checking;
  const signature = [state, feed.message, feed.device?.code, feed.resumeWarning, signInError].join('|');
  if (signature === detailState) return;
  detailState = signature;
  const detail = document.querySelector('#connection-detail');
  const device = feed.device;
  const message = signInError || (connected ? 'Connected to the Lightstreamer L1 adapter.' : feed.message);
  detail.innerHTML = `${message ? `<p>${escape(message)}</p>` : ''}
    ${feed.resumeWarning ? `<p>${escape(feed.resumeWarning)}</p>` : ''}
    ${device ? `<div class="device-code">${escape(device.code)}</div><p>
      <a class="button primary small" href="https://microsoft.com/devicelogin" target="_blank" rel="noopener noreferrer">Open Microsoft sign-in</a></p>` : ''}
    ${active || state === 'error' ? button(connected ? 'Disconnect' : 'Clear connection', 'feed-disconnect', 'small') : ''}`;
}

async function refreshFeed() {
  const old = feed;
  try {
    const response = await fetch('/api/feed', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error();
    feed = await response.json();
  } catch {
    feed = { ...feed, state: 'unreachable', message: 'The local dashboard server is unavailable.', device: null };
  }
  flaggedOutrights = book ? [...book.listed.values()].filter(item => outOfScaleOutright(item, feed.quotes[item.id])).length : 0;
  const switched = preferLive && feed.state === 'connected' && Object.keys(feed.quotes).length > flaggedOutrights;
  if (switched) {
    source = 'live';
    preferLive = false;
    const selectSource = document.querySelector('#data-source');
    if (selectSource) selectSource.value = 'live';
  }
  if ((source === 'live' || screen === 'prices' || screen === 'signals') && (switched || old.received !== feed.received || old.state !== feed.state ||
    old.failedBatches !== feed.failedBatches || Object.keys(old.quotes).length !== Object.keys(feed.quotes).length)) updateScreen();
  hourlyScreen?.updateCurrent();
  structuresScreen?.update();
  paintConnection();
}

document.querySelector('#feed-open').addEventListener('click', () => {
  dialog.showModal();
  paintConnection();
});

async function feedAction(path, body) {
  const response = await fetch(`/api/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error((await response.json()).error);
}

signIn.addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  signInError = '';
  try {
    await feedAction('connect', { email: document.querySelector('#signin-email').value.trim() });
    preferLive = true;
    await refreshFeed();
  } catch (error) {
    signInError = error.message || 'Could not start sign-in.';
    paintConnection();
  } finally {
    button.disabled = false;
  }
});

dialog.addEventListener('click', async event => {
  if (event.target.dataset.action !== 'feed-disconnect') return;
  try {
    await feedAction('disconnect', {});
    preferLive = false;
    await refreshFeed();
  } catch (error) {
    signInError = error.message;
    paintConnection();
  }
});

async function pollFeed() {
  await refreshFeed();
  window.setTimeout(pollFeed, 1000);
}

async function loadCatalogue() {
  const response = await fetch('/catalog.json', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('Could not load the instrument catalogue.');
  const text = await response.text();
  if (text === catalogueText) return false;
  book = buildBook(JSON.parse(text));
  catalogueText = text;
  priceHistory = undefined;
  rangeHistory = undefined;
  return true;
}

async function checkPublishedHistory() {
  const viewing = () => screen === 'prices' || screen === 'signals' || (screen === 'strategies' && source === 'live');
  if (!viewing() || document.hidden || historyCheckRunning) return;
  historyCheckRunning = true;
  try {
    const updated = await loadCatalogue();
    if (viewing() && (updated || ((screen === 'strategies' || priceFilters.mode === 'percentile')
      && priceHistory?.today !== londonDay()))) updateScreen();
  } catch {
    // Keep the published history visible while the local server is unavailable.
  } finally {
    historyCheckRunning = false;
  }
}

window.addEventListener('hashchange', () => {
  if (percentileDialog.open) percentileDialog.close();
  showScreen();
  window.scrollTo(0, 0);
  checkPublishedHistory();
});
document.addEventListener('visibilitychange', checkPublishedHistory);
window.addEventListener('storage', event => {
  if (event.key === themeKey) {
    applyTheme(readStored(themeKey, 'dark'));
    return;
  }
  if (event.key !== strategyKey) return;
  saved = readStored(strategyKey, []);
  if (!book) return;
  if (screen === 'prices') updatePriceBoard();
  if (screen === 'signals') signalsScreen?.update();
  if (screen === 'strategies') main.querySelector('.saved-list').innerHTML = savedList();
  if (screen === 'simulator') {
    if (sim.output.startsWith('saved/') && !saved.some(item => `saved/${item.id}` === sim.output)) sim.output = 'spread/3';
    simulatorShell();
  }
});
window.addEventListener('resize', () => {
  if (screen === 'vwap' && book) marketCards(marketReader(book, source, feed.quotes), filters.vwap);
});

try {
  await loadCatalogue();
  showScreen();
  pollFeed();
  window.setInterval(checkPublishedHistory, 120_000);
} catch {
  main.innerHTML = '<p class="notice warning">The instrument catalogue could not be loaded. Restart the local dashboard.</p>';
  main.removeAttribute('aria-busy');
}
