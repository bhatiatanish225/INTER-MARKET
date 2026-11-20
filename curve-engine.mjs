export const markets = [
  { id: 'SR3', name: 'SOFR', exchangeCode: 'SR3', color: '#1679b5', currency: 'USD' },
  { id: 'I', name: 'Euribor', exchangeCode: 'I', color: '#7758cd', currency: 'EUR' },
  { id: 'SO3', name: 'SONIA', exchangeCode: 'SO3', color: '#a96015', currency: 'GBP' },
];

export const tenors = [3, 6, 12, 24];
export const percentileWindows = [30, 60, 90, 240];
export const minimumPercentileDays = 5;
const DAY_MS = 86_400_000;
const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const londonMonth = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', year: 'numeric', month: 'numeric', day: 'numeric',
});
export const isQuarter = month => month % 3 === 2;
export const monthLabel = month => `${monthNames[month % 12]} ${Math.floor(month / 12) % 100}`;
export const keyOf = (market, family, start, tenor = 0) => `${market}/${family}/${start}/${tenor}`;
export const typeLabel = (family, tenor) => family === 'out' ? 'Outright' : `${tenor}M ${family}`;

const offsets = {
  out: () => [0],
  spread: tenor => [0, tenor],
  fly: tenor => [0, tenor, 2 * tenor],
};

export function contractLabel(family, start, tenor) {
  return offsets[family](tenor).map(offset => monthLabel(start + offset)).join(' – ');
}

export function currentMonth() {
  const parts = londonMonth.formatToParts();
  return Number(parts.find(p => p.type === 'year').value) * 12
    + Number(parts.find(p => p.type === 'month').value) - 1;
}

export function londonDay(date = new Date()) {
  const parts = Object.fromEntries(londonMonth.formatToParts(date).map(part => [part.type, Number(part.value)]));
  return Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS;
}

export function buildBook(catalog) {
  const listed = new Map();
  const delivery = new Map(markets.map(market => [market.id, new Set()]));
  const startsByType = new Map();
  let historyRefreshedAt = null;
  let historyRefreshFailedAt = null;
  for (const item of catalog) {
    listed.set(keyOf(item.market, item.family, item.start, item.tenor), item);
    if (item.family === 'out') delivery.get(item.market).add(item.start);
    const stamp = item.dailyCloses?.length ? Date.parse(item.historyRefreshedAt) : NaN;
    if (Number.isFinite(stamp) && (historyRefreshedAt === null || stamp > historyRefreshedAt)) {
      historyRefreshedAt = stamp;
    }
    const failed = Date.parse(item.historyRefreshFailedAt);
    if (Number.isFinite(failed) && (historyRefreshFailedAt === null || failed > historyRefreshFailedAt)) {
      historyRefreshFailedAt = failed;
    }
  }
  for (const market of markets) {
    for (const [family, periods] of [['out', [0]], ['spread', tenors], ['fly', tenors]]) {
      for (const tenor of periods) {
        const relevant = new Set(catalog.filter(item =>
          item.market === market.id && item.family === family && item.tenor === tenor,
        ).map(item => item.start));
        const contracts = delivery.get(market.id);
        for (const start of contracts) {
          if (offsets[family](tenor).every(offset => contracts.has(start + offset))) relevant.add(start);
        }
        startsByType.set(keyOf(market.id, family, 0, tenor), relevant);
      }
    }
  }
  return { listed, delivery, startsByType, historyRefreshedAt, historyRefreshFailedAt };
}

export function curveStarts(book, marketIds, family, tenor, filters) {
  const union = new Set();
  for (const market of marketIds) {
    for (const start of book.startsByType.get(keyOf(market, family, 0, tenor))) union.add(start);
  }
  const dates = { now: currentMonth(), ...filters };
  return [...union].filter(start => passDate(start, dates)).sort((a, b) => a - b);
}

export function passDate(start, { cadence = 'quarterly', earlier = false, now = currentMonth() } = {}) {
  return (earlier || start >= now) && (cadence === 'all' || isQuarter(start));
}

export function outOfScaleOutright(item, value) {
  return item.family === 'out' && Number.isFinite(value) && item.mark >= 50
    && (value < item.mark / 10 || value > item.mark * 10);
}

function packageValue(family, values) {
  if (!values.every(Number.isFinite)) return null;
  const [front, middle, back] = values;
  if (family === 'out') return front;
  if (family === 'spread') return (front - middle) * 100;
  return ((front - middle) - (middle - back)) * 100;
}

const marketUnits = (family, market, value) => family !== 'out' && market !== 'SR3' ? value * 100 : value;

function directRead(book, market, family, start, tenor, source, quotes) {
  const record = book.listed.get(keyOf(market, family, start, tenor));
  if (!record) return null;
  const raw = source === 'live' ? quotes[record.id] :
    source === 'settlement' ? record.settle ?? (record.markSource === 'Export settle' ? record.mark : null) : record.mark;
  if (!Number.isFinite(raw) || (source === 'live' && outOfScaleOutright(record, raw))) return null;
  const label = { live: 'L1 VWAP', settlement: 'Export settle' }[source] ?? record.markSource;
  return { value: marketUnits(family, market, raw), source: label };
}

function impliedRead(book, market, family, start, tenor, source, quotes) {
  const legs = offsets[family](tenor).map(offset =>
    directRead(book, market, 'out', start + offset, 0, source, quotes)?.value,
  );
  const value = packageValue(family, legs);
  return value === null ? null : { value, source: 'Implied' };
}

export function marketReader(book, source, quotes, implied = true) {
  return (market, family, start, tenor = 0) => {
    const direct = directRead(book, market, family, start, tenor, source, quotes);
    if (direct || family === 'out' || !implied) return direct;
    return impliedRead(book, market, family, start, tenor, source, quotes);
  };
}

export function liveBoardReader(book, quotes) {
  const live = marketReader(book, 'live', quotes);
  return (market, family, start, tenor = 0) => {
    let point = live(market, family, start, tenor);
    if (!point) return null;
    let note;
    if (family !== 'out' && point.source === 'L1 VWAP' && Math.abs(point.value) >= 250) {
      const implied = impliedRead(book, market, family, start, tenor, 'live', quotes);
      const settlement = directRead(book, market, family, start, tenor, 'settlement');
      const references = [implied?.value, settlement?.value].filter(Number.isFinite);
      if (references.length && Math.abs(point.value) > 10 * Math.max(...references.map(Math.abs))) {
        note = `Listed VWAP (${point.value.toFixed(2)} bp) excluded for scale mismatch.`;
        point = implied;
        if (!point) return { note };
      }
    }
    const readReference = point.source === 'Implied' ? impliedRead : directRead;
    const reference = readReference(book, market, family, start, tenor, 'settlement');
    return { ...point, reference: reference?.value, note };
  };
}

export const compareHistoricalClose = (close, level) => Math.abs(close - level) <= 1e-8 ? 0 : Math.sign(close - level);

function percentileStats(level, sample) {
  if (!Number.isFinite(level) || !sample.length) return { value: null, below: 0, tied: 0 };
  let below = 0, tied = 0;
  for (const [, close] of sample) {
    const comparison = compareHistoricalClose(close, level);
    if (comparison === 0) tied++;
    else if (comparison < 0) below++;
  }
  return { value: 100 * (below + tied / 2) / sample.length, below, tied };
}

export const percentileRank = (level, sample) => percentileStats(level, sample).value;

export function historicalPercentiles(book, today, window) {
  const closes = new Map();
  const samples = new Map();
  const strategySamples = new WeakMap();
  let latest = null;
  for (const record of book.listed.values()) {
    const dates = new Map((record.dailyCloses ?? []).filter(([day, value]) =>
      day >= today - window && day < today && Number.isFinite(value) && !outOfScaleOutright(record, value),
    ));
    if (!dates.size) continue;
    closes.set(record, dates);
    const last = Math.max(...dates.keys());
    latest = latest === null ? last : Math.max(latest, last);
  }
  const lookup = (market, family, start, tenor) => closes.get(book.listed.get(keyOf(market, family, start, tenor)));

  function sample(market, family, start, tenor, basis) {
    const key = `${keyOf(market, family, start, tenor)}/${basis}`;
    if (samples.has(key)) return samples.get(key);
    const direct = basis !== 'implied' ? [...(lookup(market, family, start, tenor) ?? [])]
      .map(([day, price]) => [day, marketUnits(family, market, price)]) : [];
    let selected = { rows: direct, basis: 'Listed daily closes', legs: [] };
    if (family !== 'out' && (basis === 'implied' || (basis === 'fallback' && direct.length < minimumPercentileDays))) {
      const deliveries = offsets[family](tenor).map(offset => start + offset);
      const outrightCloses = deliveries.map(delivery => lookup(market, 'out', delivery, 0));
      const implied = outrightCloses.every(Boolean) ? [...outrightCloses[0].keys()].flatMap(day => {
        const levels = outrightCloses.map(closes => closes.get(day));
        const value = packageValue(family, levels);
        return Number.isFinite(value) ? [[day, value, levels]] : [];
      }) : [];
      if (basis === 'implied' || implied.length > direct.length) {
        const weights = family === 'spread' ? [1, -1] : [1, -2, 1];
        const legs = deliveries.map((delivery, index) => ({
          market, family: 'out', start: delivery, tenor: 0, weight: weights[index], basis: 'Listed daily closes',
        }));
        selected = { rows: implied, basis: 'Implied from same-day outright closes', legs };
      }
    }
    samples.set(key, selected);
    return selected;
  }

  function summarize(level, { rows, basis }) {
    const count = rows.length;
    const stats = percentileStats(level, rows);
    return {
      value: count >= minimumPercentileDays ? stats.value : null,
      below: stats.below, tied: stats.tied,
      count, basis,
      first: count ? Math.min(...rows.map(([day]) => day)) : null,
      last: count ? Math.max(...rows.map(([day]) => day)) : null,
      low: count ? Math.min(...rows.map(([, price]) => price)) : null,
      high: count ? Math.max(...rows.map(([, price]) => price)) : null,
    };
  }

  return {
    latest,
    rank(market, family, start, tenor, point) {
      const { rows, basis, legs } = sample(market, family, start, tenor, point.source === 'Implied' ? 'implied' : 'fallback');
      return { ...summarize(point.value, { rows, basis }), rows, legs };
    },
    strategyRank(strategy, market, start, point, read, includeDetails = false) {
      const legs = strategy.legs.map(leg => {
        const args = strategyLegArgs(leg, market, start);
        return { args, basis: read(...args)?.source === 'Implied' ? 'implied' : 'listed', weight: strategyLegWeight(leg) };
      });
      const recipe = JSON.stringify(strategy.legs);
      let cache = strategySamples.get(strategy);
      if (cache?.recipe !== recipe) {
        cache = { recipe, points: new Map() };
        strategySamples.set(strategy, cache);
      }
      const key = `${market}/${start}/${legs.map(leg => leg.basis).join('/')}`;
      if (!cache.points.has(key)) {
        const inputs = legs.map(leg => sample(...leg.args, leg.basis));
        const prices = inputs.map(input => new Map(input.rows));
        const rows = (inputs[0]?.rows ?? []).flatMap(([day]) => {
          const levels = prices.map(price => price.get(day));
          if (!levels.every(Number.isFinite)) return [];
          const weighted = levels.reduce((sum, value, index) => sum + value * legs[index].weight, 0);
          return Number.isFinite(weighted) ? [[day, weighted, levels]] : [];
        });
        const basis = inputs.some(input => input.basis.startsWith('Implied'))
          ? 'Weighted strategy closes on shared dates · includes implied leg history'
          : 'Weighted listed closes on shared dates';
        const details = legs.map(({ args: [market, family, start, tenor] }, index) => ({
          market, family, start, tenor, basis: inputs[index].basis, weight: Number(strategy.legs[index].weight),
        }));
        cache.points.set(key, { rows, basis, legs: details });
      }
      const observations = cache.points.get(key);
      const rank = summarize(point.value, observations);
      if (!includeDetails) return rank;
      return { ...rank, rows: observations.rows, legs: observations.legs };
    },
  };
}

export function newScenario() {
  return Object.fromEntries(markets.map(market => [
    market.id, { tenor: 3, anchor: '', bridge: '', frontMonth: null, overrides: { 3: {}, 6: {} } },
  ]));
}

export function scenarioMonths(book, market, filters) {
  return [...book.delivery.get(market)].filter(start =>
    passDate(start, { ...filters, cadence: 'quarterly' }),
  ).sort((a, b) => a - b);
}

const inputNumber = value => value === '' || value == null ? null : Number(value);

export function scenarioModel(months, setup, baseline) {
  const nodes = new Map(months.map(month => [month, []]));
  const initial = new Map(months.map(month => [month, baseline(month)]));
  const overrides = setup.overrides[setup.tenor];
  const inputs = [];
  function connect(front, back, bp) {
    if (!Number.isFinite(bp)) return;
    nodes.get(front).push([back, -bp / 100]);
    nodes.get(back).push([front, bp / 100]);
  }
  function implied(front, back) {
    const left = initial.get(front), right = initial.get(back);
    return Number.isFinite(left) && Number.isFinite(right) ? (left - right) * 100 : null;
  }
  for (const month of months) {
    const far = month + setup.tenor;
    if (!nodes.has(far)) continue;
    const base = implied(month, far);
    const override = inputNumber(overrides[month]);
    connect(month, far, override ?? base);
    inputs.push({ start: month, base, override });
  }
  const first = months[0], next = first + 3;
  const sameFront = setup.frontMonth == null || setup.frontMonth === first;
  const anchor = sameFront ? inputNumber(setup.anchor) : null;
  const bridge = (sameFront ? inputNumber(setup.bridge) : null) ?? implied(first, next);
  if (setup.tenor === 6 && nodes.has(next)) connect(first, next, bridge);

  const measures = new Map();
  for (const root of months) {
    if (measures.has(root)) continue;
    const queue = [root];
    const component = { level: null };
    measures.set(root, { component, displacement: 0 });
    for (const month of queue) {
      const { displacement } = measures.get(month);
      const level = (month === first ? anchor : null) ?? initial.get(month);
      if (component.level === null && Number.isFinite(level)) component.level = level - displacement;
      for (const [adjacent, change] of nodes.get(month)) {
        if (measures.has(adjacent)) continue;
        measures.set(adjacent, { component, displacement: displacement + change });
        queue.push(adjacent);
      }
    }
  }
  return {
    inputs, bridge, first, anchor: initial.get(first),
    read(family, start, tenor) {
      const legs = offsets[family](tenor).map(offset => measures.get(start + offset));
      if (legs.some(leg => !leg)) return null;
      const relative = family !== 'out' && legs.every(leg => leg.component === legs[0].component);
      const values = legs.map(({ component, displacement }) =>
        relative ? displacement : component.level === null ? null : component.level + displacement,
      );
      const value = packageValue(family, values);
      return value === null ? null : { value, source: 'Scenario' };
    },
  };
}

export function strategySeries(strategy) {
  return strategy.legs.some(leg => leg.market === 'same')
    ? markets : [{ id: 'intermarket', name: 'Intermarket', color: '#1679b5' }];
}

const strategyLegArgs = (leg, market, start) =>
  [leg.market === 'same' ? market : leg.market, leg.family, start + leg.offset * 3, leg.tenor];
const strategyLegWeight = leg => leg.weight * (leg.family === 'out' ? 100 : 1);

export function readStrategy(strategy, market, start, read) {
  let value = 0;
  const sources = new Set();
  for (const leg of strategy.legs) {
    const point = read(...strategyLegArgs(leg, market, start));
    if (!Number.isFinite(point?.value)) return null;
    value += strategyLegWeight(leg) * point.value;
    sources.add(point.source);
  }
  const source = {
    'L1 VWAP': 'VWAP legs', 'Export last': 'Export legs', 'Export settle': 'Export legs',
    Implied: 'Implied legs', Scenario: 'Scenario',
  };
  return Number.isFinite(value) ? {
    value, source: sources.size === 1 ? source[[...sources][0]] : 'Mixed inputs',
  } : null;
}

export function strategyStarts(book, strategy, filters) {
  const first = strategy.legs[0];
  const scope = first.market === 'same' ? markets.map(market => market.id) : [first.market];
  const candidates = curveStarts(book, scope, first.family, first.tenor, { cadence: 'all', earlier: true });
  const datesFilter = { now: currentMonth(), ...filters };
  return candidates.map(start => start - first.offset * 3).filter(start =>
    passDate(start, datesFilter) && strategySeries(strategy).some(series =>
      strategy.legs.every(leg => {
        const id = leg.market === 'same' ? series.id : leg.market;
        const dates = book.startsByType.get(keyOf(id, leg.family, 0, leg.tenor));
        return dates.has(start + leg.offset * 3);
      }),
    ),
  );
}
