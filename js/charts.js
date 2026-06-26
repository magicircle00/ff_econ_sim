/*
 * charts.js — minimal dependency-free canvas line charts
 * ----------------------------------------------------------------------------
 * Draws a single-series line chart into a <canvas>. Handles HiDPI scaling,
 * downsampling for large series, gridlines, axis labels, and a hover readout.
 * No external libraries so the tool stays self-contained and offline-capable.
 */
(function (root) {
  'use strict';

  function fmt(n) {
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(Math.round(n));
  }

  // Largest-Triangle-Three-Buckets-ish simple downsample: keep min & max per
  // bucket so spikes survive. Returns indices into the original arrays.
  function downsample(xs, ys, maxPoints) {
    const n = xs.length;
    if (n <= maxPoints) return { xs, ys };
    const bucket = Math.ceil(n / (maxPoints / 2));
    const ox = [];
    const oy = [];
    for (let i = 0; i < n; i += bucket) {
      let lo = i, hi = i;
      for (let j = i; j < Math.min(i + bucket, n); j++) {
        if (ys[j] < ys[lo]) lo = j;
        if (ys[j] > ys[hi]) hi = j;
      }
      const first = Math.min(lo, hi), second = Math.max(lo, hi);
      ox.push(xs[first]); oy.push(ys[first]);
      if (second !== first) { ox.push(xs[second]); oy.push(ys[second]); }
    }
    return { xs: ox, ys: oy };
  }

  function draw(canvas, xs, ys, opts) {
    opts = opts || {};
    const css = getComputedStyle(document.documentElement);
    const color = opts.color || css.getPropertyValue('--accent').trim() || '#3b82f6';
    const grid = css.getPropertyValue('--chart-grid').trim() || 'rgba(127,127,127,0.18)';
    const text = css.getPropertyValue('--chart-text').trim() || '#888';

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 600;
    const h = canvas.clientHeight || 220;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const padL = 54, padR = 12, padT = 14, padB = 24;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    if (!xs.length) {
      ctx.fillStyle = text;
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText('No data — run a simulation', padL, padT + plotH / 2);
      return;
    }

    const ds = downsample(xs, ys, Math.max(200, plotW));
    const dxs = ds.xs, dys = ds.ys;

    let minY = Math.min(...dys), maxY = Math.max(...dys);
    if (opts.zeroBased && minY > 0) minY = 0;
    if (minY === maxY) { maxY = minY + 1; minY = Math.min(0, minY); }
    const minX = xs[0], maxX = xs[xs.length - 1];

    const X = (x) => padL + ((x - minX) / (maxX - minX || 1)) * plotW;
    const Y = (y) => padT + plotH - ((y - minY) / (maxY - minY || 1)) * plotH;

    // Gridlines + y labels
    ctx.strokeStyle = grid;
    ctx.fillStyle = text;
    ctx.font = '10px system-ui, sans-serif';
    ctx.lineWidth = 1;
    const yTicks = 4;
    for (let i = 0; i <= yTicks; i++) {
      const val = minY + (i / yTicks) * (maxY - minY);
      const y = Y(val);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.fillText(fmt(val), 6, y + 3);
    }
    // x labels (start / mid / end). opts.xFormat lets callers label time, etc.
    const xfmt = opts.xFormat || fmt;
    ctx.textAlign = 'center';
    [minX, (minX + maxX) / 2, maxX].forEach((xv) => {
      ctx.fillText(xfmt(xv), X(xv), h - 8);
    });
    ctx.textAlign = 'left';

    // Fill under line
    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, color + '40');
    grad.addColorStop(1, color + '00');
    ctx.beginPath();
    ctx.moveTo(X(dxs[0]), Y(dys[0]));
    for (let i = 1; i < dxs.length; i++) ctx.lineTo(X(dxs[i]), Y(dys[i]));
    ctx.lineTo(X(dxs[dxs.length - 1]), Y(minY));
    ctx.lineTo(X(dxs[0]), Y(minY));
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    ctx.moveTo(X(dxs[0]), Y(dys[0]));
    for (let i = 1; i < dxs.length; i++) ctx.lineTo(X(dxs[i]), Y(dys[i]));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  // Multi-series line chart. `seriesList` = [{ ys, color, label }]. All series
  // share the same xs. Draws a small legend top-left. Used for coins in vs out.
  function drawMulti(canvas, xs, seriesList, opts) {
    opts = opts || {};
    const css = getComputedStyle(document.documentElement);
    const grid = css.getPropertyValue('--chart-grid').trim() || 'rgba(127,127,127,0.18)';
    const text = css.getPropertyValue('--chart-text').trim() || '#888';

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 600;
    const h = canvas.clientHeight || 220;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const padL = 54, padR = 12, padT = 14, padB = 24;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    if (!xs.length || !seriesList.length) {
      ctx.fillStyle = text;
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText('No data — run a simulation', padL, padT + plotH / 2);
      return;
    }

    let minY = Infinity, maxY = -Infinity;
    seriesList.forEach((s) => {
      for (let i = 0; i < s.ys.length; i++) {
        if (s.ys[i] < minY) minY = s.ys[i];
        if (s.ys[i] > maxY) maxY = s.ys[i];
      }
    });
    if (opts.zeroBased && minY > 0) minY = 0;
    if (minY === maxY) { maxY = minY + 1; minY = Math.min(0, minY); }
    const minX = xs[0], maxX = xs[xs.length - 1];

    const X = (x) => padL + ((x - minX) / (maxX - minX || 1)) * plotW;
    const Y = (y) => padT + plotH - ((y - minY) / (maxY - minY || 1)) * plotH;

    ctx.strokeStyle = grid;
    ctx.fillStyle = text;
    ctx.font = '10px system-ui, sans-serif';
    ctx.lineWidth = 1;
    const yTicks = 4;
    for (let i = 0; i <= yTicks; i++) {
      const val = minY + (i / yTicks) * (maxY - minY);
      const y = Y(val);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.fillText(fmt(val), 6, y + 3);
    }
    const xfmt = opts.xFormat || fmt;
    ctx.textAlign = 'center';
    [minX, (minX + maxX) / 2, maxX].forEach((xv) => {
      ctx.fillText(xfmt(xv), X(xv), h - 8);
    });
    ctx.textAlign = 'left';

    seriesList.forEach((s) => {
      const ds = downsample(xs, s.ys, Math.max(200, plotW));
      ctx.beginPath();
      ctx.moveTo(X(ds.xs[0]), Y(ds.ys[0]));
      for (let i = 1; i < ds.xs.length; i++) ctx.lineTo(X(ds.xs[i]), Y(ds.ys[i]));
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    });

    // Legend (top-left, inside plot)
    let lx = padL + 6;
    const ly = padT + 4;
    ctx.font = '10px system-ui, sans-serif';
    seriesList.forEach((s) => {
      ctx.fillStyle = s.color;
      ctx.fillRect(lx, ly, 10, 3);
      lx += 14;
      ctx.fillStyle = text;
      const label = s.label || '';
      ctx.fillText(label, lx, ly + 4);
      lx += ctx.measureText(label).width + 14;
    });
  }

  // Vertical bar chart for categorical counts. `labels`/`values` are parallel
  // arrays; `colors` optionally one color per bar. Used for spin-category mix.
  function drawBars(canvas, labels, values, opts) {
    opts = opts || {};
    const css = getComputedStyle(document.documentElement);
    const grid = css.getPropertyValue('--chart-grid').trim() || 'rgba(127,127,127,0.18)';
    const text = css.getPropertyValue('--chart-text').trim() || '#888';
    const accent = css.getPropertyValue('--accent').trim() || '#3b82f6';

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 600;
    const h = canvas.clientHeight || 220;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const padL = 54, padR = 12, padT = 14, padB = 34;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    if (!labels.length) {
      ctx.fillStyle = text;
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText('No data — run a simulation', padL, padT + plotH / 2);
      return;
    }

    let maxV = Math.max(...values, 1);
    const Y = (v) => padT + plotH - (v / maxV) * plotH;

    // y gridlines
    ctx.strokeStyle = grid;
    ctx.fillStyle = text;
    ctx.font = '10px system-ui, sans-serif';
    ctx.lineWidth = 1;
    const yTicks = 4;
    for (let i = 0; i <= yTicks; i++) {
      const val = (i / yTicks) * maxV;
      const y = Y(val);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.fillText(fmt(val), 6, y + 3);
    }

    const n = labels.length;
    const slot = plotW / n;
    const bw = Math.min(slot * 0.62, 64);
    const total = values.reduce((a, b) => a + b, 0) || 1;
    for (let i = 0; i < n; i++) {
      const cx = padL + slot * i + slot / 2;
      const top = Y(values[i]);
      ctx.fillStyle = (opts.colors && opts.colors[i]) || accent;
      ctx.fillRect(cx - bw / 2, top, bw, padT + plotH - top);
      // value + pct label above bar
      ctx.fillStyle = text;
      ctx.textAlign = 'center';
      const pct = ((values[i] / total) * 100).toFixed(0);
      ctx.fillText(`${fmt(values[i])} (${pct}%)`, cx, top - 4);
      // category label below
      ctx.fillText(labels[i], cx, h - 10);
      ctx.textAlign = 'left';
    }
  }

  root.Charts = { draw, drawMulti, drawBars, fmt };
})(window);
