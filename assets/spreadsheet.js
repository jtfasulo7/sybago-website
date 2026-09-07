/*
 * A small spreadsheet: formulas, references, ranges, recalculation.
 *
 * Loaded as a plain <script> because this site has no bundler, and written so
 * the same bytes can be evaluated in Node for the tests — the test runs what
 * the browser runs rather than a parallel copy that can drift.
 *
 * Scope is deliberate. This is a ledger, not Excel: formulas, ranges, about
 * thirty functions, number formats, and reference rewriting when rows move.
 * There are no charts, pivot tables, conditional formatting rules or merged
 * cells, and adding them here rather than admitting the gap is how a small
 * honest tool becomes a large dishonest one.
 *
 * Computed values are NEVER stored. Only what someone typed is persisted, and
 * every value on screen is recalculated from it. A saved value is a value that
 * can go stale without saying so, which is the one thing this whole page is
 * built to avoid.
 */
(function (global) {
  'use strict';

  /* ====================================================== errors ========= */
  /* Errors are objects rather than strings so they cannot be confused with a
     cell that genuinely contains the text "#VALUE!". */
  var ERRORS = ['#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#CYCLE!', '#N/A', '#ERROR!'];
  function err(code) { return { err: code }; }
  function isErr(v) { return v != null && typeof v === 'object' && typeof v.err === 'string'; }

  /* ====================================================== references ===== */

  /** "A" -> 0, "Z" -> 25, "AA" -> 26. */
  function colToIndex(letters) {
    var n = 0;
    for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n - 1;
  }

  /** 0 -> "A", 26 -> "AA". */
  function indexToCol(n) {
    var s = '';
    n += 1;
    while (n > 0) {
      var r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  var REF_RE = /^(\$?)([A-Z]{1,3})(\$?)([0-9]{1,7})$/;

  /** "$B$4" -> {col:1, row:3, absCol:true, absRow:true}, or null. */
  function parseRef(text) {
    var m = REF_RE.exec(String(text).toUpperCase());
    if (!m) return null;
    return {
      col: colToIndex(m[2]),
      row: parseInt(m[4], 10) - 1,
      absCol: m[1] === '$',
      absRow: m[3] === '$',
    };
  }

  function refName(r) {
    return (r.absCol ? '$' : '') + indexToCol(r.col) + (r.absRow ? '$' : '') + (r.row + 1);
  }

  /** The plain "A1" key a cell is stored under, ignoring any $ anchors. */
  function key(col, row) { return indexToCol(col) + (row + 1); }
  function refKey(r) { return key(r.col, r.row); }

  /* ====================================================== tokenizer ====== */
  /* Each token keeps its own source text, because rewriting a formula after a
     row is inserted works by re-emitting the tokens: only the reference tokens
     change and everything else is handed back exactly as it was typed. */

  function tokenize(src) {
    var out = [];
    var i = 0;
    var s = String(src);

    while (i < s.length) {
      var c = s[i];

      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        out.push({ type: 'ws', text: c });
        i++;
        continue;
      }

      // String literal. Doubled quotes are an escaped quote, as in Excel.
      if (c === '"') {
        var j = i + 1;
        var val = '';
        while (j < s.length) {
          if (s[j] === '"') {
            if (s[j + 1] === '"') { val += '"'; j += 2; continue; }
            break;
          }
          val += s[j++];
        }
        out.push({ type: 'str', text: s.slice(i, j + 1), value: val });
        i = j + 1;
        continue;
      }

      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) {
        var num = /^[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?/.exec(s.slice(i))[0];
        out.push({ type: 'num', text: num, value: parseFloat(num) });
        i += num.length;
        continue;
      }

      // A reference, a range, a function name or a bare word.
      if (/[A-Za-z_$]/.test(c)) {
        var word = /^[A-Za-z_$][A-Za-z0-9_$.]*/.exec(s.slice(i))[0];
        var ref = parseRef(word);

        if (ref) {
          // A range only exists when a second reference follows the colon —
          // "A1:" on its own is a typo, not a range to half-guess at.
          var after = s.slice(i + word.length);
          var rangeM = /^:(\$?[A-Za-z]{1,3}\$?[0-9]{1,7})/.exec(after);
          if (rangeM && parseRef(rangeM[1])) {
            out.push({
              type: 'range',
              text: word + rangeM[0],
              a: ref,
              b: parseRef(rangeM[1]),
            });
            i += word.length + rangeM[0].length;
            continue;
          }
          out.push({ type: 'ref', text: word, ref: ref });
          i += word.length;
          continue;
        }

        var up = word.toUpperCase();
        if (up === 'TRUE' || up === 'FALSE') {
          out.push({ type: 'bool', text: word, value: up === 'TRUE' });
        } else {
          out.push({ type: 'name', text: word, value: up });
        }
        i += word.length;
        continue;
      }

      if (c === '#') {
        var found = null;
        for (var e = 0; e < ERRORS.length; e++) {
          if (s.slice(i, i + ERRORS[e].length).toUpperCase() === ERRORS[e]) { found = ERRORS[e]; break; }
        }
        if (found) {
          out.push({ type: 'err', text: s.slice(i, i + found.length), value: found });
          i += found.length;
          continue;
        }
      }

      var two = s.slice(i, i + 2);
      if (two === '<=' || two === '>=' || two === '<>') {
        out.push({ type: 'op', text: two, value: two });
        i += 2;
        continue;
      }

      if ('+-*/^&=<>%'.indexOf(c) !== -1) {
        out.push({ type: 'op', text: c, value: c });
        i++;
        continue;
      }
      if (c === '(') { out.push({ type: 'lparen', text: c }); i++; continue; }
      if (c === ')') { out.push({ type: 'rparen', text: c }); i++; continue; }
      if (c === ',' || c === ';') { out.push({ type: 'comma', text: c }); i++; continue; }

      out.push({ type: 'bad', text: c });
      i++;
    }
    return out;
  }

  /* ====================================================== parser ========= */
  /* Precedence climbing. The levels are Excel's, which matter: "&" binding
     looser than "+" is why ="Total: "&A1+B1 concatenates the sum rather than
     adding B1 to a string. */

  var BINARY = [
    ['=', '<>', '<', '>', '<=', '>='],
    ['&'],
    ['+', '-'],
    ['*', '/'],
    ['^'],
  ];

  function parse(src) {
    var toks = tokenize(src).filter(function (t) { return t.type !== 'ws'; });
    var pos = 0;

    function peek() { return toks[pos]; }
    function next() { return toks[pos++]; }

    function parseExpr(level) {
      if (level >= BINARY.length) return parseUnary();
      var left = parseExpr(level + 1);
      for (;;) {
        var t = peek();
        if (!t || t.type !== 'op' || BINARY[level].indexOf(t.value) === -1) return left;
        next();
        var right = parseExpr(level + 1);
        left = { t: 'bin', op: t.value, l: left, r: right };
      }
    }

    function parseUnary() {
      var t = peek();
      if (t && t.type === 'op' && (t.value === '-' || t.value === '+')) {
        next();
        return { t: 'un', op: t.value, x: parseUnary() };
      }
      return parsePostfix();
    }

    function parsePostfix() {
      var x = parsePrimary();
      for (;;) {
        var t = peek();
        if (t && t.type === 'op' && t.value === '%') { next(); x = { t: 'pct', x: x }; continue; }
        return x;
      }
    }

    function parsePrimary() {
      var t = next();
      if (!t) return { t: 'err', v: '#ERROR!' };

      if (t.type === 'num') return { t: 'num', v: t.value };
      if (t.type === 'str') return { t: 'str', v: t.value };
      if (t.type === 'bool') return { t: 'bool', v: t.value };
      if (t.type === 'err') return { t: 'err', v: t.value };
      if (t.type === 'ref') return { t: 'ref', ref: t.ref };
      if (t.type === 'range') return { t: 'range', a: t.a, b: t.b };

      if (t.type === 'lparen') {
        var inner = parseExpr(0);
        if (peek() && peek().type === 'rparen') next();
        return inner;
      }

      if (t.type === 'name') {
        if (peek() && peek().type === 'lparen') {
          next();
          var args = [];
          if (peek() && peek().type === 'rparen') { next(); return { t: 'call', name: t.value, args: args }; }
          for (;;) {
            args.push(parseExpr(0));
            var n = peek();
            if (n && n.type === 'comma') { next(); continue; }
            if (n && n.type === 'rparen') { next(); break; }
            break;
          }
          return { t: 'call', name: t.value, args: args };
        }
        // A bare word is not a named range here — saying so beats guessing.
        return { t: 'err', v: '#NAME?' };
      }

      return { t: 'err', v: '#ERROR!' };
    }

    var ast = parseExpr(0);
    return ast;
  }

  /* ====================================================== coercion ======= */

  function toNum(v) {
    if (isErr(v)) return v;
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return isFinite(v) ? v : err('#VALUE!');
    if (typeof v === 'boolean') return v ? 1 : 0;
    var cleaned = String(v).trim().replace(/[$,\s]/g, '');
    if (cleaned === '') return 0;
    var n = Number(cleaned);
    return isFinite(n) ? n : err('#VALUE!');
  }

  function toStr(v) {
    if (isErr(v)) return v;
    if (v == null) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return String(v);
  }

  function toBool(v) {
    if (isErr(v)) return v;
    if (typeof v === 'boolean') return v;
    if (v == null || v === '') return false;
    if (typeof v === 'number') return v !== 0;
    var s = String(v).toUpperCase();
    if (s === 'TRUE') return true;
    if (s === 'FALSE') return false;
    return !!s;
  }

  /** Numbers compare numerically; text compares case-insensitively, as Excel. */
  function compare(a, b) {
    if (a == null && b == null) return 0;
    if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
    if (typeof a === 'boolean' || typeof b === 'boolean') {
      var x = toNum(toBool(a) ? 1 : 0), y = toNum(toBool(b) ? 1 : 0);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    if (typeof a === 'number' && (b == null || b === '')) return a < 0 ? -1 : a > 0 ? 1 : 0;
    if (typeof b === 'number' && (a == null || a === '')) return b > 0 ? -1 : b < 0 ? 1 : 0;
    var sa = String(a == null ? '' : a).toUpperCase();
    var sb = String(b == null ? '' : b).toUpperCase();
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }

  /* ====================================================== functions ====== */
  /* A range argument contributes its cells; a scalar contributes itself. This
     is what lets SUM(A1:A9, 100, B2) work the way everyone expects. */

  function flatten(args) {
    var out = [];
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (a && a.rangeValues) out.push.apply(out, a.rangeValues);
      else out.push(a);
    }
    return out;
  }

  /** Numbers only. Text and blanks inside a range are ignored, errors are not. */
  function numbersIn(args) {
    var vals = flatten(args);
    var out = [];
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i];
      if (isErr(v)) return v;
      if (typeof v === 'number') out.push(v);
      else if (typeof v === 'boolean') out.push(v ? 1 : 0);
      else if (v != null && v !== '' && !isNaN(Number(String(v).replace(/[$,\s]/g, '')))) {
        out.push(Number(String(v).replace(/[$,\s]/g, '')));
      }
    }
    return out;
  }

  function firstErr(args) {
    var vals = flatten(args);
    for (var i = 0; i < vals.length; i++) if (isErr(vals[i])) return vals[i];
    return null;
  }

  /** Excel-style criteria: a bare value means equals, ">10" and "<>x" work. */
  function matches(value, criterion) {
    var c = criterion == null ? '' : criterion;
    if (typeof c === 'string') {
      var m = /^(<=|>=|<>|<|>|=)(.*)$/.exec(c.trim());
      if (m) {
        var op = m[1];
        var raw = m[2].trim();
        var target = raw === '' ? null : (isNaN(Number(raw)) ? raw : Number(raw));
        var cmp = compare(value, target);
        if (op === '=') return cmp === 0;
        if (op === '<>') return cmp !== 0;
        if (op === '<') return cmp < 0;
        if (op === '>') return cmp > 0;
        if (op === '<=') return cmp <= 0;
        if (op === '>=') return cmp >= 0;
      }
    }
    return compare(value, c) === 0;
  }

  var FUNCS = {
    SUM: function (a) { var n = numbersIn(a); if (isErr(n)) return n; return n.reduce(function (x, y) { return x + y; }, 0); },
    AVERAGE: function (a) { var n = numbersIn(a); if (isErr(n)) return n; return n.length ? n.reduce(function (x, y) { return x + y; }, 0) / n.length : err('#DIV/0!'); },
    MIN: function (a) { var n = numbersIn(a); if (isErr(n)) return n; return n.length ? Math.min.apply(null, n) : 0; },
    MAX: function (a) { var n = numbersIn(a); if (isErr(n)) return n; return n.length ? Math.max.apply(null, n) : 0; },
    COUNT: function (a) { var n = numbersIn(a); if (isErr(n)) return n; return n.length; },
    COUNTA: function (a) {
      return flatten(a).filter(function (v) { return v != null && v !== ''; }).length;
    },
    PRODUCT: function (a) { var n = numbersIn(a); if (isErr(n)) return n; return n.reduce(function (x, y) { return x * y; }, 1); },

    IF: function (a) {
      if (a.length < 2) return err('#VALUE!');
      var c = toBool(a[0]);
      if (isErr(c)) return c;
      return c ? a[1] : (a.length > 2 ? a[2] : false);
    },
    // IFERROR is the reason a broken reference does not cascade down a column.
    IFERROR: function (a) { return isErr(a[0]) ? (a.length > 1 ? a[1] : '') : a[0]; },
    AND: function (a) { var v = flatten(a); var e = firstErr(a); if (e) return e; return v.every(function (x) { return toBool(x) === true; }); },
    OR: function (a) { var v = flatten(a); var e = firstErr(a); if (e) return e; return v.some(function (x) { return toBool(x) === true; }); },
    NOT: function (a) { var b = toBool(a[0]); return isErr(b) ? b : !b; },

    ABS: function (a) { var n = toNum(a[0]); return isErr(n) ? n : Math.abs(n); },
    ROUND: function (a) {
      var n = toNum(a[0]); if (isErr(n)) return n;
      var d = a.length > 1 ? toNum(a[1]) : 0; if (isErr(d)) return d;
      var f = Math.pow(10, d);
      return Math.round((n * f + (n >= 0 ? 1e-9 : -1e-9))) / f;
    },
    ROUNDUP: function (a) {
      var n = toNum(a[0]); if (isErr(n)) return n;
      var d = a.length > 1 ? toNum(a[1]) : 0; var f = Math.pow(10, d);
      return (n >= 0 ? Math.ceil(n * f) : Math.floor(n * f)) / f;
    },
    ROUNDDOWN: function (a) {
      var n = toNum(a[0]); if (isErr(n)) return n;
      var d = a.length > 1 ? toNum(a[1]) : 0; var f = Math.pow(10, d);
      return (n >= 0 ? Math.floor(n * f) : Math.ceil(n * f)) / f;
    },
    SQRT: function (a) { var n = toNum(a[0]); if (isErr(n)) return n; return n < 0 ? err('#VALUE!') : Math.sqrt(n); },

    SUMIF: function (a, ctx) {
      var range = a[0] && a[0].rangeValues ? a[0].rangeValues : [a[0]];
      var sumRange = a.length > 2 && a[2] && a[2].rangeValues ? a[2].rangeValues : range;
      var total = 0;
      for (var i = 0; i < range.length; i++) {
        if (isErr(range[i])) return range[i];
        if (matches(range[i], a[1])) {
          var v = sumRange[i];
          if (isErr(v)) return v;
          if (typeof v === 'number') total += v;
          else { var n = toNum(v); if (!isErr(n)) total += n; }
        }
      }
      return total;
    },
    COUNTIF: function (a) {
      var range = a[0] && a[0].rangeValues ? a[0].rangeValues : [a[0]];
      var n = 0;
      for (var i = 0; i < range.length; i++) if (matches(range[i], a[1])) n++;
      return n;
    },

    CONCAT: function (a) {
      var v = flatten(a); var e = firstErr(a); if (e) return e;
      return v.map(function (x) { return toStr(x); }).join('');
    },
    LEN: function (a) { var s = toStr(a[0]); return isErr(s) ? s : s.length; },
    UPPER: function (a) { var s = toStr(a[0]); return isErr(s) ? s : s.toUpperCase(); },
    LOWER: function (a) { var s = toStr(a[0]); return isErr(s) ? s : s.toLowerCase(); },
    TRIM: function (a) { var s = toStr(a[0]); return isErr(s) ? s : s.trim(); },

    TODAY: function (a, ctx) { return ctx.today; },
    DAY: function (a, ctx) { return dayPart(a[0], ctx, 'day'); },
    MONTH: function (a, ctx) { return dayPart(a[0], ctx, 'month'); },
    YEAR: function (a, ctx) { return dayPart(a[0], ctx, 'year'); },

    /* The live half. The server hands over a flat namespace each load, so a
       cell holding =META("adSpend.monthToDate") re-reads Meta on every refresh
       rather than freezing whatever the figure was when it was typed. */
    META: function (a, ctx) {
      var path = toStr(a[0]);
      if (isErr(path)) return path;
      if (!ctx.meta || !Object.prototype.hasOwnProperty.call(ctx.meta, path)) return err('#NAME?');
      var v = ctx.meta[path];
      return typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? v : err('#VALUE!');
    },
  };
  FUNCS.CONCATENATE = FUNCS.CONCAT;

  function dayPart(v, ctx, part) {
    var s = toStr(v);
    if (isErr(s)) return s;
    var d = s ? new Date(s) : new Date(ctx.today);
    if (isNaN(d.getTime())) return err('#VALUE!');
    return part === 'day' ? d.getDate() : part === 'month' ? d.getMonth() + 1 : d.getFullYear();
  }

  /* ====================================================== evaluator ====== */

  function evalNode(node, ctx) {
    switch (node.t) {
      case 'num': return node.v;
      case 'str': return node.v;
      case 'bool': return node.v;
      case 'err': return err(node.v);

      case 'ref': return ctx.cell(refKey(node.ref));

      case 'range': {
        // A range only means anything inside a function call. Used bare, it is
        // reported rather than silently collapsed to its first cell.
        var vals = [];
        var r1 = Math.min(node.a.row, node.b.row), r2 = Math.max(node.a.row, node.b.row);
        var c1 = Math.min(node.a.col, node.b.col), c2 = Math.max(node.a.col, node.b.col);
        for (var r = r1; r <= r2; r++) for (var c = c1; c <= c2; c++) vals.push(ctx.cell(key(c, r)));
        return { rangeValues: vals };
      }

      case 'un': {
        var x = evalNode(node.x, ctx);
        if (x && x.rangeValues) return err('#VALUE!');
        var n = toNum(x);
        if (isErr(n)) return n;
        return node.op === '-' ? -n : n;
      }

      case 'pct': {
        var p = toNum(evalNode(node.x, ctx));
        return isErr(p) ? p : p / 100;
      }

      case 'call': {
        var fn = FUNCS[node.name];
        if (!fn) return err('#NAME?');
        var args = node.args.map(function (a) { return evalNode(a, ctx); });
        // IFERROR must see its arguments' errors rather than be short-circuited
        // by them, which is the whole point of it.
        if (node.name !== 'IFERROR' && node.name !== 'IF') {
          var e = firstErr(args);
          if (e && node.name !== 'COUNTIF') return e;
        }
        try { return fn(args, ctx); } catch (ex) { return err('#ERROR!'); }
      }

      case 'bin': {
        var l = evalNode(node.l, ctx);
        var r2v = evalNode(node.r, ctx);
        if (isErr(l)) return l;
        if (isErr(r2v)) return r2v;
        if ((l && l.rangeValues) || (r2v && r2v.rangeValues)) return err('#VALUE!');

        if (node.op === '&') {
          var ls = toStr(l), rs = toStr(r2v);
          if (isErr(ls)) return ls;
          if (isErr(rs)) return rs;
          return ls + rs;
        }
        if (['=', '<>', '<', '>', '<=', '>='].indexOf(node.op) !== -1) {
          var c = compare(l, r2v);
          switch (node.op) {
            case '=': return c === 0;
            case '<>': return c !== 0;
            case '<': return c < 0;
            case '>': return c > 0;
            case '<=': return c <= 0;
            default: return c >= 0;
          }
        }
        var a = toNum(l), b = toNum(r2v);
        if (isErr(a)) return a;
        if (isErr(b)) return b;
        switch (node.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/': return b === 0 ? err('#DIV/0!') : a / b;
          case '^': return Math.pow(a, b);
          default: return err('#ERROR!');
        }
      }

      default: return err('#ERROR!');
    }
  }

  /* ====================================================== the model ====== */

  function createModel(opts) {
    opts = opts || {};
    return {
      version: 0,
      rows: opts.rows || 60,
      cols: opts.cols || 8,
      cells: {},
      colWidths: {},
      updatedAt: null,
    };
  }

  /**
   * Turn what someone typed into what is stored.
   *
   * Typing "$1,200.00" means the number 1200 shown as currency, not the text
   * "$1,200.00" — otherwise every figure pasted from a bank statement lands as
   * text and quietly drops out of every SUM below it.
   */
  function parseInput(text) {
    var s = text == null ? '' : String(text);
    if (s === '') return null;
    if (s[0] === '=') return { f: s };

    var trimmed = s.trim();

    if (/^-?\$\s*[0-9,]*\.?[0-9]+$|^-?[0-9,]*\.?[0-9]+\s*\$$/.test(trimmed)) {
      return { v: Number(trimmed.replace(/[$,\s]/g, '')), fmt: 'currency' };
    }
    if (/^-?[0-9,]*\.?[0-9]+\s*%$/.test(trimmed)) {
      return { v: Number(trimmed.replace(/[%,\s]/g, '')) / 100, fmt: 'percent' };
    }
    if (/^-?[0-9]{1,3}(,[0-9]{3})+(\.[0-9]+)?$/.test(trimmed)) {
      return { v: Number(trimmed.replace(/,/g, '')) };
    }
    if (/^-?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?$/.test(trimmed) && trimmed !== '') {
      return { v: Number(trimmed) };
    }
    var up = trimmed.toUpperCase();
    if (up === 'TRUE' || up === 'FALSE') return { v: up === 'TRUE' };

    return { v: s };
  }

  function setCell(model, ref, text) {
    var parsed = parseInput(text);
    var existing = model.cells[ref];

    if (parsed === null) {
      // Clearing the content keeps the format: someone retyping a figure in a
      // currency column should not have to re-apply the format each time.
      if (existing && existing.fmt) model.cells[ref] = { fmt: existing.fmt };
      else delete model.cells[ref];
      return;
    }

    var cell = {};
    if (parsed.f != null) cell.f = parsed.f;
    else cell.v = parsed.v;
    var fmt = parsed.fmt || (existing && existing.fmt) || null;
    if (fmt) cell.fmt = fmt;
    model.cells[ref] = cell;
  }

  function setFormat(model, ref, fmt) {
    var cell = model.cells[ref] || {};
    if (fmt) cell.fmt = fmt; else delete cell.fmt;
    if (cell.f == null && cell.v === undefined && !cell.fmt) delete model.cells[ref];
    else model.cells[ref] = cell;
  }

  /**
   * Recalculate every cell.
   *
   * The whole sheet, every time. At this size that is well under a millisecond
   * and it makes a stale value structurally impossible — there is no
   * invalidation to get wrong. Cycles return #CYCLE! rather than hanging.
   */
  function recalc(model, meta, now) {
    var cache = {};
    var visiting = {};
    var parsedCache = {};
    var today = (now || new Date()).toISOString().slice(0, 10);

    var ctx = {
      meta: meta || {},
      today: today,
      cell: function (k) { return valueOf(k); },
    };

    function valueOf(k) {
      if (Object.prototype.hasOwnProperty.call(cache, k)) return cache[k];
      var cell = model.cells[k];
      if (!cell) return null;
      if (cell.f == null) return cell.v === undefined ? null : cell.v;

      if (visiting[k]) return err('#CYCLE!');
      visiting[k] = true;
      var ast = parsedCache[cell.f] || (parsedCache[cell.f] = parse(cell.f.slice(1)));
      var out;
      try { out = evalNode(ast, ctx); } catch (e) { out = err('#ERROR!'); }
      if (out && out.rangeValues) out = err('#VALUE!');
      delete visiting[k];
      cache[k] = out;
      return out;
    }

    var values = {};
    for (var k in model.cells) if (Object.prototype.hasOwnProperty.call(model.cells, k)) values[k] = valueOf(k);
    return values;
  }

  /* ================================================ structural edits ===== */
  /*
   * Inserting a row has to move the CELLS and rewrite the FORMULAS, and both
   * halves are easy to half-do. A sheet where =SUM(C4:C20) still points at C4
   * after a row was inserted above it is worse than one that refuses to insert
   * rows at all, because the total keeps looking plausible.
   */

  /**
   * Move one axis of a RANGE when a row or column is deleted.
   *
   * A range is not two independent references. Deleting a column inside
   * =SUM(A1:D1) should leave =SUM(A1:C1) — the range shrinks. Treating each
   * endpoint on its own turns that into #REF! the moment either end happens to
   * be the deleted line, which is why this is separate from the single-ref
   * rule. Only a range whose every line is deleted becomes #REF!.
   *
   * The start moves when it is PAST the deleted line; the end moves when it is
   * past OR ON it. That asymmetry is the whole thing: it is what shrinks a
   * range by one instead of sliding it.
   */
  function deleteAxis(aVal, bVal, at) {
    var aFirst = aVal <= bVal;
    var start = aFirst ? aVal : bVal;
    var end = aFirst ? bVal : aVal;
    var s2 = start > at ? start - 1 : start;
    var e2 = end >= at ? end - 1 : end;
    if (e2 < s2) return null;                    // every line of it was deleted
    return aFirst ? [s2, e2] : [e2, s2];
  }

  /** Inserting cannot collapse a range; a range spanning the point grows. */
  function insertAxis(aVal, bVal, at) {
    return [aVal >= at ? aVal + 1 : aVal, bVal >= at ? bVal + 1 : bVal];
  }

  function shiftRefInFormula(formulaText, shifters) {
    var toks = tokenize(formulaText);
    var out = '';
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (t.type === 'ref') {
        var moved = shifters.ref(t.ref);
        out += moved === null ? '#REF!' : refName(moved);
      } else if (t.type === 'range') {
        var pair = shifters.range
          ? shifters.range(t.a, t.b)
          : (function () {
              var a = shifters.ref(t.a), b = shifters.ref(t.b);
              return a === null || b === null ? null : [a, b];
            })();
        out += pair === null ? '#REF!' : refName(pair[0]) + ':' + refName(pair[1]);
      } else {
        out += t.text;
      }
    }
    return out;
  }

  function rewriteAll(model, shifters) {
    var cells = {};
    for (var k in model.cells) {
      if (!Object.prototype.hasOwnProperty.call(model.cells, k)) continue;
      var here = parseRef(k);
      var moved = shifters.ref(here);
      if (moved === null) continue;                     // this cell was deleted
      var cell = model.cells[k];
      var copy = {};
      if (cell.f != null) copy.f = '=' + shiftRefInFormula(cell.f.slice(1), shifters);
      else if (cell.v !== undefined) copy.v = cell.v;
      if (cell.fmt) copy.fmt = cell.fmt;
      cells[refKey(moved)] = copy;
    }
    model.cells = cells;
  }

  function withRow(r, row) { return { col: r.col, row: row, absCol: r.absCol, absRow: r.absRow }; }
  function withCol(r, col) { return { col: col, row: r.row, absCol: r.absCol, absRow: r.absRow }; }

  function insertRow(model, at) {
    rewriteAll(model, {
      ref: function (r) { return r.row >= at ? withRow(r, r.row + 1) : r; },
      range: function (a, b) {
        var p = insertAxis(a.row, b.row, at);
        return [withRow(a, p[0]), withRow(b, p[1])];
      },
    });
    model.rows += 1;
  }

  function deleteRow(model, at) {
    rewriteAll(model, {
      ref: function (r) {
        if (r.row === at) return null;                  // gone: becomes #REF!
        return r.row > at ? withRow(r, r.row - 1) : r;
      },
      range: function (a, b) {
        var p = deleteAxis(a.row, b.row, at);
        return p === null ? null : [withRow(a, p[0]), withRow(b, p[1])];
      },
    });
    model.rows = Math.max(1, model.rows - 1);
  }

  function insertCol(model, at) {
    rewriteAll(model, {
      ref: function (r) { return r.col >= at ? withCol(r, r.col + 1) : r; },
      range: function (a, b) {
        var p = insertAxis(a.col, b.col, at);
        return [withCol(a, p[0]), withCol(b, p[1])];
      },
    });
    model.cols += 1;
  }

  function deleteCol(model, at) {
    rewriteAll(model, {
      ref: function (r) {
        if (r.col === at) return null;
        return r.col > at ? withCol(r, r.col - 1) : r;
      },
      range: function (a, b) {
        var p = deleteAxis(a.col, b.col, at);
        return p === null ? null : [withCol(a, p[0]), withCol(b, p[1])];
      },
    });
    model.cols = Math.max(1, model.cols - 1);
  }

  /**
   * Offset a formula for copy and paste.
   *
   * Relative references move with the cell; anchored ones ($A$1) do not. That
   * distinction is the only reason $ exists, so it is honoured per-axis.
   */
  function offsetFormula(formulaText, dCol, dRow) {
    // No range rule: a copied range moves as two ordinary references, which is
    // exactly right — copying never deletes a line, so nothing can collapse.
    return shiftRefInFormula(formulaText, {
      ref: function (r) {
        return {
          col: r.absCol ? r.col : r.col + dCol,
          row: r.absRow ? r.row : r.row + dRow,
          absCol: r.absCol,
          absRow: r.absRow,
        };
      },
    });
  }

  /* ====================================================== formatting ===== */

  function format(value, fmt) {
    if (isErr(value)) return value.err;
    if (value == null || value === '') return '';
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';

    if (typeof value !== 'number') return String(value);

    switch (fmt) {
      case 'currency':
        return (value < 0 ? '-' : '') + '$' + Math.abs(value).toLocaleString('en-US',
          { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      case 'percent':
        return (value * 100).toLocaleString('en-US',
          { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
      case 'number':
        return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      case 'integer':
        return Math.round(value).toLocaleString('en-US');
      case 'text':
        return String(value);
      default:
        // Unformatted numbers still get thousands separators, but keep every
        // decimal they actually have rather than being rounded on screen.
        return value.toLocaleString('en-US', { maximumFractionDigits: 10 });
    }
  }

  /** What goes in the editor when a cell is opened: the source, not the result. */
  function editText(model, ref) {
    var cell = model.cells[ref];
    if (!cell) return '';
    if (cell.f != null) return cell.f;
    if (cell.v === undefined || cell.v === null) return '';
    if (typeof cell.v === 'boolean') return cell.v ? 'TRUE' : 'FALSE';
    return String(cell.v);
  }

  /* ====================================================== clipboard ====== */

  /** Parse what a spreadsheet puts on the clipboard: tab and newline separated. */
  function fromTSV(text) {
    var rows = String(text).replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
    return rows.map(function (r) { return r.split('\t'); });
  }

  function toTSV(grid) {
    return grid.map(function (row) { return row.join('\t'); }).join('\n');
  }

  /** CSV, so the ledger can still reach an accountant who wants a real file. */
  function toCSV(model, values) {
    var lines = [];
    for (var r = 0; r < model.rows; r++) {
      var row = [];
      var any = false;
      for (var c = 0; c < model.cols; c++) {
        var k = key(c, r);
        var cell = model.cells[k];
        var v = values ? values[k] : (cell ? cell.v : null);
        var text = isErr(v) ? v.err : (v == null ? '' : String(v));
        if (text !== '') any = true;
        row.push(/[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text);
      }
      // Trailing empty rows are noise in a file someone opens in Excel.
      if (any || r < model.rows - 1) lines.push(row.join(','));
    }
    while (lines.length && /^,*$/.test(lines[lines.length - 1])) lines.pop();
    return lines.join('\n');
  }

  /* ====================================================== exports ======== */

  var Sheet = {
    // references
    colToIndex: colToIndex,
    indexToCol: indexToCol,
    parseRef: parseRef,
    refName: refName,
    key: key,
    // formulas
    tokenize: tokenize,
    parse: parse,
    // model
    createModel: createModel,
    parseInput: parseInput,
    setCell: setCell,
    setFormat: setFormat,
    recalc: recalc,
    editText: editText,
    // structure
    insertRow: insertRow,
    deleteRow: deleteRow,
    insertCol: insertCol,
    deleteCol: deleteCol,
    offsetFormula: offsetFormula,
    // presentation
    format: format,
    isErr: isErr,
    // interchange
    fromTSV: fromTSV,
    toTSV: toTSV,
    toCSV: toCSV,
    // introspection, for the function help in the toolbar
    functionNames: Object.keys(FUNCS).sort(),
  };

  global.Sheet = Sheet;
  if (typeof module !== 'undefined' && module.exports) module.exports = Sheet;
})(typeof globalThis !== 'undefined' ? globalThis : this);
