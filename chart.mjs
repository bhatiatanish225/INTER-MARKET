import { monthLabel } from './curve-engine.mjs';

const charts = new WeakMap();
export const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export function canvasContext(canvas) {
  const { width, height } = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (width < 1 || height < 1) return null;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const context = canvas.getContext('2d');
  context.scale(dpr, dpr);
  return { context, width, height };
}

function rounded(value, precision) {
  return Math.abs(value) < 0.5 * 10 ** -precision ? 0 : value;
}

export function formatValue(value, unit, plus = false) {
  if (!Number.isFinite(value)) return '—';
  const precision = unit === 'bp' ? 2 : 4;
  const number = rounded(value, precision);
  return `${plus && number > 0 ? '+' : ''}${number.toFixed(precision)}`;
}

function quantile(sorted, percentile) {
  const index = (sorted.length - 1) * percentile;
  const floor = Math.floor(index);
  return sorted[floor] + (sorted[Math.ceil(index)] - sorted[floor]) * (index - floor);
}

export function tickStep(span) {
  const required = span / 6;
  const order = 10 ** Math.floor(Math.log10(required));
  return [1, 2, 2.5, 5, 10].find(mult => mult * order >= required) * order;
}

function bounds(values, unit, focused = false) {
  const minimumSpan = unit === 'bp' ? .02 : .0004;
  let fitted = values;
  if (focused && values.length >= 8) {
    const sorted = [...values].sort((a, b) => a - b);
    const q1 = quantile(sorted, .25), q3 = quantile(sorted, .75);
    const fence = Math.max((q3 - q1) * 4, minimumSpan * 8);
    fitted = sorted.filter(value => value >= q1 - fence && value <= q3 + fence);
  }
  const minimum = Math.min(...fitted), maximum = Math.max(...fitted);
  const span = maximum - minimum;
  const pad = Math.max(span * .07, (minimumSpan - span) / 2);
  const low = minimum > 0 ? Math.max(minimum - pad, minimum * .5) : minimum - pad;
  const high = maximum < 0 ? Math.min(maximum + pad, maximum * .5) : maximum + pad;
  return { low, high, clipped: values.filter(value => value < low || value > high).length };
}

function zoomAxis(domain, base, anchor, factor, minimumSpan) {
  const baseSpan = base[1] - base[0];
  if (!baseSpan) return base;
  const span = clamp((domain[1] - domain[0]) * factor, Math.min(baseSpan, minimumSpan), baseSpan);
  const low = clamp(domain[0] + anchor * (domain[1] - domain[0] - span), base[0], base[1] - span);
  return [low, low + span];
}

function zoomChart(canvas, xAnchor, yAnchor, factor) {
  const model = charts.get(canvas);
  const { base, viewport } = model;
  const x = zoomAxis(viewport.x, base.x, xAnchor, factor, Math.min(1, (base.x[1] - base.x[0]) / 2));
  const y = zoomAxis(viewport.y, base.y, yAnchor, factor, (base.y[1] - base.y[0]) / 200);
  const atBase = [x, y].every(([low, high], index) => {
    const [baseLow, baseHigh] = index === 0 ? base.x : base.y;
    return Math.abs(low - baseLow) < 1e-9 && Math.abs(high - baseHigh) < 1e-9;
  });
  model.zoom = atBase ? null : { x, y };
  model.hover = null;
  draw(canvas);
}

function resetZoom(canvas) {
  const model = charts.get(canvas);
  if (!model.zoom) return;
  model.zoom = null;
  model.hover = null;
  draw(canvas);
}

function draw(canvas) {
  const model = charts.get(canvas);
  const area = canvasContext(canvas);
  if (!model || !area) return;
  const { context: ctx, width, height } = area;
  const { starts, series, unit, hover, tooltip, describe, xRange, tickLabel = monthLabel, reference } = model;
  const palette = getComputedStyle(canvas);
  const axisColor = palette.getPropertyValue('--muted').trim();
  const gridColor = palette.getPropertyValue('--plot-grid').trim();
  const originColor = palette.getPropertyValue('--plot-origin').trim();
  tooltip.hidden = true;
  model.nearest = null;
  model.clipped = 0;
  model.plot = null;
  ctx.font = '12px "Segoe UI", sans-serif';
  const prices = series.flatMap(line => line.points.map(point => point?.value)).filter(Number.isFinite);
  if (!prices.length) {
    ctx.fillStyle = axisColor;
    ctx.textAlign = 'center';
    ctx.fillText(model.empty, width / 2, height / 2, Math.max(80, width - 30));
    return;
  }
  if (reference) prices.push(reference.value);

  const fitted = bounds(prices, unit, model.focused);
  const base = { x: xRange ?? [starts[0], starts.at(-1)], y: [fitted.low, fitted.high] };
  const viewport = model.zoom ?? base;
  const [first, last] = viewport.x, [low, high] = viewport.y;
  const left = width < 430 ? 53 : 66;
  const right = width - 22, top = 27, bottom = height - 39;
  Object.assign(model, { base, viewport, clipped: fitted.clipped, plot: { left, right, top, bottom } });
  canvas.dataset.zoomed = String(Boolean(model.zoom));
  const step = tickStep(high - low);
  const digits = Math.max(0, Math.min(6, Math.ceil(-Math.log10(step)) + Number(step / 10 ** Math.floor(Math.log10(step)) === 2.5)));
  const x = key => last === first ? (left + right) / 2 : left + (key - first) / (last - first) * (right - left);
  const y = value => bottom - (value - low) / (high - low) * (bottom - top);
  ctx.fillStyle = axisColor;
  ctx.textAlign = 'left';
  ctx.fillText(model.axisTitle ?? (unit === 'bp' ? 'Basis points' : 'Price'), 9, 15);

  const firstTick = Math.ceil(low / step - 1e-9);
  const lastTick = Math.floor(high / step + 1e-9);
  for (let i = firstTick; i <= lastTick; i++) {
    const tick = step * i;
    const graphY = y(tick);
    ctx.strokeStyle = Math.abs(tick) < step / 100 ? originColor : gridColor;
    ctx.beginPath();
    ctx.moveTo(left, graphY);
    ctx.lineTo(right, graphY);
    ctx.stroke();
    ctx.fillStyle = axisColor;
    ctx.textAlign = 'right';
    ctx.fillText(rounded(tick, digits).toFixed(digits), left - 8, graphY + 4);
  }
  const visible = starts.flatMap((start, index) => start >= first && start <= last ? [index] : []);
  const labelCapacity = Math.max(2, Math.floor((right - left) / 80));
  const labels = xRange
    ? Array.from({ length: labelCapacity }, (_, i) =>
      Math.ceil(first) + Math.round(i * (Math.floor(last) - Math.ceil(first)) / (labelCapacity - 1)))
      .filter((start, i, dates) => i === 0 || start !== dates[i - 1])
    : visible.map(index => starts[index]);
  const labelStep = Math.max(1, Math.ceil(labels.length / labelCapacity));
  let lastLabelX = -Infinity;
  labels.forEach((start, index) => {
    const pos = x(start);
    const isLast = index === labels.length - 1;
    if (!isLast && index % labelStep !== 0) return;
    if (!isLast && index > 0 && x(labels.at(-1)) - pos < 47) return;
    if (pos - lastLabelX < 43 && !isLast) return;
    lastLabelX = pos;
    ctx.fillStyle = axisColor;
    ctx.textAlign = 'center';
    ctx.fillText(tickLabel(start), pos, bottom + 21);
  });

  ctx.save();
  ctx.beginPath();
  ctx.rect(left - 3, top - 3, right - left + 6, bottom - top + 6);
  ctx.clip();
  for (const line of series) {
    const color = palette.getPropertyValue(`--plot-${line.id}`).trim()
      || (line.id === 'intermarket' ? palette.getPropertyValue('--plot-SR3').trim() : line.color);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash(line.dashed ? [5, 4] : []);
    ctx.beginPath();
    let joined = false;
    starts.forEach((start, index) => {
      const value = line.points[index]?.value;
      if (!Number.isFinite(value) || (model.focused && (value < fitted.low || value > fitted.high))) {
        joined = false;
        return;
      }
      const px = x(start), py = y(value);
      if (joined) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
      joined = true;
    });
    ctx.stroke();
    ctx.setLineDash([]);
    visible.forEach(index => {
      const start = starts[index];
      const value = line.points[index]?.value;
      if (!Number.isFinite(value)) return;
      ctx.beginPath();
      if (!model.zoom && (value < low || value > high)) {
        const direction = value > high ? 1 : -1;
        const edge = value > high ? top : bottom;
        const px = x(start);
        ctx.moveTo(px, edge);
        ctx.lineTo(px + 4, edge + direction * 7);
        ctx.lineTo(px - 4, edge + direction * 7);
        ctx.closePath();
      } else if (value >= low && value <= high) {
        ctx.arc(x(start), y(value), starts.length > 25 ? 2 : 2.75, 0, 2 * Math.PI);
      }
      ctx.fill();
    });
  }
  if (reference && reference.value >= low && reference.value <= high) {
    const levelY = y(reference.value);
    ctx.strokeStyle = palette.getPropertyValue('--plot-reference').trim();
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(left, levelY);
    ctx.lineTo(right, levelY);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();

  model.nearest = pointer => {
    if (!visible.length || pointer < left - 15 || pointer > right + 15) return null;
    return visible.reduce((best, index) =>
      Math.abs(x(starts[index]) - pointer) < Math.abs(x(starts[best]) - pointer) ? index : best);
  };
  if (!visible.includes(hover)) return;
  const hoverX = x(starts[hover]);
  ctx.strokeStyle = palette.getPropertyValue('--plot-crosshair').trim();
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(hoverX, top);
  ctx.lineTo(hoverX, bottom);
  ctx.stroke();

  const heading = document.createElement('strong');
  heading.textContent = describe(starts[hover]);
  const levels = series.map(line => ({ label: line.label, value: line.points[hover]?.value }));
  if (reference) levels.push(reference);
  const details = levels.map(level => {
    const row = document.createElement('div');
    const title = document.createElement('span'), price = document.createElement('span');
    title.textContent = level.label;
    price.textContent = formatValue(level.value, unit);
    row.append(title, price);
    return row;
  });
  tooltip.replaceChildren(heading, ...details);
  tooltip.hidden = false;
  const tipWidth = tooltip.offsetWidth;
  tooltip.style.left = `${Math.max(0, Math.min(hoverX + 12, width - tipWidth - 6))}px`;
  tooltip.style.top = '30px';
}

export function showChart(container, data) {
  let canvas = container.querySelector('canvas');
  if (!canvas) {
    container.innerHTML = '<canvas data-curve role="img" tabindex="0" aria-description="Scroll or press plus or minus to zoom. Double-click or press zero to reset."></canvas><div class="chart-tip" hidden></div>';
    canvas = container.querySelector('canvas');
    canvas.addEventListener('pointermove', event => {
      const model = charts.get(canvas);
      const index = model.nearest?.(event.offsetX) ?? null;
      if (index !== model.hover) {
        model.hover = index;
        draw(canvas);
      }
    });
    canvas.addEventListener('pointerleave', () => {
      const model = charts.get(canvas);
      model.hover = null;
      draw(canvas);
    });
    canvas.addEventListener('wheel', event => {
      const model = charts.get(canvas);
      if (!model.plot || !event.deltaY || (event.deltaY > 0 && !model.zoom)) return;
      const { left, right, top, bottom } = model.plot;
      const x = (event.offsetX - left) / (right - left);
      const y = (bottom - event.offsetY) / (bottom - top);
      if (x < 0 || x > 1 || y < 0 || y > 1) return;
      event.preventDefault();
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 160 : 1);
      zoomChart(canvas, x, y, Math.exp(clamp(pixels * .0025, -.7, .7)));
    }, { passive: false });
    canvas.addEventListener('dblclick', () => resetZoom(canvas));
    canvas.addEventListener('keydown', event => {
      if (!charts.get(canvas).plot || !['+', '=', '-', '0'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === '0') resetZoom(canvas);
      else zoomChart(canvas, .5, .5, event.key === '-' ? 1.28 : .78);
    });
  }
  const previous = charts.get(canvas);
  const view = JSON.stringify([data.label, data.focused, data.unit, data.series.map(line => line.label), data.starts]);
  const keepView = previous?.view === view;
  const model = {
    ...data, view, hover: keepView ? previous.hover : null, zoom: keepView ? previous.zoom : null,
    tooltip: container.querySelector('.chart-tip'),
  };
  charts.set(canvas, model);
  draw(canvas);
  canvas.setAttribute('aria-label', model.clipped ? `${data.label}, ${model.clipped} points outside the visible scale` : data.label);
  return model.clipped ?? 0;
}

export function sparkline(canvas, values, market) {
  const area = canvasContext(canvas);
  const prices = values.filter(Number.isFinite);
  if (!area || prices.length < 2) return;
  const { context: ctx, width, height } = area;
  const { low, high } = bounds(prices, 'price');
  let previous = false;
  ctx.strokeStyle = getComputedStyle(canvas).getPropertyValue(`--plot-${market.id}`).trim() || market.color;
  ctx.lineWidth = 1.7;
  ctx.beginPath();
  values.forEach((price, index) => {
    if (!Number.isFinite(price)) {
      previous = false;
      return;
    }
    const x = 3 + index * (width - 6) / (values.length - 1);
    const y = height - 5 - (price - low) / (high - low) * (height - 10);
    if (previous) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    previous = true;
  });
  ctx.stroke();
}

export function redrawCharts() {
  document.querySelectorAll('canvas[data-curve]').forEach(draw);
}

window.addEventListener('resize', redrawCharts);
