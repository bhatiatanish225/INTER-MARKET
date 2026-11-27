import { canvasContext, clamp, formatValue, showChart, tickStep } from './chart.mjs';
import { minimumPercentileDays, packageDeliveries, packageValue, readStrategy, strategyLegArgs, strategyRangeWindows, strategySeries } from './curve-engine.mjs';

const hour = 3_600_000;
const firstDay = '2021-01-01';
const dateLabel = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' });
const axisLabel = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: '2-digit' });
const describe = value => `${dateLabel.format(value * hour)} UTC`;
const argsKey = args => args.join('/');

export function mountStrategyHistory(panel, marketNames) {
  const today = new Date().toISOString().slice(0, 10);
  panel.innerHTML = `<div class="panel-head"><div><h2>Hourly strategy history</h2>
    <p>Weighted closes in basis points for hours when every leg traded.</p></div></div>
    <form class="toolbar" id="strategy-history-form">
      <label class="input-label" hidden>Market <select name="market"></select></label>
      <label class="input-label">From <input type="date" name="from" min="${firstDay}" max="${today}" value="${firstDay}" required></label>
      <label class="input-label">Through <input type="date" name="through" min="${firstDay}" max="${today}" value="${today}" required></label>
      <button type="submit" class="button primary small">Load hourly chart</button>
    </form>
    <p class="notice strategy-hourly-status" role="status"></p>
    <div class="chart-shell" hidden></div>`;

  const form = panel.querySelector('form');
  const market = form.elements.market;
  const submit = form.querySelector('button');
  const status = panel.querySelector('[role="status"]');
  const chart = panel.querySelector('.chart-shell');
  let strategy, signature, activeRequest;

  function report(message, warning = false) {
    status.textContent = message;
    status.classList.toggle('warning', warning);
  }

  function clearChart() {
    activeRequest?.abort();
    activeRequest = undefined;
    chart.hidden = true;
    chart.replaceChildren();
    submit.disabled = false;
  }

  function update(draft, valid) {
    const anyFixed = draft.legs.some(leg => leg.delivery != null);
    const allFixed = valid && draft.legs.every(leg => leg.delivery != null);
    panel.hidden = !anyFixed;
    const nextSignature = JSON.stringify([valid, draft.legs]);
    if (signature === nextSignature) return;
    signature = nextSignature;
    clearChart();
    const before = market.value;
    const scope = strategySeries(draft);
    market.replaceChildren(...scope.map(({ id, name }) => new Option(marketNames[id] ?? name, id)));
    if (scope.some(({ id }) => id === before)) market.value = before;
    market.parentElement.hidden = scope.length < 2;
    strategy = allFixed ? structuredClone(draft) : undefined;
    form.hidden = !strategy;
    report(!allFixed ? 'Choose a delivery month and a nonzero weight for every leg to plot hourly history.'
      : 'Choose the date range and load the chart.');
  }

  async function load(event) {
    event.preventDefault();
    if (!strategy) return;
    const from = form.elements.from.value;
    const through = form.elements.through.value;
    if (from > through) {
      report('The From date must be on or before the Through date.', true);
      return;
    }
    clearChart();
    const request = activeRequest = new AbortController();
    submit.disabled = true;
    const snapshot = strategy;
    const scope = strategySeries(snapshot).find(line => line.id === market.value);
    const implied = new Map();
    const legs = new Map(snapshot.legs.flatMap(leg => {
      const args = strategyLegArgs(leg, scope.id);
      if (leg.tenor !== 9) return [[argsKey(args), args]];
      const [id, family, delivery, tenor] = args;
      const inputs = packageDeliveries(family, delivery, tenor).map(month => [id, 'out', month, 0]);
      implied.set(argsKey(args), inputs.map(argsKey));
      return inputs.map(input => [argsKey(input), input]);
    }));
    report('Loading traded hourly closes for the selected legs…');
    try {
      const histories = new Map(await Promise.all([...legs].map(async ([key, [id, family, delivery, tenor]]) => {
        const params = new URLSearchParams({ market: id, family, tenor, contract: delivery, from, through });
        const response = await fetch(`/api/hourly?${params}`, { signal: request.signal });
        const data = await response.json();
        const warnings = data.warnings ?? [];
        if (!response.ok) throw new Error(data.error || warnings.join(' ') || 'Hourly history could not be loaded.');
        return [key, { closes: new Map(data.candles.map(bar => [bar[0], bar[4]])), warnings }];
      })));
      if (request.signal.aborted) return;
      const warnings = new Set([...histories.values()].flatMap(history => history.warnings));
      const [shortest] = [...histories.values()].sort((a, b) => a.closes.size - b.closes.size);
      const starts = [], points = [];
      for (const stamp of shortest.closes.keys()) {
        const point = readStrategy(snapshot, scope.id, undefined, (...args) => {
          const key = argsKey(args);
          const inputs = implied.get(key);
          return { value: inputs ? packageValue(args[1], inputs.map(input => histories.get(input)?.closes.get(stamp)))
            : histories.get(key)?.closes.get(stamp), source: 'Hourly close' };
        });
        if (!point) continue;
        starts.push(stamp / hour);
        points.push(point);
      }
      if (!points.length) {
        report(['QuantHub has no matching traded hours across these legs in this range.', ...warnings].join(' '), true);
        return;
      }
      const first = starts[0], last = starts.at(-1);
      chart.hidden = false;
      showChart(chart, {
        label: 'Fixed-delivery strategy hourly closes', unit: 'bp', starts, describe,
        tickLabel: value => axisLabel.format(value * hour), xRange: [first, last === first ? first + 1 : last],
        series: [{ ...scope, label: marketNames[scope.id] ?? 'Strategy', points }],
      });
      report([`${points.length.toLocaleString('en-GB')} matching hours · ${describe(first)} to ${describe(last)} · Latest ${formatValue(points.at(-1).value, 'bp')} bp`,
        ...(implied.size ? ['9M legs use matched outright closes.'] : []),
        ...warnings].join(' '), warnings.size > 0);
    } catch (error) {
      if (!request.signal.aborted) report(error.message || 'Hourly history could not be loaded.', true);
    } finally {
      if (activeRequest === request) {
        activeRequest = undefined;
        submit.disabled = false;
      }
    }
  }

  market.addEventListener('change', () => {
    clearChart();
    report('Load the hourly chart for the selected market.');
  });
  form.addEventListener('submit', load);
  return { update, dispose: () => activeRequest?.abort() };
}

export function createPriceOhlc() {
  const levelStyles = {
    price: { label: 'Price level', color: 'blue', dash: [3, 3] },
    support: { label: 'Support', color: 'positive', dash: [7, 4] },
    resistance: { label: 'Resistance', color: 'negative', dash: [7, 4] },
  };
  const dialog = document.createElement('dialog');
  dialog.className = 'price-ohlc-dialog';
  dialog.setAttribute('aria-labelledby', 'price-ohlc-title');
  const today = new Date().toISOString().slice(0, 10);
  dialog.innerHTML = `<div class="dialog-head"><div><h2 id="price-ohlc-title">QuantHub OHLC</h2><p></p></div>
    <form method="dialog"><button class="icon-button" aria-label="Close OHLC chart">×</button></form></div>
    <form class="toolbar price-ohlc-filters">
      <label class="input-label">Interval <select name="interval"><option value="10m">10 minutes</option><option value="1h">1 hour</option><option value="1d" selected>1 day</option></select></label>
      <label class="input-label">From <input type="date" name="from" min="${firstDay}" max="${today}" required></label>
      <label class="input-label">Through <input type="date" name="through" min="${firstDay}" max="${today}" required></label>
      <button class="button small" type="submit">Load candles</button>
    </form>
    <p class="notice" role="status"></p>
    <div class="price-ohlc-content" hidden>
      <div class="structure-chart-info"><div class="control-group" aria-label="Chart zoom and pan">
        ${[['left', 'Pan left', '←'], ['out', 'Zoom out', '−'], ['in', 'Zoom in', '+'], ['right', 'Pan right', '→'], ['reset', 'Reset zoom', 'Reset zoom'], ['all', 'All candles', 'All']].map(([action, label, icon]) =>
          `<button type="button" class="button small" data-ohlc-action="${action}" aria-label="${label}">${icon}</button>`).join('')}
      </div><span class="price-ohlc-count"></span></div>
      <form class="price-level-tools">
        <label class="input-label">Line type <select name="kind">
          ${Object.entries(levelStyles).map(([kind, style]) => `<option value="${kind}">${style.label}</option>`).join('')}
        </select></label>
        <label class="input-label">Level (bp) <input type="number" name="price" step="0.01" required></label>
        <button class="button small" type="submit">Add line</button>
        <button class="button small" type="button" data-pick-level aria-pressed="false">Pick on chart</button>
        <button class="button small" type="button" data-mark-live>Mark live price</button>
      </form>
      <p class="price-level-hint" hidden>Click a level on the chart. Press Esc to cancel.</p>
      <div class="price-level-tools auto-range-tools">
        <label class="input-label">Historical levels <select data-history-levels>
          ${strategyRangeWindows.map(days => `<option value="${days}">${days}-day range</option>`).join('')}
          <option value="0">Off</option>
        </select></label>
        <span class="auto-range-status" aria-live="polite"></span>
      </div>
      <div class="price-level-list" aria-label="Marked price levels" hidden></div>
      <div class="chart-shell price-ohlc-plot"><canvas role="img" aria-label="QuantHub OHLC candlestick chart" tabindex="0" aria-description="Scroll to zoom, drag to pan, or use the buttons above."></canvas></div>
      <div class="structure-chart-readout as-num"></div>
      <div class="table-scroll price-ohlc-table"><table aria-label="QuantHub OHLC values in basis points">
        <thead><tr><th>Time (UTC)</th><th>Open</th><th>High</th><th>Low</th><th>Close</th></tr></thead><tbody></tbody></table></div>
    </div>`;
  document.body.append(dialog);
  const form = dialog.querySelector('.price-ohlc-filters');
  const status = dialog.querySelector('[role="status"]');
  const content = dialog.querySelector('.price-ohlc-content');
  const canvas = dialog.querySelector('canvas');
  const readout = dialog.querySelector('.structure-chart-readout');
  const count = dialog.querySelector('.price-ohlc-count');
  const table = dialog.querySelector('tbody');
  const actions = [...content.querySelectorAll('[data-ohlc-action]')];
  const levelForm = content.querySelector('.price-level-tools');
  const pickLevel = levelForm.querySelector('[data-pick-level]');
  const markLive = levelForm.querySelector('[data-mark-live]');
  const levelHint = content.querySelector('.price-level-hint');
  const levelList = content.querySelector('.price-level-list');
  const rangeControl = content.querySelector('[data-history-levels]');
  const rangeStatus = content.querySelector('.auto-range-status');
  const candleCache = new Map();
  const observer = new ResizeObserver(draw);
  observer.observe(canvas);
  let target, request, restoreFocus, bars = [], start = 0, size = 0, initialSize = 0, hover, drag, plot;
  let annotationKey, readLive, picking = false, levels = [];
  let ranges = [], automaticLevels = [];
  const value = price => formatValue(price, 'bp');
  const time = stamp => `${dateLabel.format(stamp)} UTC`;

  function report(message, warning = false) {
    status.textContent = message;
    status.classList.toggle('warning', warning);
  }

  function paintLevels() {
    levelList.hidden = levels.length === 0;
    levelList.innerHTML = levels.map(({ kind, price }, index) => `
      <span class="price-level-tag ${kind}">${levelStyles[kind].label} ${value(price)} bp
        <button type="button" data-remove-level="${index}" aria-label="Remove ${levelStyles[kind].label.toLowerCase()} at ${value(price)} bp">×</button>
      </span>`).join('');
  }

  function saveLevels() {
    try { localStorage.setItem(annotationKey, JSON.stringify(levels)); }
    catch { /* Marks remain available while the chart is open. */ }
    paintLevels();
    draw();
  }

  function setPicking(active) {
    picking = active;
    pickLevel.setAttribute('aria-pressed', String(active));
    canvas.classList.toggle('picking-level', active);
    levelHint.hidden = !active;
  }

  function addLevel(kind, price) {
    if (!Number.isFinite(price)) return;
    const rounded = Number(value(price));
    if (!levels.some(level => level.kind === kind && level.price === rounded)) {
      levels.push({ kind, price: rounded });
      saveLevels();
    }
    setPicking(false);
  }

  function updateLivePrice() {
    if (!dialog.open) return;
    markLive.disabled = !Number.isFinite(readLive?.());
  }

  function updateHistoricalLevels() {
    const days = Number(rangeControl.value);
    const range = ranges.find(item => item.days === days);
    automaticLevels = [];
    rangeStatus.replaceChildren();
    if (range?.count >= minimumPercentileDays) {
      automaticLevels = range.low === range.high
        ? [{ kind: 'price', price: range.low, label: `${days}D low/high` }]
        : [{ kind: 'support', price: range.low, label: `${days}D support` },
           { kind: 'resistance', price: range.high, label: `${days}D resistance` }];
      for (const { kind, price, label } of automaticLevels) {
        const tag = document.createElement('span');
        tag.className = `price-level-tag ${kind}`;
        tag.textContent = `${label} ${value(price)} bp`;
        rangeStatus.append(tag);
      }
    } else if (days) {
      rangeStatus.textContent = `Need ${minimumPercentileDays} daily closes for this window · ${range?.count ?? 0} available`;
    }
    draw();
  }

  function draw() {
    if (content.hidden || !size) return;
    const area = canvasContext(canvas);
    if (!area) return;
    const { context: ctx, width, height } = area;
    const left = 59, right = width - 12, top = 12, bottom = height - 32;
    if (right <= left || bottom <= top) return;
    const stepX = (right - left) / size;
    const x = index => left + (index - start + 0.5) * stepX;
    const style = getComputedStyle(canvas);
    const color = name => style.getPropertyValue(`--${name}`).trim();
    let low = Infinity, high = -Infinity;
    for (let i = start; i < start + size; i++) {
      low = Math.min(low, bars[i][3]); high = Math.max(high, bars[i][2]);
    }
    const padding = Math.max(0.04, (high - low) * 0.08);
    low -= padding; high += padding;
    plot = { left, right, top, bottom, low, high, stepX };
    const y = price => bottom - (price - low) * (bottom - top) / (high - low);
    const gridStep = tickStep(high - low);
    ctx.font = '12px "Segoe UI", sans-serif';
    ctx.fillStyle = color('muted');
    ctx.textAlign = 'right';
    for (let tick = Math.ceil(low / gridStep); tick <= Math.floor(high / gridStep); tick++) {
      const price = tick * gridStep, at = y(price);
      ctx.strokeStyle = color(tick === 0 ? 'plot-origin' : 'plot-grid');
      ctx.beginPath(); ctx.moveTo(left, at); ctx.lineTo(right, at); ctx.stroke();
      ctx.fillText(value(price), left - 7, at + 4);
    }
    const group = Math.max(1, Math.ceil(1 / stepX));
    const body = Math.max(1, Math.min(14, stepX * group * 0.65));
    const up = color('positive'), down = color('negative');
    for (let i = start; i < start + size; i += group) {
      const end = Math.min(i + group, start + size);
      const open = bars[i][1], close = bars[end - 1][4];
      let maximum = bars[i][2], minimum = bars[i][3];
      for (let j = i + 1; j < end; j++) { maximum = Math.max(maximum, bars[j][2]); minimum = Math.min(minimum, bars[j][3]); }
      const at = x((i + end - 1) / 2);
      ctx.strokeStyle = ctx.fillStyle = close >= open ? up : down;
      ctx.beginPath(); ctx.moveTo(at, y(maximum)); ctx.lineTo(at, y(minimum)); ctx.stroke();
      ctx.fillRect(at - body / 2, y(Math.max(open, close)), body, Math.max(1, Math.abs(y(close) - y(open))));
    }
    const ticks = Math.min(size, Math.max(1, Math.floor((right - left) / 110)));
    const withinDay = bars[start + size - 1][0] - bars[start][0] < 86_400_000;
    ctx.fillStyle = color('muted');
    ctx.textAlign = 'center';
    for (let i = 0; i < ticks; i++) {
      const index = start + Math.floor((i + 0.5) * size / ticks);
      const date = bars[index][0];
      ctx.fillText(withinDay ? dateLabel.format(date).slice(-5) : axisLabel.format(date), x(index), height - 10);
    }
    const index = hover ?? (start + size - 1);
    const [stamp, open, maximum, minimum, close] = bars[index];
    if (hover !== undefined) {
      ctx.strokeStyle = color('plot-crosshair');
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(x(index), top); ctx.lineTo(x(index), bottom); ctx.stroke();
    }
    ctx.textAlign = 'right';
    for (const { kind, price, label: caption } of [...automaticLevels, ...levels]) {
      if (price < low || price > high) continue;
      const line = levelStyles[kind], at = y(price);
      ctx.strokeStyle = color(line.color);
      ctx.setLineDash(line.dash);
      ctx.beginPath(); ctx.moveTo(left, at); ctx.lineTo(right, at); ctx.stroke();
      const label = `${caption ?? line.label} ${value(price)} bp`;
      const labelY = clamp(at - 4, top + 12, bottom - 3);
      const labelWidth = ctx.measureText(label).width + 8;
      ctx.fillStyle = color('panel');
      ctx.fillRect(right - labelWidth, labelY - 11, labelWidth, 14);
      ctx.fillStyle = color(line.color);
      ctx.fillText(label, right - 4, labelY);
    }
    readout.textContent = `${time(stamp)} · O ${value(open)}   H ${value(maximum)}   L ${value(minimum)}   C ${value(close)} bp`;
  }

  function move(first, length, updateTable = true) {
    size = clamp(Math.round(length), Math.min(6, bars.length), bars.length);
    start = clamp(Math.round(first), 0, bars.length - size);
    hover = undefined;
    draw();
    if (!updateTable) return;
    count.textContent = `${size.toLocaleString()} of ${bars.length.toLocaleString()} candles`;
    for (const button of actions) {
      const action = button.dataset.ohlcAction;
      button.disabled = (action === 'in' && size <= 6) || (action === 'out' && size === bars.length)
        || (action === 'left' && start === 0) || (action === 'right' && start + size === bars.length);
    }
    table.innerHTML = bars.slice(Math.max(start, start + size - 60), start + size).reverse().map(([stamp, ...levels]) =>
      `<tr><th scope="row">${dateLabel.format(stamp)}</th>${levels.slice(0, 4).map(price => `<td>${value(price)}</td>`).join('')}</tr>`).join('');
  }

  function zoom(factor, anchor = 0.5) {
    const next = clamp(Math.round(size * factor), Math.min(6, bars.length), bars.length);
    move(start + (size - next) * anchor, next);
  }

  function action(name) {
    if (name === 'in' || name === 'out') zoom(name === 'in' ? 0.65 : 1.55);
    else if (name === 'all') move(0, bars.length);
    else if (name === 'reset') move(bars.length - initialSize, initialSize);
    else move(start + Math.max(1, Math.round(size / 4)) * (name === 'left' ? -1 : 1), size);
  }

  function showCandles(data, native, interval, preview = false) {
    const next = native ? scaleCandles(data.candles, native) : data.series[0];
    if (!next.length) {
      if (!preview) report(['No matching traded candles for this date range.', ...data.warnings].join(' '), true);
      return;
    }
    const keepViewport = !content.hidden && (start !== 0 || size !== bars.length);
    const firstVisible = bars[start]?.[0];
    const method = native ? 'Listed QuantHub OHLC' : `Strategy OHLC from matched ${data.sample === '5M' ? '5-minute' : 'hourly'} QuantHub leg closes`;
    report([method, 'UTC', 'Basis points', preview ? 'Loading older candles…' : '', ...data.warnings].filter(Boolean).join(' · '),
      data.warnings.length > 0);
    bars = next;
    content.hidden = false;
    initialSize = interval === '1d' ? bars.length : Math.min(100, bars.length);
    if (keepViewport) move(Math.max(0, bars.findIndex(bar => bar[0] >= firstVisible)), size);
    else action('reset');
  }

  function cachedCandles(url) {
    const cached = candleCache.get(url);
    return cached && Date.now() - cached.time < 120_000 ? cached.data : null;
  }

  async function fetchCandles(url, signal) {
    const cached = cachedCandles(url);
    if (cached) return cached;
    const response = await fetch(url, { signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || data.warnings?.join(' ') || 'QuantHub candles could not be loaded.');
    if (!data.warnings.length && !signal.aborted) {
      candleCache.delete(url);
      if (candleCache.size >= 32) candleCache.delete(candleCache.keys().next().value);
      candleCache.set(url, { time: Date.now(), data });
    }
    return data;
  }

  async function load(event) {
    event?.preventDefault();
    request?.abort();
    const current = request = new AbortController();
    const { interval, from, through } = Object.fromEntries(new FormData(form));
    content.hidden = true;
    setPicking(false);
    plot = undefined;
    if (!from || !through || from > through) { report('Choose a valid date range.', true); return; }
    report('Loading QuantHub candles…');
    const native = interval !== '10m' && target.native;
    const params = new URLSearchParams({ from, through });
    if (native) {
      const [market, family, contract, tenor] = native;
      for (const [key, val] of Object.entries({ market, family, contract, tenor })) params.set(key, val);
      if (interval === '1d') params.set('interval', '1D');
    } else {
      params.set('interval', interval);
      params.set('legs', JSON.stringify([target.legs]));
    }
    const endpoint = `/api/${native ? 'hourly' : 'structure-bars'}?`;
    const url = endpoint + params;
    try {
      if (interval === '1d' && !cachedCandles(url)) {
        for (const days of native ? [14] : [14, 180]) {
          const previewStart = new Date(Date.parse(through) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
          if (from >= previewStart) break;
          const preview = new URLSearchParams(params);
          preview.set('from', previewStart);
          const recent = await fetchCandles(endpoint + preview, current.signal).catch(() => null);
          if (current.signal.aborted) return;
          if (recent) showCandles(recent, native, interval, true);
        }
      }
      const data = await fetchCandles(url, current.signal);
      if (!current.signal.aborted) showCandles(data, native, interval);
    } catch (error) {
      if (!current.signal.aborted) report(content.hidden ? error.message : `Recent candles shown. ${error.message}`, true);
    }
  }

  form.addEventListener('submit', load);
  levelForm.addEventListener('submit', event => {
    event.preventDefault();
    addLevel(levelForm.elements.kind.value, levelForm.elements.price.valueAsNumber);
  });
  pickLevel.addEventListener('click', () => setPicking(!picking));
  markLive.addEventListener('click', () => addLevel('price', readLive?.()));
  rangeControl.addEventListener('change', updateHistoricalLevels);
  levelList.addEventListener('click', event => {
    const button = event.target.closest('[data-remove-level]');
    if (!button) return;
    levels.splice(Number(button.dataset.removeLevel), 1);
    saveLevels();
    levelForm.elements.kind.focus();
  });
  form.elements.interval.addEventListener('change', () => {
    const { interval, from, through } = form.elements;
    if (interval.value !== '1d' && from.value === firstDay && through.value === through.max) {
      from.value = new Date(Date.parse(through.value) - 6 * 86_400_000).toISOString().slice(0, 10);
    }
    load();
  });
  content.addEventListener('click', event => {
    const button = event.target.closest('[data-ohlc-action]');
    if (button) action(button.dataset.ohlcAction);
  });
  canvas.addEventListener('pointerdown', event => {
    if (!plot || event.button !== 0) return;
    if (picking) {
      const { left, right, top, bottom, low, high } = plot;
      const { offsetX: x, offsetY: y } = event;
      if (x >= left && x <= right && y >= top && y <= bottom) {
        const price = low + (bottom - y) / (bottom - top) * (high - low);
        levelForm.elements.price.value = value(price);
        addLevel(levelForm.elements.kind.value, price);
      }
      return;
    }
    canvas.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, start };
  });
  canvas.addEventListener('pointermove', event => {
    if (!plot) return;
    if (drag) move(drag.start + (drag.x - event.clientX) / plot.stepX, size, false);
    else {
      hover = event.offsetX >= plot.left && event.offsetX < plot.right
        ? clamp(start + Math.floor((event.offsetX - plot.left) / plot.stepX), start, start + size - 1) : undefined;
      draw();
    }
  });
  canvas.addEventListener('lostpointercapture', () => { drag = undefined; move(start, size); });
  canvas.addEventListener('pointerleave', () => { hover = undefined; draw(); });
  canvas.addEventListener('wheel', event => {
    if (!plot || !event.deltaY || (event.deltaY > 0 && size === bars.length)) return;
    event.preventDefault();
    zoom(event.deltaY < 0 ? 0.8 : 1.25, clamp((event.offsetX - plot.left) / (plot.right - plot.left), 0, 1));
  }, { passive: false });
  canvas.addEventListener('dblclick', () => action('reset'));
  canvas.addEventListener('keydown', event => {
    const name = { '+': 'in', '=': 'in', '-': 'out', '0': 'reset', ArrowLeft: 'left', ArrowRight: 'right' }[event.key];
    if (name) { event.preventDefault(); action(name); }
  });
  dialog.addEventListener('close', () => { request?.abort(); restoreFocus?.(); });
  dialog.addEventListener('cancel', event => {
    if (picking) { event.preventDefault(); setPicking(false); pickLevel.focus(); }
  });

  return {
    open(selection, focus, key, livePrice, historicalRanges = []) {
      target = selection;
      restoreFocus = focus;
      readLive = livePrice;
      annotationKey = `intermarket-ohlc-levels-v1:${key}`;
      try {
        const stored = JSON.parse(localStorage.getItem(annotationKey) ?? '[]');
        levels = Array.isArray(stored) ? stored.filter(level => level && Object.hasOwn(levelStyles, level.kind) && Number.isFinite(level.price)) : [];
      } catch { levels = []; }
      levelForm.reset();
      paintLevels();
      ranges = historicalRanges;
      rangeControl.value = '60';
      updateHistoricalLevels();
      dialog.querySelector('.dialog-head p').textContent = selection.label;
      const end = new Date().toISOString().slice(0, 10);
      form.elements.through.max = form.elements.from.max = end;
      form.elements.through.value = end;
      form.elements.from.value = firstDay;
      form.elements.interval.value = '1d';
      dialog.showModal();
      updateLivePrice();
      load();
    },
    close: () => { if (dialog.open) dialog.close(); },
    updateLivePrice,
  };
}

function scaleCandles(bars, [, family, , , weight]) {
  const factor = weight * (family === 'out' ? 100 : 1);
  return bars.map(([stamp, open, high, low, close]) => [stamp, open * factor,
    (factor >= 0 ? high : low) * factor, (factor >= 0 ? low : high) * factor, close * factor]);
}
