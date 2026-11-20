import {
  markets, tenors, buildBook, compareHistoricalClose, contractLabel, currentMonth, curveStarts, historicalPercentiles, liveBoardReader, londonDay,
  marketReader, minimumPercentileDays, monthLabel, newScenario, outOfScaleOutright, percentileWindows, scenarioModel, scenarioMonths, strategySeries, strategyStarts,
  readStrategy, typeLabel,
} from './curve-engine.mjs';
import { formatValue, redrawCharts, showChart, sparkline } from './chart.mjs';

const main = document.querySelector('#main');
const titles = { vwap: 'VWAP Board', prices: 'Live Prices', curves: 'Curves', strategies: 'Strategies', simulator: 'Simulator' };
const descriptions = {
  vwap: 'Compare listed futures, calendar spreads, and butterflies across the three rates markets.',
  prices: 'Watch live spreads, flies, and saved strategies across quarterly deliveries.',
  curves: 'Plot the term structure by delivery across SR3, Euribor, and SONIA.',
  strategies: 'Build a weighted package once and see its value across delivery dates.',
  simulator: 'Enter spread levels and compare the resulting market and strategy curves.',
};
const marketName = { SR3: 'SR3 · SOFR', I: 'Euribor', SO3: 'SONIA' };
const allMarketOptions = [['all', 'All markets'], ...markets.map(m => [m.id, marketName[m.id]])];
const typeOptions = [
  ['out/0', 'Outright'],
  ...['spread', 'fly'].flatMap(family => tenors.map(t => [`${family}/${t}`, typeLabel(family, t)])),
];
const defaultFilter = () => ({ family: 'out', tenor: 3, market: 'all', cadence: 'quarterly', earlier: false, implied: true });
const filters = { vwap: defaultFilter(), curves: { ...defaultFilter(), from: '', through: '', scale: 'focused' } };
const priceFilters = { market: 'all', family: 'all', mode: 'percentile', horizon: '12', earlier: false, lookback: '30' };
const lookbackOptions = percentileWindows.map(days => [days, `${days} days`]);
let priceHistory;
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
const savedLookback = Number(readStored(priceLookbackKey, 30));
if (percentileWindows.includes(savedLookback)) priceFilters.lookback = String(savedLookback);
const themeButton = document.querySelector('#theme-toggle');
let saved = readStored(strategyKey, []);
let draft = { ...structuredClone(presets.fly), preset: 'fly', id: null };
const visiblePercentiles = new Map();
let openPercentile;
const percentileDialog = document.querySelector('#percentile-dialog');
const popupLookback = document.querySelector('#percentile-lookback');
const strategyDates = { cadence: 'quarterly', earlier: false, scale: 'focused' };
let scenarios = readStored(scenarioKey, { A: newScenario(), B: newScenario() });
const sim = { active: 'A', market: 'SR3', outputMarket: 'all', output: 'spread/3', compare: 'none', scale: 'focused' };
let source = 'snapshot';
let preferLive = true;
let feed = { state: 'offline', quotes: {} };
let flaggedOutrights = 0;
let screen;
let book;
let catalogueText;
let historyCheckRunning = false;

function applyTheme(value) {
  const dark = value === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  themeButton.setAttribute('aria-pressed', String(dark));
  themeButton.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  redrawCharts();
  if (book && screen === 'vwap') marketCards(marketReader(book, source, feed.quotes), filters.vwap);
}

applyTheme(readStored(themeKey, 'light'));
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
}

function paintChart(id, data) {
  const canvas = document.querySelector(`#${id}`);
  const scale = { 'market-chart': filters.curves.scale, 'strategy-chart': strategyDates.scale, 'sim-chart': sim.scale }[id];
  const clipped = showChart(canvas, {
    ...data, empty: emptyPoints(data), focused: scale === 'focused',
  });
  const legend = canvas.nextElementSibling;
  const markup = data.series.map(line => {
    const sample = `<i class="legend-line ${line.id} ${line.dashed ? 'dashed' : ''}"></i>${escape(line.label)}`;
    return id === 'market-chart'
      ? `<button type="button" data-isolate-market="${line.id}" aria-pressed="${data.series.length === 1}"
        title="${data.series.length === 1 ? 'Show all markets' : `Focus ${escape(line.label)}`}">${sample}</button>`
      : `<span>${sample}</span>`;
  }).join('') + (clipped ? `<span class="clipped-note">${clipped} outside scale · see table or Full range</span>` : '')
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
  main.innerHTML = `${header()}
    <section class="panel">
      <div class="panel-head wrap">
        <h2>Spreads &amp; flies</h2>
        <div class="price-timestamps">
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
        </div>
      </div>
      <p id="history-refresh-warning" class="notice warning" role="status" hidden></p>
      <p id="feed-notice" class="notice" hidden></p>
      <div id="price-packages"></div>
      <div id="settlement-key" class="price-key"><span><i class="heat-up heat-mid"></i>Above settlement</span>
        <span><i class="heat-down heat-mid"></i>Below settlement</span>
        <span><i class="heat-flag-key"></i>Off-scale listed quote</span>
        <span>Reference: supplied export settlement</span></div>
      <div id="percentile-key" class="price-key" hidden><span>Price (bp) above percentile · Select a percentile for its daily closes</span>
        <span><i class="heat-up heat-mid"></i>Higher rank</span>
        <span><i class="heat-down heat-mid"></i>Lower rank</span>
        <span id="price-history-status"></span></div>
    </section>
    <section class="panel lower-section">
      <div class="panel-head"><h2>Saved strategies</h2><div class="control-group">
        <span id="strategy-price-basis" class="tag" hidden>Price (bp) + percentile</span>
        <a href="#strategies" class="button small">Manage strategies</a></div></div>
      <div id="price-strategies"></div>
    </section>`;
  updatePriceBoard();
}

function heatCell(point, mode, inspection) {
  const title = inspection.label;
  const flag = point?.note ? ' heat-flag' : '';
  const tooltipTitle = point?.note ? `${title}\n${point.note}` : title;
  if (!Number.isFinite(point?.value)) return `<td class="heat-value value-empty${flag}"
    title="${escape(tooltipTitle)}" aria-label="${escape(`${tooltipTitle}. Live value unavailable.`)}">—</td>`;
  if (mode === 'percentile') {
    const rank = point.percentile;
    const deviation = rank.value === null ? 0 : rank.value - 50;
    const magnitude = Math.abs(deviation);
    const direction = magnitude < 5 ? '' : deviation > 0 ? 'heat-up' : 'heat-down';
    const strength = magnitude >= 30 ? 'heat-high' : magnitude >= 15 ? 'heat-mid' : 'heat-low';
    const level = `${point.source} ${formatValue(point.value, 'bp')} bp`;
    const tooltip = `${tooltipTitle}\n${level}\n${rankDetails(rank)}`;
    return `<td class="heat-value heat-paired as-num ${direction} ${direction ? strength : ''}${flag}"
      title="${escape(tooltip)}" aria-label="${escape(tooltip)}">
      <span class="heat-price">${formatValue(point.value, 'bp')}</span>
      ${percentileButton(point, inspection, `heat-rank${rank.value === null ? ' value-empty' : ''}`)}
    </td>`;
  }
  const change = Number.isFinite(point.reference) ? point.value - point.reference : null;
  const magnitude = Math.abs(change ?? 0);
  const direction = magnitude < .005 ? '' : change > 0 ? 'heat-up' : 'heat-down';
  const strength = magnitude >= 2 ? 'heat-high' : magnitude >= .5 ? 'heat-mid' : 'heat-low';
  const text = mode === 'level' ? formatValue(point.value, 'bp') : formatValue(change, 'bp', true);
  const details = Number.isFinite(change)
    ? `Export settlement ${formatValue(point.reference, 'bp')} bp · Change ${formatValue(change, 'bp', true)} bp`
    : 'Export settlement unavailable';
  const tooltip = `${tooltipTitle}\n${point.source} ${formatValue(point.value, 'bp')} bp\n${details}`;
  return `<td class="heat-value as-num ${direction ? `${direction} ${strength}` : ''} ${text === '—' ? 'value-empty' : ''}${flag}"
    title="${escape(tooltip)}" aria-label="${escape(tooltip)}">${text}</td>`;
}

function rankedPoint(point, history, rankFor) {
  return { ...point, percentile: rankFor(history), rankFor };
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

function priceMatrix(starts, groups, title, groupName, empty, mode) {
  if (!starts.length || !groups.length) return `<p class="empty">${empty}</p>`;
  const headers = starts.map(start => `<th scope="col" class="heat-value">${monthLabel(start)}</th>`).join('');
  const bodies = groups.map(group => `<tbody>${group.rows.map((row, index) => `<tr>
    ${index === 0 ? `<th class="heat-group" scope="rowgroup" rowspan="${group.rows.length}" title="${escape(group.detail ?? group.label)}">${escape(group.label)}</th>` : ''}
    <th class="heat-market" scope="row">${marketLabel(row.id)}</th>
    ${starts.map(start => {
      const label = row.label(start);
      return heatCell(row.read(start), mode, {
        key: [...group.key, row.id, start], label, kind: group.kind,
        context: group.detail && group.detail !== group.label ? `${label} · ${group.detail}` : label,
      });
    }).join('')}
  </tr>`).join('')}</tbody>`).join('');
  return `<div class="table-scroll heat-scroll"><table class="heat-table" aria-label="${title}">
    <thead><tr><th class="heat-group" scope="col">${groupName}</th><th class="heat-market" scope="col">Market</th>${headers}</tr></thead>
    ${bodies}</table></div>`;
}

function updatePriceBoard() {
  visiblePercentiles.clear();
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
  document.querySelector('#strategy-price-basis').hidden = !percentileMode;
  const families = priceFilters.family === 'all' ? ['spread', 'fly'] : [priceFilters.family];
  const packages = families.flatMap(family => tenors.map(tenor => ({
    key: [family, tenor], kind: family, label: typeLabel(family, tenor),
    rows: selectedMarkets.map(({ id }) => ({
      id,
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
    const rows = strategySeries(strategy).filter(({ id }) =>
      marketIds.includes(id) || (id === 'intermarket' && strategy.legs.some(leg => marketIds.includes(leg.market))),
    ).map(({ id }) => ({
      id, label: start => `${strategy.name} · ${marketName[id] ?? 'Intermarket'} · ${monthLabel(start)}`,
      read(start) {
        const point = readStrategy(strategy, id, start, reader);
        if (!point) return null;
        if (percentileMode) {
          return rankedPoint(point, history, sample => sample.strategyRank(strategy, id, start, point, reader, true));
        }
        const reference = readStrategy(strategy, id, start, (...args) => {
          const value = reader(...args)?.reference;
          return Number.isFinite(value) ? { value, source: 'Export settle' } : null;
        });
        return { ...point, reference: reference?.value };
      },
    }));
    if (!rows.length) return [];
    for (const start of strategyStarts(book, strategy, dates)) deliveries.add(start);
    return [{ key: ['saved', strategy.id], kind: 'strategy', label: strategy.name, detail: formulaFor(strategy), rows }];
  });
  const starts = [...deliveries].sort((a, b) => a - b);
  if (priceFilters.horizon !== 'all') starts.length = Math.min(starts.length, Number(priceFilters.horizon));
  paintScrollableTable('price-packages', priceMatrix(starts, packages, 'Live spread and fly prices', 'Package',
    'No upcoming quarterly deliveries.', priceFilters.mode));
  paintScrollableTable('price-strategies', priceMatrix(starts, strategies, 'Live saved strategy prices', 'Strategy',
    saved.length ? 'No saved strategies match this market.' : 'Strategies appear here when you save them.',
    priceFilters.mode));
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
}

function formulaFor(strategy) {
  return strategy.legs.map((leg, index) => {
    const weight = Number(leg.weight);
    const sign = weight < 0 ? '− ' : index ? '+ ' : '';
    const terms = [leg.market !== 'same' ? marketName[leg.market] : '', typeLabel(leg.family, leg.tenor)].filter(Boolean).join(' ');
    const shift = Number(leg.offset);
    return `${sign}${Math.abs(weight) === 1 ? '' : `${Math.abs(weight)} × `}${terms}${shift ? ` [${shift > 0 ? '+' : ''}${shift}Q]` : ''}`;
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

function strategyShell() {
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
          <label>Product ${select(`Leg ${index + 1} product`, typeOptions, `${leg.family}/${leg.tenor}`, 'data-leg-field="product"')}</label>
          <label>Weight <input type="number" step="any" value="${escape(leg.weight)}" required data-leg-field="weight"></label>
          <label>Start offset (Q) <input type="number" step="1" min="-40" max="40" value="${escape(leg.offset)}" required data-leg-field="offset"></label>
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
  <section class="panel lower-section">
    <div class="panel-head"><div><h2>Strategy preview</h2><p>Values are in basis points. Outright price points are multiplied by 100.</p></div></div>
    <div class="toolbar">
      ${dateControls(strategyDates)}
      <label class="input-label">Lookback ${select('Strategy percentile lookback',
        lookbackOptions, priceFilters.lookback, 'id="strategy-lookback"')}</label>
    </div>
    <p class="notice" id="feed-notice" hidden></p>
    <div id="strategy-table"></div>
    <p class="scenario-help" id="strategy-history-note"></p>
  </section>
  <section class="panel lower-section">
    <div class="panel-head"><h2>Strategy curve</h2>${badge('bp')}</div>
    <div class="toolbar">${scaleSelector(strategyDates.scale, 'data-filter="scale"')}</div>
    ${chartShell('strategy-chart')}
  </section>`;
  updateStrategy();
}

const validLegs = strategy => strategy.legs.every(leg =>
  leg.weight !== '' && Number.isFinite(Number(leg.weight)) && Number(leg.weight) !== 0
  && leg.offset !== '' && Number.isInteger(Number(leg.offset)) && Math.abs(leg.offset) <= 40,
);

function updateStrategy() {
  visiblePercentiles.clear();
  const valid = validLegs(draft);
  const formula = valid ? formulaFor(draft) : 'Enter a nonzero weight and a whole-quarter offset for each leg.';
  document.querySelector('#formula').textContent = formula;
  const starts = valid ? strategyStarts(book, draft, strategyDates) : [];
  const history = source === 'live' ? selectedHistory() : null;
  const reader = source === 'live' ? liveBoardReader(book, feed.quotes) : marketReader(book, source, feed.quotes);
  const strategy = draft;
  const data = curveData(starts, strategySeries(strategy), (id, start) => {
    const point = readStrategy(strategy, id, start, reader);
    return history && point ? rankedPoint(point, history, sample => sample.strategyRank(strategy, id, start, point, reader, true)) : point;
  }, 'bp', 'Strategy value by start delivery', monthLabel);
  paintChart('strategy-chart', data);
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
    status.textContent = 'Use a unique name, nonzero weights, and whole-quarter offsets.';
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

function comparisonTable(data, comparison, compareLabel) {
  if (!comparison || !data.starts.length) return valueTable(data, { tall: true, rowType: 'Contract legs / start' });
  const heads = data.series.map(line => `<th colspan="3" scope="colgroup" class="number-cell">${escape(line.label)}</th>`).join('');
  const metrics = data.series.map(() => `<th scope="col" class="number-cell">Scenario ${sim.active}</th>
    <th scope="col" class="number-cell">${escape(compareLabel)}</th><th scope="col" class="number-cell">Δ</th>`).join('');
  const rows = data.starts.map((month, index) => `<tr><th scope="row">${escape(data.describe(month))}</th>
    ${data.series.map((line, lineIndex) => {
      const a = line.points[index], b = comparison.series[lineIndex].points[index];
      const diff = a && b ? a.value - b.value : null;
      const tone = diff > 0 ? 'delta-positive' : diff < 0 ? 'delta-negative' : 'value-empty';
      return `${pointCell(a, data.unit)}${pointCell(b, data.unit)}<td class="number-cell as-num ${tone}">${formatValue(diff, data.unit, true)}</td>`;
    }).join('')}</tr>`).join('');
  return `<div class="table-scroll"><table aria-label="Scenario comparison">
    <thead><tr><th rowspan="2" scope="col">Contract legs / start</th>${heads}</tr><tr>${metrics}</tr></thead><tbody>${rows}</tbody>
    </table></div><div class="table-foot"><span>Δ = Scenario ${sim.active} minus ${escape(compareLabel)}</span><span>${data.unit === 'bp' ? 'Basis points' : 'Price points'}</span></div>`;
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
  const route = location.hash.slice(1);
  screen = Object.hasOwn(titles, route) ? route : 'vwap';
  document.querySelector('#breadcrumb').textContent = titles[screen];
  document.querySelectorAll('nav a').forEach(link => {
    if (link.hash === `#${screen}`) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if (!book) return;
  if (screen === 'prices') priceBoardShell();
  else if (screen === 'strategies') strategyShell();
  else if (screen === 'simulator') simulatorShell();
  else marketShell();
  main.removeAttribute('aria-busy');
}

function updateScreen() {
  if (!book) return;
  if (screen === 'prices') updatePriceBoard();
  else if (screen === 'strategies') updateStrategy();
  else if (screen === 'simulator') updateSimulator();
  else updateMarket();
}

main.addEventListener('click', event => {
  const target = event.target.closest('button');
  if (!target) return;
  if (target.dataset.rankKey) {
    inspectPercentile(target.dataset.rankKey);
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

main.addEventListener('change', event => {
  const field = event.target;
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
    const leg = draft.legs[Number(field.closest('[data-leg]').dataset.leg)];
    if (field.dataset.legField === 'market') leg.market = field.value;
    else {
      const [family, tenor] = field.value.split('/');
      Object.assign(leg, { family, tenor: Number(tenor) });
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
  const active = !['offline', 'error', 'unreachable'].includes(state);
  const status = document.querySelector('#feed-status');
  const count = Object.keys(feed.quotes).length - flaggedOutrights;
  status.className = `feed-status ${connected && count ? 'is-live' : active ? 'is-pending' : state === 'error' ? 'is-error' : ''}`;
  const statusLabel = connected ? (count ? `Live · ${count} VWAPs` : 'Awaiting VWAP')
    : { 'signing-in': 'Sign-in pending', connecting: 'Connecting', error: 'Feed error', unreachable: 'Server unavailable' }[state] ?? 'Snapshot mode';
  status.innerHTML = `<span></span>${escape(statusLabel)}`;
  status.title = feed.received ? `Last new VWAP ${new Date(feed.received * 1000).toLocaleTimeString('en-GB', { timeZone: 'Europe/London' })} London time` : snapshotMode();
  document.querySelector('#feed-open').textContent = active || state === 'error' ? 'Feed details' : 'Connect live';
  signIn.hidden = active;
  const signature = [state, feed.message, feed.device?.code, signInError].join('|');
  if (signature === detailState) return;
  detailState = signature;
  const detail = document.querySelector('#connection-detail');
  const device = feed.device;
  const message = signInError || (connected ? 'Connected to the Lightstreamer L1 adapter.' : feed.message);
  detail.innerHTML = `${message ? `<p>${escape(message)}</p>` : ''}
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
  if ((source === 'live' || screen === 'prices') && (switched || old.received !== feed.received || old.state !== feed.state ||
    old.failedBatches !== feed.failedBatches || Object.keys(old.quotes).length !== Object.keys(feed.quotes).length)) updateScreen();
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
  return true;
}

async function checkPublishedHistory() {
  const viewing = () => screen === 'prices' || (screen === 'strategies' && source === 'live');
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
    applyTheme(readStored(themeKey, 'light'));
    return;
  }
  if (event.key !== strategyKey) return;
  saved = readStored(strategyKey, []);
  if (!book) return;
  if (screen === 'prices') updatePriceBoard();
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
