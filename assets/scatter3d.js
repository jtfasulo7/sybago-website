/*
 * A 3D scatter plot: three metrics as three axes, one point per period, the
 * points joined in time order so the account's path through metric space is a
 * curve you can turn over and look at.
 *
 * Loaded as a plain <script> because this site has no bundler, and written so
 * the same bytes can be evaluated in Node for the tests. The maths lives in
 * exported functions; the canvas work is the class at the bottom.
 *
 * Hand-rolled rather than Three.js. What is needed here is a perspective
 * divide, a depth sort and a wireframe box — a few hundred lines — against a
 * library that would arrive as a second module format to reconcile with no
 * bundler to reconcile it. The whole visual language of this page is CSS custom
 * properties, and a renderer that cannot read them would need its palette
 * duplicated and kept in step by hand.
 */
(function (global) {
  'use strict';

  var TAU = Math.PI * 2;

  /* ====================================================== geometry ======= */

  /**
   * Turn the world, then tilt it.
   *
   * Yaw before pitch, always in that order. Composing them the other way makes
   * dragging feel like the model is fighting you: the horizontal axis would
   * change meaning depending on how far you had already tilted, because the
   * second rotation would be about an axis the first one had already moved.
   */
  function rotate(p, yaw, pitch) {
    var cy = Math.cos(yaw), sy = Math.sin(yaw);
    var x1 = p.x * cy - p.z * sy;
    var z1 = p.x * sy + p.z * cy;

    var cp = Math.cos(pitch), sp = Math.sin(pitch);
    var y2 = p.y * cp - z1 * sp;
    var z2 = p.y * sp + z1 * cp;

    return { x: x1, y: y2, z: z2 };
  }

  /**
   * Perspective divide. `scale` is handed back as well as the screen position
   * because everything else — point radius, line width, alpha — is a function
   * of how far away the thing is, and recomputing it per primitive would be
   * both slower and a chance to disagree with the projection.
   */
  function project(p, cam) {
    var denom = cam.distance + p.z;
    // Behind the camera. Clamped rather than skipped so a point that swings
    // through the near plane degrades instead of vanishing mid-drag.
    if (denom < 1) denom = 1;
    var scale = cam.fov / denom;
    return {
      x: cam.cx + p.x * scale,
      y: cam.cy - p.y * scale,      // screen y grows downward; the plot does not
      scale: scale,
      depth: p.z,
    };
  }

  /** Rotate then project, in the order every caller wants. */
  function place(p, cam) {
    return project(rotate(p, cam.yaw, cam.pitch), cam);
  }

  /* ====================================================== scales ========= */

  /**
   * Axis ticks at values a person would have chosen: 1, 2, 5 and their powers.
   *
   * Dividing the range into n equal parts gives ticks like 3.7143, which is
   * accurate and unreadable. Nobody scanning an axis wants to parse a number
   * that precise; they want to know roughly where they are.
   */
  function niceTicks(min, max, count) {
    count = count || 5;
    if (!isFinite(min) || !isFinite(max)) return [];
    if (min === max) return [min];

    /* Round the ideal step UP to the next nice number, never down. Rounding
       down produces more ticks than were asked for and they crowd. The
       comparison has to run smallest-first, too: written largest-first the rule
       inverts and every axis comes back too coarse — 0 to 100 in two steps
       instead of five, which still looks like a plausible axis.

       Named mult rather than norm because the module already has a norm(), and
       shadowing it inside the one function that does not call it is a trap. */
    var raw = (max - min) / count;
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var mult = raw / mag;
    var step = (mult <= 1 ? 1 : mult <= 2 ? 2 : mult <= 5 ? 5 : 10) * mag;

    /* Accumulating a float step lands on 0.6000000000000001. Rounding to the
       step's own precision fixes it at the source, rather than leaving every
       formatter downstream to hide it — and one of them eventually will not. */
    var decimals = Math.max(0, -Math.floor(Math.log(step) / Math.LN10));
    var out = [];
    var t = Math.ceil(min / step) * step;
    // The epsilon keeps a tick that lands exactly on max from being dropped by
    // floating point drift — the top of an axis is the one you most want named.
    for (; t <= max + step * 1e-9; t += step) out.push(Number(t.toFixed(decimals)));
    return out;
  }

  /**
   * A metric value to a position in the unit cube, -0.5 to 0.5.
   *
   * A flat axis — every value identical — centres rather than dividing by zero.
   * That happens more than it sounds: an ad set with one day of delivery, or a
   * metric that has not moved.
   */
  function norm(v, min, max) {
    if (!isFinite(v)) return null;
    if (max === min) return 0;
    return (v - min) / (max - min) - 0.5;
  }

  /** The extent of one axis across every series, padded so nothing sits on the wall. */
  function extent(series, key) {
    var min = Infinity, max = -Infinity;
    series.forEach(function (s) {
      s.points.forEach(function (p) {
        var v = p[key];
        if (v == null || !isFinite(v)) return;
        if (v < min) min = v;
        if (v > max) max = v;
      });
    });
    if (min === Infinity) return { min: 0, max: 1, empty: true };
    if (min === max) {
      // A single distinct value still needs a box to sit in the middle of.
      var pad = Math.abs(min) * 0.1 || 1;
      return { min: min - pad, max: max + pad, flat: true };
    }
    var span = max - min;
    return { min: min - span * 0.05, max: max + span * 0.05 };
  }

  /* ====================================================== the box ======== */

  /* The eight corners of the unit cube, and the twelve edges joining them.
     Indices rather than coordinates so an edge is two lookups, not two copies
     that can drift apart. */
  var CORNERS = [
    [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5],
    [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5],
  ];
  var EDGES = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];

  /* ====================================================== easing ========= */

  /** Critically-damped-ish approach. The reference lerps its pointer the same
      way; it is what makes a drag feel weighted rather than nervous. */
  function approach(current, target, rate) {
    return current + (target - current) * rate;
  }

  var clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };
  var easeOutCubic = function (t) { return 1 - Math.pow(1 - t, 3); };

  /* ====================================================== the plot ======= */

  function Plot(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts || {};

    this.series = [];
    this.axes = { x: null, y: null, z: null };

    this.cam = {
      yaw: -0.62, pitch: 0.42,          // a three-quarter view: all three axes read
      targetYaw: -0.62, targetPitch: 0.42,
      distance: 3.1, targetDistance: 3.1,
      fov: 900, cx: 0, cy: 0, size: 1,
    };

    this.spin = this.opts.autoRotate !== false;
    this.running = true;
    this.reveal = 0;                    // 0..1 entrance progress
    this.pointerDown = false;
    this.hover = null;
    this.raf = null;
    this.dpr = 1;

    this._bind();
  }

  Plot.prototype.setData = function (series, axes) {
    this.series = series || [];
    this.axes = axes;
    this.reveal = 0;                    // new data earns a new entrance
    this.resize();
    return this;
  };

  Plot.prototype.setAngles = function (yaw, pitch) {
    this.cam.targetYaw = yaw;
    this.cam.targetPitch = clamp(pitch, -1.45, 1.45);
    return this;
  };

  Plot.prototype.resize = function () {
    var rect = this.canvas.getBoundingClientRect();
    // Capped at 2: beyond that the extra pixels cost real frame time on a
    // laptop and nobody can see them.
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.cam.cx = rect.width / 2;
    this.cam.cy = rect.height / 2;
    this.width = rect.width;
    this.height = rect.height;
    // Sized off the SMALLER edge so a wide panel does not push the top and
    // bottom of the box out of frame. 0.72 rather than filling it: perspective
    // makes the near face larger than this nominal size, and the axis names sit
    // outside the box entirely.
    this.cam.size = Math.min(rect.width, rect.height) * 0.72;
    return this;
  };

  /* ------------------------------------------------------- interaction --- */

  Plot.prototype._bind = function () {
    var self = this;
    var last = null;

    this._onDown = function (e) {
      self.pointerDown = true;
      self.spin = false;                // a hand on it beats a timer
      last = { x: e.clientX, y: e.clientY };
      self.canvas.setPointerCapture && self.canvas.setPointerCapture(e.pointerId);
    };

    this._onMove = function (e) {
      var rect = self.canvas.getBoundingClientRect();
      self.pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (!self.pointerDown || !last) return;
      var dx = e.clientX - last.x, dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      self.cam.targetYaw += dx * 0.008;
      // Pitch stops short of straight down. Past vertical the world flips and
      // the drag direction inverts under the hand holding it.
      self.cam.targetPitch = clamp(self.cam.targetPitch + dy * 0.006, -1.45, 1.45);
    };

    this._onUp = function () { self.pointerDown = false; last = null; };
    this._onLeave = function () { self.pointer = null; };

    this._onWheel = function (e) {
      e.preventDefault();
      self.cam.targetDistance = clamp(self.cam.targetDistance + e.deltaY * 0.0016, 1.9, 6.5);
    };

    canvasOn(this.canvas, 'pointerdown', this._onDown);
    canvasOn(this.canvas, 'pointermove', this._onMove);
    canvasOn(this.canvas, 'pointerup', this._onUp);
    canvasOn(this.canvas, 'pointercancel', this._onUp);
    canvasOn(this.canvas, 'pointerleave', this._onLeave);
    canvasOn(this.canvas, 'wheel', this._onWheel, { passive: false });
  };

  function canvasOn(el, type, fn, opts) {
    if (el && el.addEventListener) el.addEventListener(type, fn, opts || false);
  }

  Plot.prototype.destroy = function () {
    this.running = false;
    if (this.raf) global.cancelAnimationFrame(this.raf);
    var c = this.canvas;
    if (!c || !c.removeEventListener) return;
    c.removeEventListener('pointerdown', this._onDown);
    c.removeEventListener('pointermove', this._onMove);
    c.removeEventListener('pointerup', this._onUp);
    c.removeEventListener('pointercancel', this._onUp);
    c.removeEventListener('pointerleave', this._onLeave);
    c.removeEventListener('wheel', this._onWheel);
  };

  /* ------------------------------------------------------------ frame ---- */

  Plot.prototype.start = function () {
    var self = this;
    this.running = true;
    var tick = function () {
      if (!self.running) return;
      self.step();
      self.draw();
      self.raf = global.requestAnimationFrame(tick);
    };
    this.raf = global.requestAnimationFrame(tick);
    return this;
  };

  Plot.prototype.stop = function () {
    this.running = false;
    if (this.raf) global.cancelAnimationFrame(this.raf);
    this.raf = null;
    return this;
  };

  Plot.prototype.step = function () {
    var c = this.cam;
    if (this.spin && !this.pointerDown) c.targetYaw += 0.0022;

    // Everything eases toward its target rather than snapping to it. This one
    // line is most of why the thing feels expensive.
    c.yaw = approach(c.yaw, c.targetYaw, 0.12);
    c.pitch = approach(c.pitch, c.targetPitch, 0.12);
    c.distance = approach(c.distance, c.targetDistance, 0.1);

    if (this.reveal < 1) this.reveal = Math.min(1, this.reveal + 0.022);
  };

  Plot.prototype.pointAt = function (p) {
    var s = this.cam.size;
    return place({ x: p.px * s, y: p.py * s, z: p.pz * s }, {
      yaw: this.cam.yaw, pitch: this.cam.pitch,
      distance: this.cam.distance * s, fov: this.cam.fov,
      cx: this.cam.cx, cy: this.cam.cy,
    });
  };

  Plot.prototype.cornerAt = function (i) {
    var s = this.cam.size;
    var c = CORNERS[i];
    return place({ x: c[0] * s, y: c[1] * s, z: c[2] * s }, {
      yaw: this.cam.yaw, pitch: this.cam.pitch,
      distance: this.cam.distance * s, fov: this.cam.fov,
      cx: this.cam.cx, cy: this.cam.cy,
    });
  };

  /* ------------------------------------------------------------- draw ---- */

  Plot.prototype.draw = function () {
    var ctx = this.ctx;
    var t = this.theme || {};
    if (!this.width) this.resize();

    ctx.clearRect(0, 0, this.width, this.height);
    if (t.bg) {
      ctx.fillStyle = t.bg;
      ctx.fillRect(0, 0, this.width, this.height);
    }

    this._drawBox();
    this._drawAxes();
    this._drawSeries();
  };

  /**
   * Tick marks and axis names, drawn on whichever edges are furthest back.
   *
   * Labels on a near edge sit on top of the data and have to be read through
   * it. Picking the far edge each frame means they stay behind the curve as the
   * box turns, which is what stops the plot looking cluttered from every angle
   * except the one it was designed at.
   */
  Plot.prototype._drawAxes = function () {
    var ctx = this.ctx;
    var t = this.theme || {};
    var self = this;
    var eased = easeOutCubic(this.reveal);
    if (eased < 0.15) return;

    // Each axis runs along one cube edge. The candidates are the four parallel
    // edges; the one drawn is whichever is deepest, i.e. furthest from the eye.
    var RUNS = {
      x: [[0, 1], [3, 2], [4, 5], [7, 6]],
      y: [[0, 3], [1, 2], [4, 7], [5, 6]],
      z: [[0, 4], [1, 5], [2, 6], [3, 7]],
    };

    ['x', 'y', 'z'].forEach(function (axis) {
      var meta = self.axes && self.axes[axis];
      if (!meta) return;

      /* The OUTERMOST edge, not the deepest one.
          Picking by depth alone puts the labels on the back edge, which at most
          angles runs straight through the middle of the box — the ticks then
          read as floating among the data rather than bounding it. Furthest from
          the projected centre keeps them on the silhouette, where an axis
          belongs, with depth only breaking ties. */
      var cx = 0, cy = 0;
      for (var ci = 0; ci < 8; ci++) { var q = self.cornerAt(ci); cx += q.x / 8; cy += q.y / 8; }

      var best = null;
      RUNS[axis].forEach(function (pair) {
        var a = self.cornerAt(pair[0]), b = self.cornerAt(pair[1]);
        var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        var out = Math.hypot(mx - cx, my - cy);
        var depth = (a.depth + b.depth) / 2;
        if (!best || out > best.out + 1 || (Math.abs(out - best.out) <= 1 && depth > best.depth)) {
          best = { a: a, b: b, depth: depth, out: out, pair: pair };
        }
      });
      if (!best) return;

      var ticks = niceTicks(meta.min, meta.max, 4);
      ctx.save();
      ctx.globalAlpha = eased * 0.9;
      ctx.font = '500 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.fillStyle = t.tick;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      ticks.forEach(function (v) {
        var f = norm(v, meta.min, meta.max) + 0.5;              // 0..1 along the edge
        var x = best.a.x + (best.b.x - best.a.x) * f;
        var y = best.a.y + (best.b.y - best.a.y) * f;
        ctx.fillText(meta.format ? meta.format(v) : String(v), x, y);
      });

      // The axis name sits past the end of its own edge, so it never lands on
      // a tick or on another axis's name.
      var mx = best.a.x + (best.b.x - best.a.x) * 1.14;
      var my = best.a.y + (best.b.y - best.a.y) * 1.14;
      ctx.font = '700 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.fillStyle = t.axis;
      ctx.fillText(String(meta.label || axis).toUpperCase(), mx, my);
      ctx.restore();
    });
  };

  /**
   * The point nearest the cursor, in screen space, within a tolerance.
   *
   * Nearest in SCREEN space, not in the data — the user is pointing at pixels.
   * Ties broken by depth so the front point wins, which is the one they can
   * actually see.
   */
  Plot.prototype.hitTest = function (sx, sy, tolerance) {
    var self = this;
    var best = null;
    var tol = tolerance == null ? 14 : tolerance;

    this.series.forEach(function (s, si) {
      if (s.hidden) return;
      s.points.forEach(function (p, i) {
        if (p.px == null) return;
        var q = self.pointAt(p);
        var d = Math.hypot(q.x - sx, q.y - sy);
        if (d > tol) return;
        if (!best || d < best.d - 2 || (Math.abs(d - best.d) <= 2 && q.depth < best.depth)) {
          best = { d: d, depth: q.depth, series: s, seriesIndex: si, point: p, index: i, screen: q };
        }
      });
    });
    return best;
  };

  Plot.prototype._drawBox = function () {
    var ctx = this.ctx;
    var t = this.theme || {};
    var pts = [];
    for (var i = 0; i < CORNERS.length; i++) pts.push(this.cornerAt(i));

    /* Edges are drawn back to front and faded by depth, which is what reads as
       a solid box rather than a flat hexagon of lines. */
    var edges = EDGES.map(function (e) {
      return { a: pts[e[0]], b: pts[e[1]], depth: (pts[e[0]].depth + pts[e[1]].depth) / 2 };
    }).sort(function (a, b) { return b.depth - a.depth; });

    edges.forEach(function (e) {
      var far = e.depth > 0;
      ctx.beginPath();
      ctx.moveTo(e.a.x, e.a.y);
      ctx.lineTo(e.b.x, e.b.y);
      ctx.strokeStyle = far ? t.gridFar : t.gridNear;
      ctx.lineWidth = far ? 0.8 : 1.1;
      ctx.stroke();
    });
  };

  /**
   * The curves.
   *
   * Segments and markers go into one list and are drawn in depth order, so a
   * near curve genuinely covers a far one. Drawing each series in turn instead
   * would let whichever happened to be last sit on top regardless of where it
   * actually is, which reads as the plot being flat.
   */
  Plot.prototype._drawSeries = function () {
    var ctx = this.ctx;
    var self = this;
    var t = this.theme || {};
    var jobs = [];
    var eased = easeOutCubic(this.reveal);

    this.series.forEach(function (s, si) {
      if (s.hidden) return;
      var placed = s.points.map(function (p) { return p.px == null ? null : self.pointAt(p); });

      // The curve draws itself in as the entrance runs, rather than fading up
      // whole — it is a path through time, so it should arrive as one.
      var shown = Math.max(1, Math.round(placed.length * eased));

      for (var i = 1; i < shown; i++) {
        var a = placed[i - 1], b = placed[i];
        if (!a || !b) continue;
        jobs.push({ kind: 'line', a: a, b: b, s: s, si: si, depth: (a.depth + b.depth) / 2 });
      }
      for (var j = 0; j < shown; j++) {
        if (placed[j]) jobs.push({ kind: 'dot', p: placed[j], s: s, si: si, i: j, depth: placed[j].depth });
      }
    });

    jobs.sort(function (a, b) { return b.depth - a.depth; });

    jobs.forEach(function (job) {
      // Far things are dimmer and thinner. Same trick as the reference's
      // depthAlpha, and it is what gives the impression of air in the box.
      var near = clamp(1 - (job.depth / self.cam.size + 0.6) / 1.6, 0, 1);
      var alpha = (0.28 + near * 0.72) * eased;

      if (job.kind === 'line') {
        ctx.save();
        ctx.globalAlpha = alpha * 0.9;
        ctx.strokeStyle = job.s.colour;
        ctx.lineWidth = (1 + near * 1.4) * (job.s.emphasis ? 1.6 : 1);
        ctx.setLineDash((job.s.dash || []).map(function (n) { return n * (0.6 + near * 0.6); }));
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(job.a.x, job.a.y);
        ctx.lineTo(job.b.x, job.b.y);
        ctx.stroke();
        ctx.restore();
        return;
      }

      var r = (2.2 + near * 3.2) * (job.s.emphasis ? 1.25 : 1);
      ctx.save();
      ctx.globalAlpha = alpha;
      // Marker SHAPE carries the series as well as colour, so the plot survives
      // being printed, screenshotted, or looked at by someone colour-blind —
      // the same reason the 2D chart varies its point styles.
      drawMarker(ctx, job.s.point, job.p.x, job.p.y, r, job.s.colour, t.pointFill);
      ctx.restore();
    });
  };

  function drawMarker(ctx, shape, x, y, r, colour, fill) {
    ctx.beginPath();
    switch (shape) {
      case 'rect':
        ctx.rect(x - r, y - r, r * 2, r * 2);
        break;
      case 'rectRot':
        ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
        break;
      case 'triangle':
        ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r * 0.8); ctx.lineTo(x - r, y + r * 0.8); ctx.closePath();
        break;
      case 'cross':
        ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
        ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
        ctx.strokeStyle = colour; ctx.lineWidth = 1.6; ctx.stroke();
        return;
      case 'star':
        for (var i = 0; i < 5; i++) {
          var a1 = -Math.PI / 2 + (i * TAU) / 5;
          var a2 = a1 + TAU / 10;
          ctx.lineTo(x + Math.cos(a1) * r, y + Math.sin(a1) * r);
          ctx.lineTo(x + Math.cos(a2) * r * 0.45, y + Math.sin(a2) * r * 0.45);
        }
        ctx.closePath();
        break;
      default:
        ctx.arc(x, y, r, 0, TAU);
    }
    ctx.fillStyle = fill || '#fff';
    ctx.fill();
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  /* ====================================================== exports ======== */

  var Scatter3D = {
    rotate: rotate,
    project: project,
    place: place,
    niceTicks: niceTicks,
    norm: norm,
    extent: extent,
    approach: approach,
    drawMarker: drawMarker,
    CORNERS: CORNERS,
    EDGES: EDGES,
    Plot: Plot,
  };

  global.Scatter3D = Scatter3D;
  if (typeof module !== 'undefined' && module.exports) module.exports = Scatter3D;
})(typeof globalThis !== 'undefined' ? globalThis : this);
