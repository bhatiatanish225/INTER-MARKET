import { canvasContext, clamp, formatValue, tickStep } from './chart.mjs';
import { contractLabel, currentMonth, isQuarter, liveBoardReader, typeLabel } from './curve-engine.mjs';

const firstDay = '2021-01-01';
const hour = 3_600_000;
const day = 24 * hour;
const dateInput = value => new Date(value).toISOString().slice(0, 10);
const dateLabel = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'medium' });
const barLabel = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' });
const axisDay = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: '2-digit' });
const axisHour = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', hour: '2-digit', hourCycle: 'h23' });
const number = new Intl.NumberFormat('en-GB');
const products = ['spread', 'fly'].flatMap(family => [3, 6, 12].map(tenor => [family, tenor]));
const ranges = [[7, '1W'], [30, '1M'], [90, '3M'], [365, '1Y'], [0, 'All loaded']];
const selection = { market: 'SR3', product: 'spread/3', contract: 'rolling', generic: '1', from: firstDay };

function nextQuarter(now = new Date()) {
  let front = now.getUTCFullYear() * 12 + now.getUTCMonth();
  do { front++; } while (!isQuarter(front));
  return front;
}

function lowerBound(candles, stamp) {
  let first = 0, end = candles.length;
  while (first < end) {
    const middle = Math.floor((first + end) / 2);
    if (candles[middle][0] < stamp) first = middle + 1;
    else end = middle;
  }
  return first;
}

export function mountHourly(main, book, marketNames, getFeed) {
  const today = dateInput(Date.now());
  main.innerHTML = `<div class="page-header"><div class="page-title">
    <h1>Hourly History</h1><p>Explore traded one-hour spreads and flies across SR3, Euribor and SONIA.</p>
    </div><span class="tag">QuantHub · 1 hour</span></div>
    <section class="panel" aria-label="Historical candlesticks">
      <form class="toolbar hourly-toolbar">
        <label class="input-label">Market <select name="market"></select></label>
        <label class="input-label">Product <select name="product"></select></label>
        <label class="input-label">Contract <select name="contract"></select></label>
        <label class="input-label"><span class="hourly-generic-label">Generic spread</span> <select name="generic"></select></label>
        <label class="input-label">From <input name="from" type="date" min="${firstDay}" max="${today}" required></label>
        <label class="input-label">Through <input name="through" type="date" min="${firstDay}" max="${today}" required></label>
        <button class="button small" type="submit">Load chart</button>
      </form>
      <div class="panel-head wrap">
        <div><h2 class="hourly-title"></h2><p class="hourly-coverage"></p></div>
        <div class="hourly-current as-num" role="group" aria-label="Current spread value" hidden>
          <span class="hourly-current-label">Current spread</span>
          <strong class="hourly-current-price">—</strong>
          <span class="hourly-current-source"></span>
          <span class="hourly-current-contract"></span>
        </div>
        <div class="segmented hourly-ranges" role="group" aria-label="Chart window">
          ${ranges.map(([days, label]) => `<button type="button" data-history-days="${days}" aria-pressed="false" disabled>${label}</button>`).join('')}
        </div>
      </div>
      <p class="notice hourly-status" role="status" hidden></p>
      <div class="hourly-readout as-num" aria-label="Selected candle"></div>
      <div class="chart-shell hourly-chart" hidden>
        <canvas tabindex="0" role="img" aria-label="Hourly OHLC candlesticks in basis points"></canvas>
      </div>
      <div class="table-foot hourly-foot"><span class="hourly-method"></span>
        <span>UTC · Scroll to zoom · Drag to pan</span></div>
    </section>`;

  const panel = main.querySelector('section');
  const form = panel.querySelector('form');
  const fields = form.elements;
  const canvas = panel.querySelector('canvas');
  const chart = canvas.parentElement;
  const title = panel.querySelector('.hourly-title');
  const coverage = panel.querySelector('.hourly-coverage');
  const status = panel.querySelector('.hourly-status');
  const method = panel.querySelector('.hourly-method');
  const genericLabel = panel.querySelector('.hourly-generic-label');
  const readout = panel.querySelector('.hourly-readout');
  const currentValue = panel.querySelector('.hourly-current');
  const currentPrice = panel.querySelector('.hourly-current-price');
  const currentSource = panel.querySelector('.hourly-current-source');
  const currentContract = panel.querySelector('.hourly-current-contract');
  const buttons = [...panel.querySelectorAll('[data-history-days]')];
  const observer = new ResizeObserver(draw);
  observer.observe(chart);
  let request, candles = [], bounds, view, plot, hover, drag;
  let spreadQuote;

  function fill(field, options, value) {
    field.replaceChildren(...options.map(([key, label]) => new Option(label, key)));
    field.value = value;
    if (field.selectedIndex < 0) field.selectedIndex = 0;
  }

  function refreshContracts() {
    const [family, size] = fields.product.value.split('/');
    const tenor = Number(size);
    const starts = new Set();
    for (let delivery = 2021 * 12; delivery <= currentMonth() + 3; delivery++) {
      if (isQuarter(delivery)) starts.add(delivery);
    }
    for (const item of book.listed.values()) {
      if (item.market === fields.market.value && item.family === family && item.tenor === tenor) starts.add(item.start);
    }
    fill(fields.contract, [['rolling', 'Rolling quarterly'], ...[...starts].sort((a, b) => b - a)
      .map(delivery => [String(delivery), contractLabel(family, delivery, tenor)])], selection.contract);
  }

  function refreshGenerics() {
    const [family, size] = fields.product.value.split('/');
    const spread = family === 'spread';
    const prefix = spread ? 'S' : 'G';
    genericLabel.textContent = spread ? 'Generic spread' : 'Generic fly';
    const front = nextQuarter();
    const ranks = spread ? [...book.listed.values()]
      .filter(item => item.market === fields.market.value && item.family === family && item.tenor === Number(size)
        && item.start >= front && isQuarter(item.start))
      .map(item => 1 + (item.start - front) / 3).sort((a, b) => a - b) : [1, 2, 3];
    fill(fields.generic, ranks.map(rank => [String(rank), `${prefix}${rank}`]), selection.generic);
  }

  function notify(message, warning = false) {
    status.textContent = message;
    status.hidden = !message;
    status.classList.toggle('warning', warning);
  }

  function updateCurrent() {
    if (!spreadQuote) return;
    const { market, tenor, delivery, bar, pending, failed } = spreadQuote;
    const feed = getFeed();
    const live = feed.state === 'connected' && liveBoardReader(book, feed.quotes)(market, 'spread', delivery, tenor);
    const listedVwap = live?.source === 'L1 VWAP' && Number.isFinite(live.value);
    const value = listedVwap ? live.value : bar?.[4];
    const price = Number.isFinite(value) ? `${formatValue(value, 'bp')} bp` : '—';
    const source = listedVwap ? 'Live L1 VWAP' : bar ? `Latest hourly close · ${barLabel.format(bar[0])} UTC`
      : pending ? 'Loading latest close…' : failed ? 'Latest close unavailable' : 'No recent hourly trades';
    if (currentPrice.textContent !== price) currentPrice.textContent = price;
    if (currentSource.textContent !== source) currentSource.textContent = source;
  }

  async function loadCurrent(quote, params, signal) {
    try {
      const response = await fetch(`/api/hourly?${params}`, { signal });
      if (!response.ok) throw new Error();
      const data = await response.json();
      quote.bar = data.candles.at(-1);
      quote.failed = data.warnings.length > 0 && !quote.bar;
    } catch {
      quote.failed = true;
    } finally {
      quote.pending = false;
      if (!signal.aborted && spreadQuote === quote) updateCurrent();
    }
  }

  function displayCandle(bar) {
    if (!bar) {
      readout.replaceChildren();
      return;
    }
    const [stamp, opening, high, low, close, volume, code] = bar;
    const values = [['O', opening], ['H', high], ['L', low], ['C', close]];
    const details = values.map(([label, price]) => `${label} ${formatValue(price, 'bp')}`);
    const heading = document.createElement('strong');
    heading.textContent = `${barLabel.format(stamp)} UTC · ${code}`;
    const prices = document.createElement('span');
    prices.textContent = `${details.join('   ')} bp · Vol ${number.format(volume)}`;
    readout.replaceChildren(heading, prices);
  }

  function draw() {
    if (!view || chart.hidden) return;
    const area = canvasContext(canvas);
    if (!area) return;
    const { context: ctx, width, height } = area;
    const palette = getComputedStyle(canvas);
    const color = name => palette.getPropertyValue(`--${name}`).trim();
    const [start, end] = view;
    const left = 58, right = width - 14, top = 17, bottom = height - 34;
    if (right <= left) return;
    plot = { left, right };
    const x = stamp => left + (stamp - start) / (end - start) * (right - left);
    const first = lowerBound(candles, start);
    const stop = lowerBound(candles, end + 1);
    let low = Infinity, high = -Infinity;
    for (let index = first; index < stop; index++) {
      low = Math.min(low, candles[index][3]);
      high = Math.max(high, candles[index][2]);
    }
    ctx.font = '12px "Segoe UI", sans-serif';
    ctx.fillStyle = color('muted');
    if (first === stop) {
      ctx.textAlign = 'center';
      ctx.fillText('No traded candles in this chart window.', width / 2, height / 2);
      displayCandle(null);
      return;
    }
    const padding = Math.max((high - low) * 0.07, 0.05);
    low -= padding;
    high += padding;
    const y = price => bottom - (price - low) / (high - low) * (bottom - top);
    const step = tickStep(high - low);
    const digits = clamp(Math.ceil(-Math.log10(step)) + Number(step < 1), 0, 4);
    ctx.textAlign = 'right';
    for (let tick = Math.ceil(low / step); tick <= Math.floor(high / step); tick++) {
      const pos = y(tick * step);
      ctx.strokeStyle = color(tick === 0 ? 'plot-origin' : 'plot-grid');
      ctx.beginPath();
      ctx.moveTo(left, pos);
      ctx.lineTo(right, pos);
      ctx.stroke();
      ctx.fillText((tick * step).toFixed(digits), left - 8, pos + 4);
    }
    ctx.textAlign = 'center';
    const axis = end - start < 3 * day ? axisHour : axisDay;
    const tickCount = Math.max(1, Math.floor((right - left) / 92));
    for (let i = 0; i < tickCount; i++) {
      const ratio = (i + 0.5) / tickCount;
      ctx.fillText(axis.format(start + ratio * (end - start)), left + ratio * (right - left), height - 12);
    }
    const up = color('positive'), down = color('negative');
    const bodyWidth = clamp((right - left) * hour / (end - start) * 0.72, 1, 11);
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, right - left, bottom - top);
    ctx.clip();
    for (let index = first; index < stop; index++) {
      const [stamp, opening, maximum, minimum, close] = candles[index];
      const pos = x(stamp);
      ctx.fillStyle = ctx.strokeStyle = close >= opening ? up : down;
      ctx.beginPath();
      ctx.moveTo(pos, y(maximum));
      ctx.lineTo(pos, y(minimum));
      ctx.stroke();
      ctx.fillRect(pos - bodyWidth / 2, y(Math.max(opening, close)), bodyWidth, Math.max(1, Math.abs(y(close) - y(opening))));
    }
    let active = candles[stop - 1];
    if (hover !== undefined && hover >= left && hover <= right) {
      const target = start + (hover - left) / (right - left) * (end - start);
      const index = clamp(lowerBound(candles, target), first, stop - 1);
      const nearest = index > first && target - candles[index - 1][0] < candles[index][0] - target ? index - 1 : index;
      active = candles[nearest];
      const pos = x(active[0]);
      if (Math.abs(pos - hover) < 22) {
        ctx.strokeStyle = color('plot-crosshair');
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(pos, top);
        ctx.lineTo(pos, bottom);
        ctx.stroke();
      } else active = null;
    }
    ctx.restore();
    displayCandle(active);
  }

  function setView(start, span, preset) {
    if (!bounds) return;
    const fullSpan = bounds[1] - bounds[0];
    span = clamp(span, Math.min(12 * hour, fullSpan), fullSpan);
    const first = clamp(start, bounds[0], bounds[1] - span);
    view = [first, first + span];
    hover = undefined;
    buttons.forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.historyDays) === preset)));
    draw();
  }

  function showRange(days) {
    if (!bounds) return;
    const start = days ? bounds[1] - days * day : bounds[0];
    setView(start, bounds[1] - start, days);
  }

  async function load() {
    fields.generic.disabled = fields.contract.value !== 'rolling';
    if (!form.reportValidity()) return;
    request?.abort();
    const current = request = new AbortController();
    const inputs = new FormData(form);
    const [family, tenor] = inputs.get('product').split('/');
    Object.assign(selection, Object.fromEntries(inputs));
    const rolling = selection.contract === 'rolling';
    const label = `${marketNames[selection.market]} · ${typeLabel(family, Number(tenor))}`;
    title.textContent = rolling ? `${label} · ${fields.generic.selectedOptions[0].textContent}` : label;
    method.textContent = rolling
      ? 'The generic number is the quarterly start position. Positions roll on Mar 1, Jun 1, Sep 1 and Dec 1 UTC.'
      : fields.contract.selectedOptions[0].textContent + ' · Listed only';
    coverage.textContent = '';
    view = bounds = plot = null;
    chart.hidden = true;
    displayCandle(null);
    buttons.forEach(button => { button.disabled = true; });
    notify('Loading hourly candles from QuantHub and the local cache…');
    const params = new URLSearchParams({ market: selection.market, family, tenor, contract: selection.contract, generic: selection.generic,
      from: selection.from, through: selection.through });
    currentValue.hidden = family !== 'spread';
    spreadQuote = undefined;
    if (family === 'spread') {
      const now = new Date();
      const front = nextQuarter(now);
      const delivery = rolling ? front + (Number(selection.generic) - 1) * 3 : Number(selection.contract);
      spreadQuote = { market: selection.market, tenor: Number(tenor), delivery, pending: true };
      currentContract.textContent = contractLabel(family, delivery, Number(tenor));
      updateCurrent();
      const recent = new URLSearchParams(params);
      recent.set('from', dateInput(Date.UTC(Math.floor(front / 12), front % 12 - 3, 1)));
      recent.set('through', dateInput(now));
      loadCurrent(spreadQuote, recent, current.signal);
    }
    try {
      const response = await fetch(`/api/hourly?${params}`, { signal: current.signal });
      const data = await response.json();
      if (current.signal.aborted) return;
      if (!response.ok) throw new Error(data.error || data.warnings?.join(' ') || 'Hourly history could not be loaded.');
      candles = data.candles;
      const gaps = data.missingWindows.length;
      const warnings = [...data.warnings];
      if (!candles.length) warnings.push('QuantHub returned no traded hourly candles for this selection.');
      else if (gaps && selection.contract === 'rolling') {
        warnings.push(`${gaps} ${gaps === 1 ? 'period has' : 'periods have'} no candles in this range.`);
      }
      notify(warnings.join(' '), warnings.length > 0);
      if (!candles.length) return;
      bounds = [candles[0][0] - hour / 2, candles.at(-1)[0] + hour / 2];
      coverage.textContent = `${number.format(candles.length)} candles · ${dateLabel.format(candles[0][0])} to ${dateLabel.format(candles.at(-1)[0])} · Basis points`;
      chart.hidden = false;
      buttons.forEach(button => { button.disabled = false; });
      showRange(rolling ? 0 : 30);
    } catch (error) {
      if (!current.signal.aborted) notify(error.message || 'Hourly history could not be loaded. Try again.', true);
    }
  }

  fill(fields.market, Object.entries(marketNames), selection.market);
  fill(fields.product, products.map(([family, tenor]) => [`${family}/${tenor}`, typeLabel(family, tenor)]), selection.product);
  fields.from.value = selection.from;
  fields.through.value = selection.through || today;
  refreshContracts();
  refreshGenerics();
  form.addEventListener('submit', event => { event.preventDefault(); load(); });
  form.addEventListener('change', event => {
    if (event.target === fields.market || event.target === fields.product) {
      refreshContracts();
      refreshGenerics();
    }
    if (event.target === fields.generic) {
      fields.from.value = firstDay;
      fields.through.value = today;
    }
    if (event.target.tagName === 'SELECT') load();
  });
  buttons.forEach(button => button.addEventListener('click', () => showRange(Number(button.dataset.historyDays))));
  canvas.addEventListener('pointerdown', event => {
    if (!view || !plot || event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, start: view[0] };
  });
  canvas.addEventListener('pointermove', event => {
    if (!view || !plot) return;
    if (drag) {
      const span = view[1] - view[0];
      setView(drag.start - (event.clientX - drag.x) / (plot.right - plot.left) * span, span);
    } else {
      hover = event.offsetX;
      draw();
    }
  });
  canvas.addEventListener('lostpointercapture', () => { drag = undefined; });
  canvas.addEventListener('pointerleave', () => { hover = undefined; draw(); });
  canvas.addEventListener('dblclick', () => showRange(0));
  canvas.addEventListener('wheel', event => {
    if (!view || !plot || !event.deltaY) return;
    event.preventDefault();
    const span = view[1] - view[0];
    const next = span * (event.deltaY > 0 ? 1.25 : 0.80);
    const anchor = clamp((event.offsetX - plot.left) / (plot.right - plot.left), 0, 1);
    setView(view[0] + (span - next) * anchor, next);
  }, { passive: false });
  canvas.addEventListener('keydown', event => {
    if (!view || !['+', '=', '-', '0', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const span = view[1] - view[0];
    if (event.key === '0') showRange(0);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      setView(view[0] + (event.key === 'ArrowLeft' ? -0.25 : 0.25) * span, span);
    } else {
      const next = span * (event.key === '-' ? 1.25 : 0.80);
      setView(view[0] + (span - next) / 2, next);
    }
  });
  load();
  return { draw, updateCurrent, dispose() { request?.abort(); observer.disconnect(); } };
}
