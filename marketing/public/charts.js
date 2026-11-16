// Tiny SVG charts (no library). Single-series charts: one accessible
// green (validated: lightness, chroma and contrast pass on the light
// surface), no legend (the heading names the series), 4px rounded data
// ends, 2px lines, >=8px dots with a 2px surface ring, hairline grid,
// values on hover (wide hit targets) and on the extreme mark only.
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }
  function tick(v) {
    if (Math.abs(v) >= 10000) return (v / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + 'K';
    return v.toLocaleString(undefined, { maximumFractionDigits: v < 10 ? 1 : 0 });
  }
  // Column path: square at the baseline, 4px rounded top.
  function colPath(x, y, w, h) {
    const r = Math.min(4, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  function barPath(x, y, w, h) {
    const r = Math.min(4, h / 2, w);
    return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
  }

  // data: [{ label, value }]
  function columns(el, data, { format = (v) => v, height = 220, integer = false } = {}) {
    if (!data.length) { el.innerHTML = '<div class="chart-empty">No data yet — import a report.</div>'; return; }
    const W = Math.max(320, el.clientWidth || 560), H = height, L = 44, B = 26, T = 18, R = 8;
    const raw = Math.max(...data.map((d) => d.value));
    const max = integer ? Math.max(4, Math.ceil(raw / 4) * 4) : niceMax(raw);
    const band = (W - L - R) / data.length;
    const bw = Math.min(24, band * 0.6);
    const y = (v) => T + (H - T - B) * (1 - v / max);
    const maxIdx = data.reduce((m, d, i) => (d.value > data[m].value ? i : m), 0);
    let s = '';
    for (let i = 0; i <= 4; i++) { const v = (max / 4) * i; s += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${esc(tick(v))}</text>`; }
    const every = Math.ceil(data.length / Math.floor((W - L) / 54));
    data.forEach((d, i) => {
      const cx = L + band * i + band / 2;
      const h = Math.max(0, H - B - y(d.value));
      s += `<g><title>${esc(d.label)}: ${esc(format(d.value))}</title><rect x="${cx - band / 2}" y="${T}" width="${band}" height="${H - T - B}" fill="transparent"/>${h > 0 ? `<path class="mark" d="${colPath(cx - bw / 2, y(d.value), bw, h)}"/>` : ''}</g>`;
      if (i % every === 0) s += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${esc(d.label)}</text>`;
      if (i === maxIdx && d.value > 0) s += `<text class="val" x="${cx}" y="${y(d.value) - 5}" text-anchor="middle">${esc(format(d.value))}</text>`;
    });
    el.innerHTML = `<div class="chart"><svg xmlns="${NS}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Column chart">${s}</svg></div>`;
  }

  // Horizontal bars, value at the tip. data: [{ label, value }]
  function bars(el, data, { format = (v) => v, max: maxRows = 10 } = {}) {
    data = data.slice(0, maxRows);
    if (!data.length) { el.innerHTML = '<div class="chart-empty">No data yet.</div>'; return; }
    const W = Math.max(320, el.clientWidth || 520), row = 30, L = 130, R = 70, T = 6;
    const H = T + row * data.length + 6;
    const max = Math.max(...data.map((d) => d.value)) || 1;
    let s = '';
    data.forEach((d, i) => {
      const yy = T + row * i + 4, bh = 20;
      const w = Math.max(0, (W - L - R) * (d.value / max));
      s += `<g><title>${esc(d.label)}: ${esc(format(d.value))}</title><rect x="0" y="${yy - 4}" width="${W}" height="${row}" fill="transparent"/>`
        + `<text x="${L - 8}" y="${yy + 14}" text-anchor="end">${esc(String(d.label).slice(0, 20))}</text>`
        + (w > 0 ? `<path class="mark" d="${barPath(L, yy, w, bh)}"/>` : '')
        + `<text class="val" x="${L + w + 6}" y="${yy + 14}">${esc(format(d.value))}</text></g>`;
    });
    el.innerHTML = `<div class="chart"><svg xmlns="${NS}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart">${s}</svg></div>`;
  }

  // Rank over time: lower is better, so #1 sits at the top. points: [{ date, rank }]
  function rankLine(el, points, { height = 180 } = {}) {
    if (points.length < 2) { el.innerHTML = '<div class="chart-empty">Two or more rank entries draw a trend.</div>'; return; }
    const W = Math.max(320, el.clientWidth || 520), H = height, L = 44, B = 24, T = 14, R = 50;
    const maxRank = niceMax(Math.max(...points.map((p) => p.rank)));
    const x = (i) => L + ((W - L - R) * i) / (points.length - 1);
    const y = (r) => T + (H - T - B) * ((r - 1) / Math.max(1, maxRank - 1));
    let s = '';
    for (const v of [1, Math.round(maxRank / 2), maxRank]) s += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">#${tick(v)}</text>`;
    s += `<path class="line" d="${points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.rank)}`).join('')}"/>`;
    points.forEach((p, i) => { s += `<g><title>${esc(p.date)}: #${p.rank}</title><circle cx="${x(i)}" cy="${y(p.rank)}" r="12" fill="transparent"/><circle class="dot" cx="${x(i)}" cy="${y(p.rank)}" r="4"/></g>`; });
    const last = points[points.length - 1];
    s += `<text class="val" x="${x(points.length - 1) + 8}" y="${y(last.rank) + 4}">#${last.rank}</text>`;
    s += `<text x="${L}" y="${H - 6}">${esc(points[0].date)}</text><text x="${W - R}" y="${H - 6}" text-anchor="end">${esc(last.date)}</text>`;
    el.innerHTML = `<div class="chart"><svg xmlns="${NS}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Rank trend">${s}</svg></div>`;
  }

  window.Charts = { columns, bars, rankLine };
})();
