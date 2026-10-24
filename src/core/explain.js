// Plain-English explanation of a statement, built from the block model.
// Output text uses `backticks` for SQL names and “curly quotes” for literal values; the UI
// turns backticks into <code>. Nothing here is free-form AI: every sentence comes from a
// rule, so the same query always gets the same explanation.
import { conjuncts, hasAggregate, hasWindow, isAggregate, columnRefs } from './parse.js';
import { looksDate, dateUnitOf } from './model.js';
import { words, plural, normKey, entityNoun } from 'any-schema/src/core/model.js';

const MAX_DEPTH = 3;

export function explainStatement(st, m, index = 0, sql = '') {
  const sp = new Speaker(m);
  sp.fullSql = sql;
  const out = { index, kind: st.type, title: '', summary: [], grain: null, steps: [], outputs: [], tables: [], target: m.target };
  if (!m.main) {
    out.title = sp.title(st);
    out.tables = sp.tables();
    if (st.type === 'insert' && st.values) {
      const cols = st.columns ? ` (${sp.list(st.columns.map((c) => sp.code(c)))})` : '';
      out.summary.push(`Adds ${st.values.rows.length} row${st.values.rows.length === 1 ? '' : 's'} of fixed values to ${sp.code(m.target.name)}${cols}.`);
      if (st.conflict) out.summary.push(`If a row already exists, it follows the rule ${sp.code(st.conflict.replace(/\s+/g, ' ').slice(0, 90))}.`);
      if (st.returning) out.summary.push('It returns the inserted rows (RETURNING).');
    } else out.summary.push(`${sp.title(st)}.`);
    return out;
  }
  out.steps = sp.steps();
  out.tables = sp.tables();
  const mainBlock = m.main;
  out.outputs = (m.stmt.type === 'query' || m.stmt.type === 'create' || m.stmt.type === 'insert') ? sp.outputs(mainBlock) : [];
  out.grain = mainBlock.dml ? null : sp.grainText(mainBlock);
  out.summary = sp.summary(st, mainBlock, out);
  out.title = sp.title(st);
  return out;
}

export class Speaker {
  constructor(m) {
    this.m = m;
    this.stepOf = new Map();
  }

  // ---------- small helpers ----------
  list(items, conj = 'and') {
    const a = items.filter(Boolean);
    if (a.length <= 1) return a[0] || '';
    if (a.length === 2) return `${a[0]} ${conj} ${a[1]}`;
    return `${a.slice(0, -1).join(', ')} ${conj} ${a[a.length - 1]}`;
  }
  code(s) { return `\`${String(s).replace(/`/g, "'")}\``; }
  q(v) { return `“${String(v).length > 60 ? String(v).slice(0, 57) + '…' : v}”`; }
  sql(node) { return node && node.s != null ? this.m.stmt && this.srcText(node) : ''; }
  srcText(node) { return this.fullSql ? this.fullSql.slice(node.s, node.e) : ''; }
  wid(name) { return words(name).replace(/\bid\b/g, 'ID').replace(/\bids\b/g, 'IDs').replace(/\buuid\b/g, 'UUID') || String(name); }
  plural(noun) { if (!noun) return 'rows'; const p = noun.split(' '); p[p.length - 1] = plural(p[p.length - 1]); return p.join(' ').replace(/\bIDs?s\b/, 'IDs'); }
  cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
  stepName(b) { const n = this.stepOf.get(b); return n ? `step ${n}` : null; }
  /** "orders" for a plain query; "rows" once joins have changed what a row is. */
  rowWord(b) {
    const ent = this.grainEntity(b) || 'row';
    const base = b.sources && b.sources[0] ? b.sources[0].entity : ent;
    return ent === base ? this.plural(ent) : 'rows';
  }

  // ---------- column phrases ----------
  col(e, b, depth = 0) {
    const r = this.m.resolve(b, e) || {};
    const name = e.parts[e.parts.length - 1];
    if (r.variable) return this.code(r.name);
    if (r.outputAlias) {
      if (r.output && r.output.expr && r.output.expr.type !== 'col' && depth < MAX_DEPTH) return this.say(r.output.expr, b, depth + 1);
      return this.code(name);
    }
    const s = r.source;
    if (s && (s.kind === 'cte' || s.kind === 'derived') && depth > 0) {
      const inner = s.kind === 'cte' ? s.cteBlock : s.inner;
      const o = inner && inner.outputs && inner.outputs.find((x) => x.name.toLowerCase() === String(r.column).toLowerCase());
      if (o && o.expr && !o.star && o.expr.type !== 'col') return this.code(o.name);
    }
    if (s && (s.kind === 'cte' || s.kind === 'derived') && depth === 0) {
      const inner = s.kind === 'cte' ? s.cteBlock : s.inner;
      const o = inner && inner.outputs && inner.outputs.find((x) => x.name.toLowerCase() === String(r.column).toLowerCase());
      if (o && o.expr && !o.star && inner.select) {
        this.borrowing = (this.borrowing || 0) + 1;
        try {
          if (o.expr.type === 'col') return this.col(o.expr, inner, depth + 1);
          return this.say(o.expr, inner, depth + 1);
        } finally { this.borrowing--; }
      }
    }
    if (s) return this.entCol(s, r.column || name, b, depth);
    if (r.pseudo) return /rownum/i.test(name) ? 'the row number (ROWNUM)' : this.code(name);
    return this.wid(name);
  }

  entCol(s, colName, b, depth = 0) {
    const w = this.wid(colName);
    const ent = s.entity || 'row';
    const single = !this.borrowing && b && s.block === b && b.sources && b.sources.length === 1;
    void depth;
    if (normKey(colName) === 'id') return `${ent} ID`;
    if (single) return w;
    const entWords = ent.toLowerCase();
    if (w.toLowerCase().startsWith(entWords + ' ') || w.toLowerCase() === entWords) return w;
    // ENC.ENC_TYPE_CD -> "encounter type code" (prefix already names the entity)
    const firstWord = String(colName).split(/[_\s]/)[0].toLowerCase();
    if (s.kind === 'table' && s.parts && normKey(s.parts[s.parts.length - 1]) === normKey(firstWord)) return w;
    return `${ent} ${w}`;
  }

  // ---------- values ----------
  say(e, b, depth = 0) {
    if (!e) return '';
    if (depth > 6) return this.code(this.srcText(e) || '…');
    switch (e.type) {
      case 'lit':
        if (e.kind === 'string') return this.q(e.value);
        if (e.kind === 'null') return 'empty (NULL)';
        if (e.kind === 'bool') return e.value ? 'true' : 'false';
        if (e.kind === 'date' || e.kind === 'timestamp') return this.q(e.value);
        return String(e.raw);
      case 'param':
        if (/^@@ROWCOUNT$/i.test(e.raw)) return 'the number of rows the last statement changed';
        if (/^@@(IDENTITY)$/i.test(e.raw)) return 'the ID generated by the last INSERT';
        if (/^@@ERROR$/i.test(e.raw)) return 'the error number of the last statement';
        if (/^@/.test(e.raw)) return this.code(e.raw);
        return `the parameter ${this.code(e.raw)}`;
      case 'col': return this.col(e, b, depth);
      case 'star': return 'all columns';
      case 'func': return this.func(e, b, depth);
      case 'cast': {
        if (/^date\s*$/i.test(String(e.to).trim())) return `the date of ${this.say(e.expr, b, depth + 1)}`;
        return `${this.say(e.expr, b, depth + 1)} as ${String(e.to).toLowerCase()}`;
      }
      case 'bin': { const t = this.binValue(e, b, depth); return e.paren && depth > 0 && ['+', '-', '*', '/'].includes(e.op) ? `(${t})` : t; }
      case 'neg': return e.op === '-' ? `minus ${this.say(e.expr, b, depth + 1)}` : this.say(e.expr, b, depth + 1);
      case 'case': return this.caseValue(e, b, depth);
      case 'interval': return this.interval(e, b, depth);
      case 'tuple': return `(${e.items.map((x) => this.say(x, b, depth + 1)).join(', ')})`;
      case 'subquery': return this.scalarSub(e, b, depth);
      case 'raw': return this.code(String(e.text).slice(0, 60));
      case 'typename': return e.name;
      default: return this.cond(e, b, depth);
    }
  }

  interval(e, b, depth) {
    if (e.value != null) {
      const v = String(e.value).trim();
      const m = /^(-?\d+(?:\.\d+)?)\s*([a-z]+)?/i.exec(v);
      let n = m ? m[1] : v;
      let unit = (m && m[2]) || e.unit || 'day';
      unit = unit.toLowerCase().replace(/s$/, '');
      if (/^(mon|mons)$/.test(unit)) unit = 'month';
      if (/^(min|mins)$/.test(unit)) unit = 'minute';
      if (/^(hr|hrs|h)$/.test(unit)) unit = 'hour';
      if (/^(d)$/.test(unit)) unit = 'day';
      const num = Math.abs(Number(n));
      if (!Number.isNaN(num)) n = String(num);
      return `${n} ${num === 1 ? unit : unit + 's'}`;
    }
    if (e.expr) return `${this.say(e.expr, b, depth + 1)} ${(e.unit || 'day').toLowerCase()}s`;
    return 'an interval';
  }

  /** "now", "today", "30 days ago", "the start of this month" - or null. */
  relativeDate(e, b, depth) {
    if (!e) return null;
    if (e.type === 'func') {
      const n = e.name;
      if (/^(NOW|CURRENT_TIMESTAMP|SYSDATE|SYSTIMESTAMP|GETDATE|GETUTCDATE|SYSDATETIME|LOCALTIMESTAMP|SYSUTCDATETIME|UTC_TIMESTAMP)$/.test(n)) return 'now';
      if (/^(CURRENT_DATE|CURDATE|TODAY)$/.test(n)) return 'today';
      if (n === 'TRUNC' && e.args.length === 1 && this.relativeDate(e.args[0], b, depth) === 'now') return 'today';
      if (n === 'DATE' && e.args.length === 1 && this.relativeDate(e.args[0], b, depth)) return 'today';
      if ((n === 'DATE_TRUNC' || n === 'TRUNC' || n === 'DATETRUNC') && e.args.length === 2) {
        const unit = dateUnitOf(e);
        const base = this.relativeDate(n === 'TRUNC' ? e.args[0] : e.args[1], b, depth);
        if (unit && (base === 'now' || base === 'today')) return unit === 'day' ? 'today' : `the start of this ${unit}`;
      }
      if (n === 'DATEADD' && e.args.length === 3) {
        const unitArg = e.args[0];
        const unit = String(unitArg.type === 'col' ? unitArg.parts[0] : unitArg.value || '').toLowerCase().replace(/^(dd|d)$/, 'day').replace(/^(mm|m)$/, 'month').replace(/^(yy|yyyy)$/, 'year').replace(/^(wk|ww)$/, 'week').replace(/^(hh)$/, 'hour').replace(/s$/, '').replace(/^(dd|d)$/, 'day').replace(/^(mm|m)$/, 'month').replace(/^(yy|yyyy)$/, 'year').replace(/^(wk|ww)$/, 'week').replace(/^(hh)$/, 'hour').replace(/s$/, '');
        const amt = e.args[1];
        const base = this.relativeDate(e.args[2], b, depth);
        if (base && amt.type === 'lit' && amt.kind === 'number') return this.shift(base, amt.value, unit);
        if (base && amt.type === 'neg') return this.shiftText(base, `${this.say(amt.expr, b, depth + 1)} ${unit}s`, -1);
        if (base && (amt.type === 'param' || amt.type === 'col')) return this.shiftText(base, `${this.say(amt, b, depth + 1)} ${unit}s`, 1);
      }
      if ((n === 'DATE_SUB' || n === 'DATE_ADD' || n === 'SUBDATE' || n === 'ADDDATE') && e.args.length === 2) {
        const base = this.relativeDate(e.args[0], b, depth);
        const iv = e.args[1];
        if (base && iv.type === 'interval') {
          const num = Number(iv.value != null ? iv.value : iv.expr && iv.expr.value);
          if (!Number.isNaN(num)) return this.shift(base, /SUB/.test(n) ? -num : num, (iv.unit || 'day').toLowerCase());
        }
        if (base && iv.type === 'lit' && iv.kind === 'number') return this.shift(base, /SUB/.test(n) ? -iv.value : iv.value, 'day');
      }
      if (n === 'ADD_MONTHS' && e.args.length === 2) {
        const base = this.relativeDate(e.args[0], b, depth);
        if (base && e.args[1].type === 'lit') return this.shift(base, e.args[1].value, 'month');
      }
    }
    if (e.type === 'cast' && /^date/i.test(e.to)) { const base = this.relativeDate(e.expr, b, depth); if (base) return 'today'; }
    if (e.type === 'bin' && (e.op === '-' || e.op === '+')) {
      const base = this.relativeDate(e.left, b, depth);
      if (base && (base === 'now' || base === 'today' || /^the start of/.test(base))) {
        const sign = e.op === '-' ? -1 : 1;
        if (e.right.type === 'interval') {
          const txt = this.interval(e.right, b, depth);
          const neg = e.right.value != null && /^\s*-/.test(String(e.right.value));
          return this.shiftText(base, txt, (neg ? -1 : 1) * sign);
        }
        if (e.right.type === 'lit' && e.right.kind === 'number') return this.shift(base, sign * e.right.value, 'day');
      }
    }
    return null;
  }
  shift(base, amount, unit) {
    const n = Math.abs(Number(amount));
    const u = String(unit || 'day').toLowerCase().replace(/s$/, '');
    return this.shiftText(base, `${n} ${n === 1 ? u : u + 's'}`, Number(amount) < 0 ? -1 : 1);
  }
  shiftText(base, txt, sign) {
    if (base === 'today' && txt === '1 day') return sign < 0 ? 'yesterday' : 'tomorrow';
    if (base === 'now' || base === 'today') return sign < 0 ? `${txt} ago` : `${txt} from now`;
    return sign < 0 ? `${txt} before ${base}` : `${txt} after ${base}`;
  }

  binValue(e, b, depth) {
    const rel = this.relativeDate(e, b, depth);
    if (rel) return rel;
    const L = () => this.say(e.left, b, depth + 1);
    const R = () => this.say(e.right, b, depth + 1);
    switch (e.op) {
      case '+': return `${L()} plus ${R()}`;
      case '-':
        if (looksDate(e.left) && looksDate(e.right)) return `the time between ${R()} and ${L()}`;
        return `${L()} minus ${R()}`;
      case '*': return `${L()} times ${R()}`;
      case '/': return `${L()} divided by ${R()}`;
      case 'DIV': return `${L()} divided by ${R()} (whole number)`;
      case '%': return `the remainder of ${L()} divided by ${R()}`;
      case '||': {
        const parts = flattenConcat(e).filter((p) => !(p.type === 'lit' && p.kind === 'string' && /^[\s,;:/|-]*$/.test(p.value)));
        if (parts.length === 1) return flattenConcat(e).every((p) => p === parts[0] || (p.type === 'lit' && p.value === '')) ? this.say(parts[0], b, depth + 1) : `${this.say(parts[0], b, depth + 1)} with text added`;
        return `${this.list(parts.map((p) => this.say(p, b, depth + 1)))} joined together`;
      }
      case '->': case '->>': case '#>': case '#>>': return `the ${this.say(e.right, b, depth + 1)} field of ${L()}`;
      default: return this.cond(e, b, depth);
    }
  }

  caseValue(e, b, depth) {
    const parts = e.whens.map((w) => {
      const when = e.operand ? { type: 'bin', op: '=', left: e.operand, right: w.when, s: w.when.s, e: w.when.e } : w.when;
      return `${this.say(w.then, b, depth + 1)} when ${this.cond(when, b, depth + 1)}`;
    });
    if (parts.length > 4) {
      const cols = [...new Set(e.whens.flatMap((w) => columnRefs(w.when)).concat(e.operand ? columnRefs(e.operand) : []).map((c) => this.col(c, b, depth + 1)))];
      return `one of ${e.whens.length + (e.else ? 1 : 0)} values depending on ${this.list(cols.slice(0, 3)) || 'conditions'}`;
    }
    const otherwise = e.else ? `, otherwise ${this.say(e.else, b, depth + 1)}` : ', otherwise empty';
    return `${parts.join('; ')}${otherwise}`;
  }

  // ---------- functions ----------
  countNoun(b) {
    const ent = this.m.blockEntity && b && b.select ? this.grainEntity(b) : null;
    return ent || 'row';
  }
  grainEntity(b) {
    let ent = b.sources[0] ? b.sources[0].entity : null;
    for (const s of b.sources.slice(1)) {
      const j = this.m.joinInfo(b, s);
      if (j.card === '1:N' || j.card === 'N:N' || j.card === 'cross') ent = s.entity;
    }
    return ent;
  }

  func(e, b, depth) {
    const a = e.args;
    const A = (i) => this.say(a[i], b, depth + 1);
    const n = e.name;
    if (e.over) return this.windowFn(e, b, depth);
    const filter = e.filter ? ` where ${this.cond(e.filter, b, depth + 1)}` : '';
    switch (n) {
      case 'COUNT': case 'COUNT_BIG': case 'APPROX_COUNT_DISTINCT': case 'COUNTIF': {
        const noun = this.countNoun(b);
        if (n === 'COUNTIF') return `the number of ${this.plural(noun)} where ${this.cond(a[0], b, depth + 1)}`;
        if (!a.length || a[0].type === 'star' || (a[0].type === 'lit' && a[0].kind !== 'null')) return `the number of ${this.plural(noun)}${filter}`;
        if ((e.distinct || n === 'APPROX_COUNT_DISTINCT') && a[0].type === 'col') {
          const r = this.m.resolve(b, a[0]) || {};
          if (r.source && this.m.isKey(r.source, [r.column])) return `the number of different ${this.plural(r.source.entity)}${filter}`;
          const g = this.m.groupNoun(b, a[0]);
          if (g && g.entity) return `the number of different ${this.plural(g.noun)}${filter}`;
        }
        if (e.distinct || n === 'APPROX_COUNT_DISTINCT') return `the number of different ${this.plural(this.say(a[0], b, depth + 1))}${filter}`;
        if (a[0].type === 'col') {
          const r = this.m.resolve(b, a[0]) || {};
          if (r.source && this.m.isKey(r.source, [r.column])) return `the number of ${this.plural(r.source.entity)}${filter}`;
        }
        return `the number of ${this.plural(noun)} that have a ${A(0)}${filter}`;
      }
      case 'SUM': {
        const cs = a[0] && a[0].type === 'case' ? sumCase(a[0]) : null;
        if (cs && cs.count) return `the number of ${this.plural(this.countNoun(b))} where ${this.cond(cs.cond, b, depth + 1)}`;
        if (cs && cs.value) return `the sum of ${this.say(cs.value, b, depth + 1)} where ${this.cond(cs.cond, b, depth + 1)}`;
        return `the sum of ${e.distinct ? 'the different values of ' : ''}${A(0)}${filter}`;
      }
      case 'AVG': return `the average ${A(0)}${filter}`;
      case 'MIN': case 'MAX': {
        const isMax = n === 'MAX';
        if (looksDate(a[0])) return `the ${isMax ? 'latest' : 'earliest'} ${A(0)}${filter}`;
        const cat = a[0] && a[0].type === 'col' ? ((this.m.resolve(b, a[0]) || {}).catalogColumn || {}).category : null;
        if (cat === 'string' || cat === 'text' || (!cat && a[0] && a[0].type === 'col' && /(name|subject|title|code|cd|desc|description|text|label|email|status)$/i.test(a[0].parts[a[0].parts.length - 1]))) return `the alphabetically ${isMax ? 'last' : 'first'} ${A(0)}${filter}`;
        return `the ${isMax ? 'highest' : 'lowest'} ${A(0)}${filter}`;
      }
      case 'MEDIAN': return `the median ${A(0)}`;
      case 'STDDEV': case 'STDDEV_SAMP': case 'STDDEV_POP': case 'STDEV': case 'STDEVP': return `how spread out ${A(0)} is (standard deviation)`;
      case 'PERCENTILE_CONT': case 'PERCENTILE_DISC': {
        const p = a[0] && a[0].type === 'lit' ? Number(a[0].value) : null;
        const of = e.orderBy && e.orderBy[0] ? this.say(e.orderBy[0].expr, b, depth + 1) : 'the values';
        return p === 0.5 ? `the median ${of}` : `the ${p != null ? Math.round(p * 100) + 'th percentile' : 'percentile'} of ${of}`;
      }
      case 'STRING_AGG': case 'LISTAGG': case 'GROUP_CONCAT': case 'ARRAY_AGG': case 'JSON_AGG': case 'JSONB_AGG': case 'COLLECT':
        return `a list of ${e.distinct ? 'the different ' : 'all '}${this.plural(A(0))}${e.orderBy ? `, ordered by ${this.say(e.orderBy[0].expr, b, depth + 1)}` : ''}`;
      case 'BOOL_OR': return `whether any ${A(0)}`;
      case 'BOOL_AND': case 'EVERY': return `whether every ${A(0)}`;
      case 'ANY_VALUE': case 'ARBITRARY': return `any one ${A(0)} from the group`;
      case 'COALESCE': case 'NVL': case 'IFNULL': case 'ISNULL': case 'ZEROIFNULL':
        if (n === 'ZEROIFNULL') return `${A(0)}, or 0 when it is empty`;
        if (a.length === 2) return `${A(0)}, or ${A(1)} when it is empty`;
        return `the first filled-in value of ${this.list(a.map((_, i) => A(i)), 'or')}`;
      case 'NVL2': return `${A(1)} when ${A(0)} has a value, otherwise ${A(2)}`;
      case 'NULLIF': return `${A(0)} (empty when it equals ${A(1)})`;
      case 'NULLIFZERO': return `${A(0)} (empty when it is 0)`;
      case 'UPPER': case 'UCASE': return `${A(0)} in upper case`;
      case 'LOWER': case 'LCASE': return `${A(0)} in lower case`;
      case 'INITCAP': return `${A(0)} with each word capitalised`;
      case 'TRIM': case 'BTRIM': return `${A(a.length - 1)} without surrounding spaces`;
      case 'LTRIM': return `${A(0)} without leading spaces`;
      case 'RTRIM': return `${A(0)} without trailing spaces`;
      case 'LENGTH': case 'LEN': case 'CHAR_LENGTH': case 'CHARACTER_LENGTH': case 'LENGTHB': return `the length of ${A(0)}`;
      case 'LEFT': return `the first ${A(1)} characters of ${A(0)}`;
      case 'RIGHT': return `the last ${A(1)} characters of ${A(0)}`;
      case 'SUBSTR': case 'SUBSTRING': case 'MID': {
        // SUBSTRING(x, 1, POSITION('/' IN x) - 1) -> the part of x before the first "/"
        const pos = (e2) => { const f = e2 && e2.type === 'bin' && (e2.op === '-' || e2.op === '+') && e2.right.type === 'lit' ? e2.left : e2; return f && f.type === 'func' && ['POSITION', 'STRPOS', 'INSTR', 'CHARINDEX', 'LOCATE'].includes(f.name) ? f : null; };
        const needle = (f) => (['POSITION', 'CHARINDEX', 'LOCATE'].includes(f.name) ? f.args[0] : f.args[1]);
        if (a.length >= 3 && a[1].type === 'lit' && [0, 1].includes(Number(a[1].value)) && pos(a[2])) return `the part of ${A(0)} before the first ${this.say(needle(pos(a[2])), b, depth + 1)}`;
        if (a.length === 2 && pos(a[1])) return `the part of ${A(0)} after the first ${this.say(needle(pos(a[1])), b, depth + 1)}`;
      }
        if (a.length >= 3) return a[1].type === 'lit' && Number(a[1].value) === 1 ? `the first ${A(2)} characters of ${A(0)}` : `${A(2)} characters of ${A(0)}, starting at position ${A(1)}`;
        return `${A(0)} from position ${A(1)} on`;
      case 'CONCAT': case 'CONCAT_WS': {
        const parts = (n === 'CONCAT_WS' ? a.slice(1) : a).filter((p) => !(p.type === 'lit' && p.kind === 'string' && /^[\s,;:/|-]*$/.test(p.value)));
        return `${this.list(parts.map((p) => this.say(p, b, depth + 1)))} joined together`;
      }
      case 'REPLACE': return `${A(0)} with ${A(1)} replaced by ${A(2) || 'nothing'}`;
      case 'REGEXP_REPLACE': return `${A(0)} with text matching ${A(1)} replaced`;
      case 'REGEXP_SUBSTR': case 'REGEXP_EXTRACT': return `the part of ${A(0)} matching ${A(1)}`;
      case 'SPLIT_PART': return `part ${A(2)} of ${A(0)} split on ${A(1)}`;
      case 'ROUND': return a.length > 1 && !(a[1].type === 'lit' && Number(a[1].value) === 0) ? `${A(0)}, rounded to ${A(1)} decimal place${Number(a[1].value) === 1 ? '' : 's'}` : `${A(0)}, rounded to a whole number`;
      case 'TRUNC': case 'TRUNCATE': case 'DATE_TRUNC': case 'DATETRUNC': case 'TIMESTAMP_TRUNC': case 'DATETIME_TRUNC': {
        const rel = this.relativeDate(e, b, depth);
        if (rel) return rel;
        const unit = dateUnitOf(e);
        const target = n === 'DATE_TRUNC' || n === 'DATETRUNC' ? (a[0].type === 'lit' ? A(1) : A(0)) : A(0);
        if (unit) return unit === 'day' ? `the date of ${target}` : `the ${unit} of ${target}`;
        return `${A(0)} with the decimals cut off`;
      }
      case 'FLOOR': return `${A(0)} rounded down`;
      case 'CEIL': case 'CEILING': return `${A(0)} rounded up`;
      case 'ABS': return `the absolute value of ${A(0)}`;
      case 'POWER': case 'POW': return `${A(0)} to the power of ${A(1)}`;
      case 'SQRT': return `the square root of ${A(0)}`;
      case 'MOD': return `the remainder of ${A(0)} divided by ${A(1)}`;
      case 'GREATEST': return `the largest of ${this.list(a.map((_, i) => A(i)))}`;
      case 'LEAST': return `the smallest of ${this.list(a.map((_, i) => A(i)))}`;
      case 'SAFE_DIVIDE': case 'DIV0': case 'DIV0NULL': return `${A(0)} divided by ${A(1)} (empty or 0 instead of an error when dividing by zero)`;
      case 'IIF': case 'IFF': case 'IF': return `${A(1)} if ${this.cond(a[0], b, depth + 1)}, otherwise ${A(2)}`;
      case 'DECODE': {
        const pairs = [];
        for (let i = 1; i + 1 < a.length; i += 2) pairs.push(`${A(i + 1)} when ${A(0)} is ${A(i)}`);
        const def = a.length % 2 === 0 ? `, otherwise ${A(a.length - 1)}` : '';
        if (pairs.length > 4) return `one of ${pairs.length + (def ? 1 : 0)} values depending on ${A(0)}`;
        return `${pairs.join('; ')}${def}`;
      }
      case 'NOW': case 'CURRENT_TIMESTAMP': case 'SYSDATE': case 'SYSTIMESTAMP': case 'GETDATE': case 'GETUTCDATE': case 'SYSDATETIME': case 'LOCALTIMESTAMP': return 'the current date and time';
      case 'CURRENT_DATE': case 'CURDATE': return "today's date";
      case 'CURRENT_USER': case 'USER': case 'SESSION_USER': case 'SYSTEM_USER': case 'SUSER_SNAME': return 'the current database user';
      case 'ROWNUM': return 'the row number (ROWNUM)';
      case 'LEVEL': return 'the depth in the hierarchy (LEVEL)';
      case 'DATE': return a.length ? `the date of ${A(0)}` : 'a date';
      case 'YEAR': case 'MONTH': case 'DAY': case 'QUARTER': case 'WEEK': case 'HOUR': case 'DAYOFWEEK': case 'DAYOFMONTH': case 'WEEKDAY':
        return `the ${n.toLowerCase().replace('dayof', 'day of the ')} of ${A(0)}`;
      case 'EXTRACT': case 'DATE_PART': case 'DATEPART': {
        const unit = (a[0].type === 'lit' ? String(a[0].value) : a[0].type === 'col' ? a[0].parts[0] : '').toLowerCase().replace(/^(yy|yyyy)$/, 'year').replace(/^(mm|m)$/, 'month').replace(/^(dd|d)$/, 'day').replace(/^dow$/, 'day of the week').replace(/^doy$/, 'day of the year').replace(/^epoch$/, 'number of seconds since 1970');
        return `the ${unit || 'part'} of ${A(1)}`;
      }
      case 'TO_CHAR': case 'DATE_FORMAT': case 'FORMAT': case 'STRFTIME': case 'FORMAT_DATE': case 'FORMAT_TIMESTAMP': {
        const fmtIdx = n === 'STRFTIME' || n === 'FORMAT_DATE' || n === 'FORMAT_TIMESTAMP' ? 0 : 1;
        const valIdx = fmtIdx === 0 ? 1 : 0;
        if (!a[fmtIdx]) return `${A(valIdx)} as text`;
        return `${A(valIdx)} formatted as ${A(fmtIdx)}`;
      }
      case 'TO_DATE': case 'TO_TIMESTAMP': case 'STR_TO_DATE': case 'PARSE_DATE': case 'PARSE_TIMESTAMP': case 'TRY_TO_DATE':
        return `${A(n.startsWith('PARSE') ? 1 : 0)} read as a date`;
      case 'TO_NUMBER': case 'TRY_TO_NUMBER': return `${A(0)} as a number`;
      case 'DATEADD': {
        const rel = this.relativeDate(e, b, depth);
        if (rel) return rel;
        const unit = a[0].type === 'col' ? a[0].parts[0].toLowerCase() : String(a[0].value || '').toLowerCase();
        return `${A(2)} plus ${A(1)} ${unit}s`;
      }
      case 'DATE_ADD': case 'DATE_SUB': case 'ADDDATE': case 'SUBDATE': case 'ADD_MONTHS': {
        const rel = this.relativeDate(e, b, depth);
        if (rel) return rel;
        return `${A(0)} ${/SUB/.test(n) ? 'minus' : 'plus'} ${A(1)}${n === 'ADD_MONTHS' ? ' months' : ''}`;
      }
      case 'DATEDIFF': case 'DATE_DIFF': case 'TIMESTAMPDIFF': case 'TIMESTAMP_DIFF': case 'DATETIME_DIFF': {
        if (a.length === 3 && (n === 'DATEDIFF' || n === 'TIMESTAMPDIFF')) {
          const unit = (a[0].type === 'col' ? a[0].parts[0] : String(a[0].value || 'day')).toLowerCase().replace(/^(dd|d)$/, 'day').replace(/^(mm|m)$/, 'month').replace(/^(yy|yyyy)$/, 'year');
          return `the number of ${unit}s from ${A(1)} to ${A(2)}`;
        }
        if (a.length === 3) return `the number of ${String(a[2].type === 'col' ? a[2].parts[0] : a[2].value || 'day').toLowerCase()}s from ${A(1)} to ${A(0)}`;
        return `the number of days from ${A(1)} to ${A(0)}`;
      }
      case 'MONTHS_BETWEEN': return `the number of months from ${A(1)} to ${A(0)}`;
      case 'AGE': return a.length === 2 ? `the time from ${A(1)} to ${A(0)}` : `the age of ${A(0)}`;
      case 'LAST_DAY': case 'EOMONTH': return `the last day of the month of ${A(0)}`;
      case 'CAST': case 'CONVERT': case 'TRY_CONVERT':
        if (e.convertTypeFirst && a[0].type === 'typename') return /^date$/i.test(a[0].name) ? `the date of ${A(1)}` : `${A(1)} as ${a[0].name.toLowerCase()}`;
        return `${A(0)} converted`;
      case 'EXISTS': return this.cond(e, b, depth);
      case 'JSON_VALUE': case 'JSON_EXTRACT': case 'JSON_EXTRACT_SCALAR': case 'JSON_EXTRACT_PATH_TEXT': case 'JSON_QUERY': case 'GET_JSON_OBJECT':
        return `the ${A(1)} value inside ${A(0)}`;
      case 'JSON PATH': return `the ${a[1].value} field of ${A(0)}`;
      case 'FIELD': return `the ${a[1].value} field of ${A(0)}`;
      case 'SUBSCRIPT': return `item ${A(1)} of ${A(0)}`;
      case 'ARRAY': return a.length ? `a list of ${this.list(a.slice(0, 4).map((_, i) => A(i)))}` : 'an empty list';
      case 'UNNEST': case 'FLATTEN': case 'EXPLODE': return `one row per item of ${A(0)}`;
      case 'MD5': case 'SHA1': case 'SHA2': case 'SHA256': case 'HASHBYTES': case 'STANDARD_HASH': case 'FARM_FINGERPRINT': case 'HASH': return `a hash of ${A(a.length - 1)}`;
      case 'ROW_NUMBER': case 'RANK': case 'DENSE_RANK': return `a ${n === 'ROW_NUMBER' ? 'row number' : 'rank'}`;
      case 'AT TIME ZONE': return `${A(0)} in time zone ${A(1)}`;
      case 'POSITION': case 'STRPOS': case 'INSTR': case 'CHARINDEX': case 'LOCATE': { const needleFirst = ['POSITION', 'CHARINDEX', 'LOCATE'].includes(n); return `the position of ${needleFirst ? A(0) : A(1)} in ${needleFirst ? A(1) : A(0)}`; }
      case 'LPAD': case 'RPAD': return `${A(0)} padded to ${A(1)} characters`;
      case 'UUID': case 'NEWID': case 'GEN_RANDOM_UUID': case 'UUID_GENERATE_V4': return 'a new random ID';
      case 'RANDOM': case 'RAND': return 'a random number';
      default: {
        const nm = e.rawName || n;
        if (!a.length) return `the result of ${this.code(nm + '()')}`;
        return `${this.code(nm)} of ${this.list(a.slice(0, 3).map((_, i) => A(i)))}`;
      }
    }
  }

  windowFn(e, b, depth) {
    const over = this.overSpec(e, b);
    const a = e.args;
    const A = (i) => this.say(a[i], b, depth + 1);
    const aggLike = isAggregate({ ...e, over: null });
    const part = over.partitionBy.length ? ` within each ${this.list(over.partitionBy.map((p) => this.groupNounText(b, p)))}` : aggLike ? ' across all rows' : '';
    const ord = over.orderBy.length ? `, ${this.orderText(over.orderBy, b, depth)}` : '';
    const noun = this.countNoun(b);
    switch (e.name) {
      case 'ROW_NUMBER': return `a running number (1, 2, 3 …)${part}${ord}`;
      case 'RANK': case 'DENSE_RANK': return `the rank${part}${ord}${e.name === 'RANK' ? ' (ties share a rank, then numbers are skipped)' : ' (ties share a rank)'}`;
      case 'NTILE': return `which of ${A(0)} equal-sized groups the row falls into${part}${ord}`;
      case 'PERCENT_RANK': case 'CUME_DIST': return `the relative position (0 to 1)${part}${ord}`;
      case 'LAG': case 'LEAD': {
        const back = a[1] && a[1].type === 'lit' && Number(a[1].value) !== 1 ? `${a[1].value} rows ${e.name === 'LAG' ? 'back' : 'ahead'}` : null;
        return `${A(0)} from the ${back || (e.name === 'LAG' ? 'previous' : 'next')} row${part}${ord}`;
      }
      case 'FIRST_VALUE': return `the first ${A(0)}${part}${ord}`;
      case 'LAST_VALUE': return `the last ${A(0)}${part}${ord}`;
      case 'NTH_VALUE': return `${A(0)} from row ${A(1)}${part}${ord}`;
      default: {
        if (!isAggregate({ ...e, over: null })) return `${this.code(e.rawName || e.name)}${part}${ord}`;
        const inner = this.func({ ...e, over: null }, b, depth);
        const frame = over.frame || '';
        const m = /ROWS\s+BETWEEN\s+(\d+)\s+PRECEDING\s+AND\s+CURRENT\s+ROW/i.exec(frame);
        if (m && e.name === 'AVG') return `the moving average of ${A(0)} over the last ${Number(m[1]) + 1} rows${part}${ord}`;
        if (m) return `${inner} over the last ${Number(m[1]) + 1} rows${part}${ord}`;
        if (over.orderBy.length && !/UNBOUNDED\s+FOLLOWING/i.test(frame)) {
          if (e.name === 'SUM') return `the running total of ${A(0)}${part}${ord}`;
          if (e.name === 'COUNT') return `the running count of ${this.plural(noun)}${part}${ord}`;
          return `the running ${inner.replace(/^the /, '')}${part}${ord}`;
        }
        if (over.partitionBy.length) return `${inner} for all ${this.plural(noun)} with the same ${this.list(over.partitionBy.map((p) => this.groupNounText(b, p)))}`;
        return `${inner} across all rows`;
      }
    }
  }

  overSpec(e, b) {
    const o = e.over || { partitionBy: [], orderBy: [] };
    if (o.name && b.select && b.select.windows) {
      const w = b.select.windows.find((x) => x.name.toLowerCase() === o.name.toLowerCase());
      if (w) return { ...w.spec, partitionBy: o.partitionBy.length ? o.partitionBy : w.spec.partitionBy, orderBy: o.orderBy.length ? o.orderBy : w.spec.orderBy };
    }
    return o;
  }

  groupNounText(b, e) {
    const g = this.m.groupNoun(b, e);
    if (g) return g.noun;
    return this.say(e, b, 1);
  }

  orderText(items, b, depth = 0) {
    return `ordered by ${this.list(items.map((it) => this.orderItem(it, b, depth)))}`;
  }

  orderItem(it, b, depth = 0) {
    const e = it.expr;
    let name;
    if (e.type === 'lit' && e.kind === 'number' && b.outputs && b.outputs[e.value - 1]) name = this.code(b.outputs[e.value - 1].name);
    else if (e.type === 'col' && e.parts.length === 1 && b.outputs && b.outputs.some((o) => o.alias && o.alias.toLowerCase() === e.parts[0].toLowerCase())) name = this.code(e.parts[0]);
    else {
      const norm = (x) => String(x || '').replace(/\s+/g, '').toLowerCase();
      const same = b.outputs && b.outputs.find((o) => o.expr && !o.star && o.expr.s != null && norm(this.srcText(o.expr)) === norm(this.srcText(e)));
      name = same ? this.code(same.name) : this.say(e, b, depth + 1);
    }
    const desc = it.dir === 'DESC';
    let dir = '';
    const target = e.type === 'lit' && b.outputs && b.outputs[e.value - 1] ? b.outputs[e.value - 1].expr : (e.type === 'col' && b.outputs ? (b.outputs.find((o) => o.alias && o.alias.toLowerCase() === e.parts[0].toLowerCase()) || {}).expr || e : e);
    if (looksDate(target)) dir = desc ? ' (newest first)' : ' (oldest first)';
    else if (numberish(target)) dir = desc ? ' (highest first)' : ' (lowest first)';
    else if (desc) dir = ' (descending)';
    return `${name}${dir}`;
  }

  scalarSub(e, b, depth) {
    const sb = this.blockFor(e.query);
    if (!sb || !sb.select || !sb.outputs[0]) return 'the result of a subquery';
    const corr = this.correlation(sb);
    const val = this.say(sb.outputs[0].expr, sb, depth + 1);
    const where = this.filterConds(sb, corr.links).map((c) => this.cond(c, sb, depth + 1));
    const forWhat = corr.links.length ? ` for this ${corr.outerEntity || 'row'}` : '';
    return `${val}${forWhat}${where.length ? ` (counting only ${this.plural(this.grainEntity(sb) || 'row')} where ${this.list(where.slice(0, 2))})` : ''}`;
  }

  blockFor(query) { return this.m.blocks.find((x) => x.query === query || (x.node && query && x.node === query.body)) || null; }

  // ---------- conditions ----------
  cond(e, b, depth = 0) {
    if (!e) return '';
    if (depth > 6) return this.code(this.srcText(e) || 'condition');
    const L = () => this.say(e.left, b, depth + 1);
    switch (e.type) {
      case 'bin': {
        if (e.op === 'AND') return `${this.cond(e.left, b, depth + 1)} and ${this.cond(e.right, b, depth + 1)}`;
        if (e.op === 'OR') {
          const parts = flattenOr(e).map((x) => this.cond(x, b, depth + 1));
          return `either ${this.list(parts, 'or')}`;
        }
        const cmp = { '=': 'is', '<>': 'is not', 'IS DISTINCT FROM': 'is not', 'IS NOT DISTINCT FROM': 'is' };
        if (e.op in cmp || ['<', '>', '<=', '>='].includes(e.op)) {
          // keep the column on the left
          let left = e.left;
          let right = e.right;
          let op = e.op;
          if (left.type !== 'col' && right.type === 'col' && !['=', '<>'].includes(op)) { [left, right] = [right, left]; op = { '<': '>', '>': '<', '<=': '>=', '>=': '<=' }[op] || op; }
          if (left.type !== 'col' && right.type === 'col') [left, right] = [right, left];
          const ls = this.say(left, b, left.type === 'col' ? depth : depth + 1);
          if (right.type === 'lit' && right.kind === 'null' && (op === '=' || op === '<>')) return `${ls} ${op} NULL (which is never true)`;
          if (right.type === 'lit' && right.kind === 'bool' && (op === '=' || op === '<>')) return (right.value === (op === '=')) ? `${ls} is true` : `${ls} is false`;
          if (left.type === 'col' && isFlagName(left.parts[left.parts.length - 1]) && right.type === 'lit' && (op === '=' || op === '<>')) {
            const v = String(right.value).toUpperCase();
            const truthy = ['1', 'Y', 'YES', 'T', 'TRUE'].includes(v);
            const falsy = ['0', 'N', 'NO', 'F', 'FALSE'].includes(v);
            if (truthy || falsy) return (truthy === (op === '=')) ? ls : `not ${ls}`;
          }
          let rs = this.relativeDate(right, b, depth) || this.say(right, b, depth + 1);
          if ((rs === 'yesterday' || rs === 'today' || rs === 'tomorrow') && op === '=' && dateUnitOf(left) === 'day') return `${this.say(left.type === 'cast' ? left.expr : left.args.find((x) => x.type === 'col') || left, b, depth + 1)} is ${rs}`;
          if (rs === 'yesterday' || rs === 'tomorrow') rs = rs === 'yesterday' ? 'the start of yesterday' : 'the start of tomorrow';
          const isVar = (x) => x.type === 'col' && (this.m.resolve(b, x) || {}).variable;
          if ((op === '=' || op === '<>') && isVar(left) && !isVar(right) && right.type === 'col') return `${this.say(right, b, depth)} ${cmp[op] || op} ${ls}`;
          if (left.type === 'col' && right.type === 'col' && op === '=' && !isVar(right)) return `${ls} matches ${rs}`;
          if (op in cmp) return `${ls} ${cmp[op]} ${rs}`;
          const date = looksDate(left) || looksDate(right);
          const words = date ? { '>': 'is after', '>=': 'is on or after', '<': 'is before', '<=': 'is on or before' } : { '>': 'is more than', '>=': 'is at least', '<': 'is less than', '<=': 'is at most' };
          if (left.type === 'func' && left.name === 'ROWNUM') return `only the first ${op === '<' ? Number(right.value) - 1 : rs} rows read`;
          return `${ls} ${words[op]} ${rs}`;
        }
        if (e.op === '~' || e.op === '~*') return `${L()} matches the pattern ${this.say(e.right, b, depth + 1)}${e.op === '~*' ? ' (ignoring case)' : ''}`;
        if (e.op === '!~' || e.op === '!~*') return `${L()} does not match the pattern ${this.say(e.right, b, depth + 1)}`;
        if (e.op === '@>') return `${L()} contains ${this.say(e.right, b, depth + 1)}`;
        if (e.op === '<@') return `${L()} is contained in ${this.say(e.right, b, depth + 1)}`;
        if (e.op === '&&') return `${L()} overlaps ${this.say(e.right, b, depth + 1)}`;
        if (e.op === 'OVERLAPS') return `${L()} overlaps ${this.say(e.right, b, depth + 1)}`;
        return this.binValue(e, b, depth);
      }
      case 'not': {
        const x = e.expr;
        if (x.type === 'bin' && x.op === '=') return this.cond({ ...x, op: '<>' }, b, depth + 1);
        if (x.type === 'col') return `${this.say(x, b, depth + 1)} is false`;
        return `not (${this.cond(x, b, depth + 1)})`;
      }
      case 'isnull': return e.not ? `${this.say(e.expr, b, depth + 1)} has a value` : `${this.say(e.expr, b, depth + 1)} is empty`;
      case 'istruth': return `${this.say(e.expr, b, depth + 1)} is ${e.not ? 'not ' : ''}${e.value.toLowerCase()}`;
      case 'between': {
        const lo = this.relativeDate(e.low, b, depth) || this.say(e.low, b, depth + 1);
        const hi = this.relativeDate(e.high, b, depth) || this.say(e.high, b, depth + 1);
        return `${L()} is ${e.not ? 'not ' : ''}between ${lo} and ${hi}`;
      }
      case 'like': return this.likeCond(e, b, depth);
      case 'in': {
        if (e.query) return this.inSub(e, b, depth);
        const vals = e.list.map((x) => this.say(x, b, depth + 1));
        if (vals.length === 1) return `${L()} ${e.not ? 'is not' : 'is'} ${vals[0]}`;
        const shown = vals.length > 6 ? `${vals.slice(0, 5).join(', ')} … (${vals.length} values)` : this.list(vals, 'or');
        return `${L()} is ${e.not ? 'not ' : ''}${vals.length > 6 ? 'one of ' : ''}${vals.length > 6 ? shown : shown}`;
      }
      case 'exists': return this.existsCond(e, b, depth);
      case 'quant': {
        const words = { '=': 'equals', '<>': 'differs from', '>': 'is more than', '>=': 'is at least', '<': 'is less than', '<=': 'is at most' };
        if (!e.query && e.list.length === 1 && (e.op === '=' || e.op === '<>')) {
          const arr = this.say(e.list[0], b, depth + 1);
          if (e.op === '=' && e.quant === 'ANY') return `${L()} is one of the values in ${arr}`;
          if (e.op === '<>' && e.quant === 'ALL') return `${L()} is none of the values in ${arr}`;
        }
        const what = e.query ? this.subValues(e, depth) : this.list(e.list.map((x) => this.say(x, b, depth + 1)), 'or');
        return `${L()} ${words[e.op] || e.op} ${e.quant === 'ALL' ? 'every one of' : 'at least one of'} ${what}`;
      }
      case 'col': {
        const ph = this.say(e, b, depth);
        return /^(is|has|have|can|should|was|allow|allows|enable|enabled|active|deleted|archived|flag)\b|\b(is|has) /i.test(words(e.parts[e.parts.length - 1])) ? ph : `${ph} is true`;
      }
      case 'func': return this.say(e, b, depth);
      case 'lit': return e.kind === 'bool' ? (e.value ? 'always' : 'never') : this.say(e, b, depth);
      default: return this.say(e, b, depth);
    }
  }

  likeCond(e, b, depth) {
    const L = this.say(e.left, b, depth + 1);
    const icase = e.op === 'ILIKE' ? ' (ignoring case)' : '';
    if (e.op === 'REGEXP' || e.op === 'RLIKE' || e.op === 'SIMILAR TO') return `${L} ${e.not ? 'does not match' : 'matches'} the pattern ${this.say(e.right, b, depth + 1)}`;
    // [positive, negative] verb phrases
    const one = (r) => {
      if (r.type === 'lit' && r.kind === 'string') {
        const v = r.value;
        const core = v.replace(/^%+|%+$/g, '');
        const simple = !/[%_]/.test(core);
        if (simple && /^%.*%$/.test(v) && v.length > 1) return ['contains', 'does not contain', this.q(core)];
        if (simple && /%$/.test(v)) return ['starts with', 'does not start with', this.q(core)];
        if (simple && /^%/.test(v)) return ['ends with', 'does not end with', this.q(core)];
        if (!/[%_]/.test(v)) return ['equals', 'does not equal', this.q(v)];
        return ['matches the pattern', 'does not match the pattern', this.q(v)];
      }
      return ['matches the pattern', 'does not match the pattern', this.say(r, b, depth + 1)];
    };
    if (e.list) {
      const parts = e.list.map(one);
      return `${L} ${parts.map(([pos, neg, v]) => `${e.not ? neg : pos} ${v}`).join(e.quant === 'ALL' || e.not ? ' and ' : ' or ')}${icase}`;
    }
    const [pos, neg, v] = one(e.right);
    return `${L} ${e.not ? neg : pos} ${v}${icase}`;
  }

  /** Correlated column pairs between a subquery block and its outer block. */
  correlation(sb) {
    const links = [];
    let outerEntity = null;
    const where = sb.select ? conjuncts(sb.select.where) : [];
    for (const c of where) {
      if (c.type === 'bin' && c.op === '=' && c.left.type === 'col' && c.right.type === 'col') {
        const a = this.m.resolve(sb, c.left) || {};
        const r = this.m.resolve(sb, c.right) || {};
        if (a.correlated !== r.correlated && (a.source || r.source)) {
          const outer = a.correlated ? a : r;
          links.push(c);
          if (outer.source) outerEntity = outer.source.entity;
        }
      }
    }
    return { links, outerEntity };
  }

  filterConds(b, exclude = []) {
    if (!b.select) return [];
    const skip = new Set([...exclude, ...(b.whereUsedByJoins || [])]);
    return conjuncts(b.select.where).filter((c) => !skip.has(c) && !isRownum(c));
  }
  rownumLimit(b) {
    if (!b.select) return null;
    const c = conjuncts(b.select.where).find(isRownum);
    if (!c) return null;
    const lit = c.right && c.right.type === 'lit' ? c.right : c.left && c.left.type === 'lit' ? c.left : null;
    const n = lit ? (c.op === '<' ? Number(lit.value) - 1 : Number(lit.value)) : null;
    return { node: c, n };
  }

  existsCond(e, b, depth) {
    const sb = this.blockFor(e.query);
    if (!sb || !sb.select) return `${e.not ? 'no' : 'at least one'} matching row exists`;
    const corr = this.correlation(sb);
    const ent = this.grainEntity(sb) || 'row';
    const others = this.filterConds(sb, corr.links).map((c) => this.cond(c, sb, depth + 1));
    const tail = others.length ? ` where ${this.list(others.slice(0, 3))}` : '';
    if (corr.links.length) {
      const owner = corr.outerEntity || 'row';
      return e.not ? `the ${owner} has no ${this.plural(ent)}${tail}` : `the ${owner} has at least one ${ent}${tail}`;
    }
    const tables = sb.sources.map((s) => this.code(s.displayName)).join(', ');
    return e.not ? `no row exists in ${tables}${tail}` : `at least one row exists in ${tables}${tail}`;
  }

  subValues(e, depth) {
    const sb = this.blockFor(e.query);
    if (!sb || !sb.select || !sb.outputs[0]) return 'the values returned by a subquery';
    const corr = this.correlation(sb);
    const what = this.say(sb.outputs[0].expr, sb, 0);
    const ent = this.grainEntity(sb) || 'row';
    const conds = this.filterConds(sb, corr.links).map((c) => this.cond(c, sb, 0));
    const grouped = sb.select.groupBy && sb.select.groupBy.items.length ? ` per ${this.list(sb.select.groupBy.items.map((g) => this.groupNounText(sb, g)))}` : '';
    const pl = /^the (number|sum|average|highest|lowest|latest|earliest)/.test(what) ? what : this.plural(what);
    const having = sb.select.having ? `, keeping only groups where ${this.list(conjuncts(sb.select.having).map((c) => this.cond(c, sb, 0)))}` : '';
    return `the ${pl.replace(/^the /, '')} of ${this.plural(ent)}${grouped}${conds.length ? ` where ${this.list(conds.slice(0, 3))}` : ''}${having}`;
  }

  inSub(e, b, depth) {
    const L = this.say(e.left, b, depth + 1);
    return `${L} is ${e.not ? 'not ' : ''}among ${this.subValues(e, depth)}`;
  }

  // ---------- grain ----------
  topPerGroup(b) {
    if (!b.select) return null;
    const conds = [...conjuncts(b.select.where), ...conjuncts(b.select.qualify)];
    for (const c of conds) {
      const r = this.rankFilter(b, c);
      if (r) return r;
    }
    return null;
  }

  /** c is "rn = 1" / "rn <= 3" on a ROW_NUMBER/RANK column -> details, else null. */
  rankFilter(b, c) {
    {
      if (c.type !== 'bin' || !['=', '<=', '<'].includes(c.op)) return null;
      let ref = c.left;
      let lim = c.right;
      if (ref.type === 'lit') [ref, lim] = [lim, ref];
      if (!(lim.type === 'lit' && lim.kind === 'number')) return null;
      let win = null;
      let inner = b;
      if (ref.type === 'func' && ref.over) win = ref;
      else if (ref.type === 'col') {
        const r = this.m.resolve(b, ref) || {};
        if (r.outputAlias && r.output && r.output.expr && r.output.expr.over) win = r.output.expr;
        else if (r.source && (r.source.kind === 'derived' || r.source.kind === 'cte')) {
          inner = r.source.kind === 'cte' ? r.source.cteBlock : r.source.inner;
          const o = inner && inner.outputs && inner.outputs.find((x) => x.name.toLowerCase() === String(r.column).toLowerCase());
          if (o && o.expr && o.expr.type === 'func' && o.expr.over) win = o.expr;
        } else if (b.outputs) {
          const o = b.outputs.find((x) => x.alias && x.alias.toLowerCase() === ref.parts[ref.parts.length - 1].toLowerCase());
          if (o && o.expr && o.expr.over) win = o.expr;
        }
      }
      if (!win || !['ROW_NUMBER', 'RANK', 'DENSE_RANK'].includes(win.name)) return null;
      const over = this.overSpec(win, inner);
      const n = c.op === '<' ? Number(lim.value) - 1 : Number(lim.value);
      return { node: c, win, inner, n, partitionBy: over.partitionBy, orderBy: over.orderBy };
    }
  }

  rankPhrase(t, ent) {
    const per = t.partitionBy.length ? ` per ${this.list(t.partitionBy.map((p) => this.groupNounText(t.inner, p)))}` : '';
    const sup = this.superlative(t);
    if (t.n === 1) return `${sup && sup.adj ? `the ${sup.adj} ${ent}` : sup ? `the ${ent} with ${sup.by}` : `one ${ent}`}${per}`;
    return `${sup && sup.adj ? `the ${t.n} ${sup.adj} ${this.plural(ent)}` : `${t.n} ${this.plural(ent)}${sup ? ` with ${sup.by}` : ''}`}${per}`;
  }

  superlative(t) {
    const first = t.orderBy[0];
    if (!first) return null;
    const desc = first.dir === 'DESC';
    if (looksDate(first.expr)) return { adj: desc ? 'most recent' : 'first', by: null };
    return { adj: null, by: `the ${desc ? 'highest' : 'lowest'} ${this.say(first.expr, t.inner, 1)}` };
  }

  grainText(b) {
    if (b.setop) {
      const n = b.branches.length;
      const op = b.setop.op;
      if (op === 'UNION') return b.setop.all ? `the rows of ${n} queries stacked together (duplicates kept)` : `the rows of ${n} queries combined, with duplicate rows removed`;
      if (op === 'INTERSECT') return `only the rows that all ${n} queries return`;
      return 'the rows of the first query that the second query does not return';
    }
    if (b.values) return `${b.values.rows.length} fixed row${b.values.rows.length === 1 ? '' : 's'}`;
    if (!b.select) return 'rows';
    const sel = b.select;
    if (sel.groupBy && sel.groupBy.items && sel.groupBy.items.length) {
      const nouns = sel.groupBy.items.map((g) => this.groupNounText(b, g));
      const extra = sel.groupBy.kind === 'rollup' ? ', plus subtotal rows and a grand total' : sel.groupBy.kind === 'cube' ? ', plus subtotals for every combination' : sel.groupBy.kind === 'grouping sets' ? ' (for several groupings at once)' : '';
      return `one row per ${this.list(dedupe(nouns))}${extra}`;
    }
    if (b.outputs.length && b.outputs.some((o) => o.expr && hasAggregate(o.expr)) && !b.outputs.some((o) => o.expr && o.expr.type === 'col' && !hasAggregate(o.expr))) return 'a single summary row';
    if (!b.sources.length) return 'a single row of calculated values';
    const ent = this.grainEntity(b) || 'row';
    const t = this.topPerGroup(b);
    if (t && t.partitionBy.length) {
      const per = this.list(t.partitionBy.map((p) => this.groupNounText(t.inner, p)));
      const sup = this.superlative(t);
      if (t.n === 1) return sup && sup.adj ? `the ${sup.adj} ${ent} per ${per}` : sup ? `one ${ent} per ${per}: the one with ${sup.by}` : `one ${ent} per ${per}`;
      return sup && sup.adj ? `the ${t.n} ${sup.adj} ${this.plural(ent)} per ${per}` : `up to ${t.n} ${this.plural(ent)} per ${per}${sup ? `, those with ${sup.by}` : ''}`;
    }
    if (sel.distinctOn) return `one row per ${this.list(sel.distinctOn.map((d) => this.groupNounText(b, d)))}`;
    if (sel.distinct) {
      if (b.outputs.length === 1 && b.outputs[0].expr) return `each different ${this.say(b.outputs[0].expr, b, 1)}, once`;
      return 'each different combination of the selected columns, once';
    }
    const crosses = b.sources.slice(1).filter((s) => this.m.joinInfo(b, s).card === 'cross');
    if (crosses.length) return `every combination of ${this.list([b.sources[0], ...crosses].map((s) => `${s.entity} (\`${s.displayName}\`)`))}`;
    const multipliers = b.sources.slice(1).filter((s) => { const j = this.m.joinInfo(b, s); return j.card === '1:N' || j.card === 'N:N'; });
    const base = b.sources[0] ? b.sources[0].entity : 'row';
    if (multipliers.length && base !== ent) return `one row per ${ent} (so each ${base} can appear several times)`;
    return `one row per ${ent}`;
  }

  // ---------- steps ----------
  orderedBlocks() {
    const out = [];
    const seen = new Set();
    const visit = (b) => {
      if (!b || seen.has(b) || b.pending) return;
      seen.add(b);
      for (const c of b.cteBlocks || []) visit(c);
      if (b.setop) for (const br of b.branches) visit(br);
      for (const s of b.sources || []) { if (s.kind === 'derived') visit(s.inner); if (s.kind === 'cte') visit(s.cteBlock); }
      for (const q of b.subqueries || []) visit(q.block);
      out.push(b);
    };
    // CTEs declared on the statement (INSERT/UPDATE with WITH)
    for (const b of this.m.blocks.filter((x) => x.kind === 'cte' && !x.parent)) visit(b);
    visit(this.m.main);
    return out;
  }

  needsStep(b) {
    if (b === this.m.main || b.kind === 'cte' || b.kind === 'derived' || b.kind === 'branch') return true;
    if (b.kind === 'subquery') {
      const sel = b.select;
      return !!(sel && (b.sources.length > 1 || sel.groupBy || b.subqueries.length || b.setop));
    }
    return false;
  }

  steps() {
    const blocks = this.orderedBlocks().filter((b) => this.needsStep(b));
    blocks.forEach((b, i) => this.stepOf.set(b, i + 1));
    return blocks.map((b, i) => this.step(b, i + 1));
  }

  stepTitle(b) {
    if (b === this.m.main) {
      const st = this.m.stmt.type;
      if (b.dml) return st === 'update' ? 'The update' : st === 'delete' ? 'The delete' : 'The merge';
      if (st === 'insert') return 'The rows to insert';
      if (st === 'create') return `The ${this.m.target.kind} definition`;
      return 'The final result';
    }
    if (b.kind === 'cte') return `${this.code(b.name)}${b.recursive ? ' (recursive)' : ''}`;
    if (b.kind === 'derived') return b.name ? `Subquery ${this.code(b.name)}` : 'Subquery in FROM';
    if (b.kind === 'branch') return `Part ${b.branchIndex + 1} of the ${b.branchOf.setop.op}`;
    return `Subquery in the ${b.subqueryOf ? b.subqueryOf.clause.toUpperCase() : ''} clause`;
  }

  step(b, n) {
    const lines = [];
    const add = (k, text, items, node) => lines.push({ k, text, items: items || null, node: node || null });
    if (b.recursive) add('note', 'This CTE refers to itself: it starts from the first part (the anchor) and keeps adding rows from the second part until no new rows appear, which is how hierarchies and chains are walked.');
    if (b.setop) {
      const parts = b.branches.map((br) => this.stepName(br) || 'a query');
      const op = b.setop.op;
      const how = op === 'UNION' ? (b.setop.all ? 'stacks the rows of' : 'combines the rows of') : op === 'INTERSECT' ? 'keeps only rows returned by all of' : 'takes the rows of the first and removes those returned by the second of';
      add('setop', `${this.cap(how)} ${this.list(parts)}${op === 'UNION' ? (b.setop.all ? ', keeping duplicate rows (UNION ALL)' : ', removing duplicate rows (UNION)') : ''}.`);
      this.tailLines(b, add);
      return { n, id: b.id, kind: b.kind, title: this.stepTitle(b), name: b.name, lines, s: b.node.s, e: b.node.e, block: b };
    }
    if (b.values) {
      add('from', `A fixed list of ${b.values.rows.length} row${b.values.rows.length === 1 ? '' : 's'} written into the query (VALUES).`);
      return { n, id: b.id, kind: b.kind, title: this.stepTitle(b), name: b.name, lines, s: b.node.s, e: b.node.e, block: b };
    }
    const sel = b.select;
    // FROM + joins
    if (!b.sources.length) add('from', 'Does not read any table: it calculates the values directly.');
    b.sources.forEach((s, i) => {
      if (i === 0) add('from', this.fromSentence(s, b), null, s.node);
      else add('join', this.joinSentence(b, s), null, s.join && s.join.node ? s.join.node : s.node);
    });
    // WHERE
    const filters = this.filterConds(b);
    const tpg = this.topPerGroup(b);
    const plainFilters = filters.filter((c) => !tpg || c !== tpg.node);
    if (plainFilters.length) {
      const who = this.rowWord(b);
      add('filter', `Keeps only ${b.dml ? `the ${who}` : who} where:`, plainFilters.map((c) => ({ text: this.cond(c, b), s: c.s, e: c.e })));
    }
    if (sel.connectBy) {
      add('filter', `Walks a hierarchy${sel.connectBy.start ? `, starting from rows where ${this.cond(sel.connectBy.start, b)}` : ''}${sel.connectBy.cond ? `, then repeatedly following ${this.cond(sel.connectBy.cond, b)}` : ''} (CONNECT BY).`);
    }
    // GROUP BY
    if (sel.groupBy && sel.groupBy.items && sel.groupBy.items.length) {
      const nouns = dedupe(sel.groupBy.items.map((g) => this.groupNounText(b, g)));
      const aggs = b.outputs.filter((o) => o.expr && hasAggregate(o.expr));
      const grouping = sel.groupBy.kind === 'rollup' ? ' (ROLLUP adds subtotal rows for each level and a grand total row)' : sel.groupBy.kind === 'cube' ? ' (CUBE adds subtotal rows for every combination)' : sel.groupBy.kind === 'grouping sets' ? ' (GROUPING SETS produces several groupings in one result)' : '';
      add('group', `Groups the ${this.plural(this.grainEntity(b) || 'row')} into one row per ${this.list(nouns)}${grouping}${aggs.length ? ', and for each one calculates:' : '.'}`, aggs.map((o) => ({ text: `${this.code(o.name)}: ${this.say(o.expr, b)}` })));
    } else if (b.outputs.some((o) => o.expr && hasAggregate(o.expr))) {
      const aggs = b.outputs.filter((o) => o.expr && hasAggregate(o.expr));
      add('group', 'Summarises all the rows into a single row, calculating:', aggs.map((o) => ({ text: `${this.code(o.name)}: ${this.say(o.expr, b)}` })));
    }
    if (sel.having) add('having', `Keeps only the ${this.plural(sel.groupBy ? this.list(dedupe((sel.groupBy.items || []).map((g) => this.groupNounText(b, g)))) || 'group' : 'group')} where:`, conjuncts(sel.having).map((c) => ({ text: this.cond(c, b), s: c.s, e: c.e })));
    // window functions
    const wins = b.outputs.filter((o) => o.expr && hasWindow(o.expr));
    if (wins.length) add('window', `Adds ${wins.length === 1 ? 'a column' : `${wins.length} columns`} calculated across related rows (window function${wins.length === 1 ? '' : 's'}):`, wins.map((o) => ({ text: `${this.code(o.name)}: ${this.say(o.expr, b)}` })));
    if (tpg) {
      const ent = this.grainEntity(b) || 'row';
      add('qualify', `Keeps only ${this.rankPhrase(tpg, ent)} (rows numbered ${tpg.n === 1 ? '1' : `1 to ${tpg.n}`}).`, null, tpg.node);
    }
    if (sel.qualify) {
      const others = conjuncts(sel.qualify).filter((c) => !tpg || c !== tpg.node);
      if (others.length) add('qualify', 'After the window functions, keeps only rows where:', others.map((c) => ({ text: this.cond(c, b), s: c.s, e: c.e })));
    }
    // output
    if (b.dml) {
      this.dmlLines(b, add);
    } else if (b.outputs.length) {
      const names = b.outputs.map((o) => this.code(o.name));
      const shown = names.length > 10 ? `${names.slice(0, 9).join(', ')} and ${names.length - 9} more` : this.list(names);
      add('select', `Returns ${b.outputs.length === 1 ? '1 column' : `${b.outputs.length} columns`}: ${shown}.`);
      const consts = b.outputs.filter((o) => o.expr && o.expr.type === 'lit');
      if (b.kind === 'branch' && consts.length) add('note', `Marks its rows with ${this.list(consts.map((o) => `${this.code(o.name)} = ${this.say(o.expr, b)}`))}.`);
    }
    if (sel.distinct && !sel.distinctOn) add('distinct', 'Removes duplicate rows (DISTINCT).');
    if (sel.distinctOn) add('distinct', `Keeps the first row for each ${this.list(sel.distinctOn.map((d) => this.groupNounText(b, d)))} (DISTINCT ON), according to the sort order.`);
    if (sel.into && this.m.stmt.type === 'query') add('note', `Saves the result into ${this.code(sel.into.parts.join('.'))} (SELECT INTO).`);
    this.tailLines(b, add);
    if (b.kind === 'subquery' && b.subqueryOf) add('note', `Used by ${this.stepName(b.parent) || 'the outer query'} as a ${b.subqueryOf.kind === 'exists' ? 'test (EXISTS)' : b.subqueryOf.kind === 'in' ? 'list of values (IN)' : 'value'}.`);
    return { n, id: b.id, kind: b.kind, title: this.stepTitle(b), name: b.name, lines, s: b.node.s, e: b.kind === 'cte' && b.cte ? b.cte.e : b.node.e, block: b };
  }

  tailLines(b, add) {
    const sel = b.select;
    const rn = this.rownumLimit(b);
    if (rn) add('limit', `Stops after the first ${rn.n != null ? rn.n : 'few'} rows it finds (ROWNUM)${b.orderBy && b.orderBy.length ? ', before sorting, so they are not the first rows by the sort order' : ', in no particular order'}.`, null, rn.node);
    if (b.orderBy && b.orderBy.length) add('order', `Sorts by ${this.list(b.orderBy.map((o) => this.orderItem(o, b.setop ? b.branches[0] : b)))}.`);
    const top = sel && sel.top;
    const limit = b.limit || (top && top.n);
    if (limit) {
      const n = limit.type === 'lit' ? limit.value : this.say(limit, b);
      const ties = b.ties || (top && top.ties) ? ', plus any rows tied with the last one' : '';
      const pct = top && top.percent ? '%' : '';
      const off = b.offset ? `, after skipping the first ${b.offset.type === 'lit' ? b.offset.value : this.say(b.offset, b)}` : '';
      add('limit', `Returns only the first ${n}${pct} row${n === 1 ? '' : 's'}${off}${ties}${!b.orderBy || !b.orderBy.length ? ' (in no particular order, because there is no ORDER BY)' : ''}.`);
    } else if (b.offset) add('limit', `Skips the first ${b.offset.type === 'lit' ? b.offset.value : this.say(b.offset, b)} rows.`);
  }

  fromSentence(s, b) {
    const purpose = s.table && s.table.purpose ? ` ${firstSentence(s.table.purpose)}` : '';
    switch (s.kind) {
      case 'table': return `Starts from ${this.code(s.displayName)}${s.alias ? ` (as ${this.code(s.alias)})` : ''}: one row per ${s.entity}.${purpose}`;
      case 'cte': return `Starts from the result of ${this.stepName(s.cteBlock) || 'the CTE'}, ${this.code(s.displayName)}${s.alias ? ` (as ${this.code(s.alias)})` : ''}: ${this.grainText(s.cteBlock)}.`;
      case 'derived': return `Starts from the subquery ${s.alias ? this.code(s.alias) : ''} (${this.stepName(s.inner) || 'see below'}): ${this.grainText(s.inner)}.`;
      case 'function': return `Starts from the rows produced by ${this.code(s.displayName)}${s.alias ? ` (as ${this.code(s.alias)})` : ''}.`;
      default: return `Starts from a fixed list of values${s.alias ? ` (as ${this.code(s.alias)})` : ''}.`;
    }
    void b;
  }

  sourceLabel(s) {
    if (s.kind === 'cte') return `${this.code(s.displayName)} (${this.stepName(s.cteBlock) || 'CTE'})`;
    if (s.kind === 'derived') return `the subquery ${s.alias ? this.code(s.alias) : ''} (${this.stepName(s.inner) || 'below'})`;
    return this.code(s.displayName);
  }

  joinSentence(b, s) {
    const j = this.m.joinInfo(b, s);
    const kind = j.kind;
    const R = s.entity || 'row';
    const label = this.sourceLabel(s);
    if (j.card === 'cross') return `Combines every row so far with every row of ${label} (${j.implicit ? 'listed after a comma with no condition linking them' : 'CROSS JOIN'}): the row count multiplies.`;
    if (j.card === 'apply') {
      const outer = kind === 'OUTER APPLY' || (s.join && s.join.kind === 'LEFT');
      return `For each row so far, runs ${label} and adds its rows${outer ? '; rows with no result are kept, with empty columns (OUTER APPLY)' : '; rows with no result are dropped'}.`;
    }
    const otherSrc = j.other || b.sources[0];
    const L = otherSrc ? otherSrc.entity : 'row';
    const via = j.pairs.length ? ` (${j.pairs.map((p) => `${this.code(`${p.left.source.ref}.${p.left.column}`)} = ${this.code(`${s.ref}.${p.right.column}`)}`).join(' and ')})` : '';
    const rankConds = j.extra.map((c) => this.rankFilter(b, c)).filter(Boolean);
    const plainExtra = j.extra.filter((c) => !rankConds.some((r) => r.node === c));
    let extra = plainExtra.length ? ` Only ${this.plural(R)} where ${this.list(plainExtra.map((c) => this.cond(c, b)))} are matched.` : '';
    if (rankConds.length) extra = ` Only ${this.rankPhrase(rankConds[0], R)} is matched.${extra}`;
    let sentence;
    let lost = '';
    const role = j.pairs.length === 1 ? roleNoun(j.pairs[0].left.column, R) : null;
    const what = role && role !== R ? `${role} (${R} from ${label})` : `${R} from ${label}`;
    switch (j.card) {
      case 'N:1': case '1:1':
        if (R === L || s.kind !== 'table') {
          sentence = `Adds each ${L}'s matching row from ${label}${via}${R !== L ? ` (one ${R} per ${L})` : ''}.`;
          if (kind === 'INNER') lost = ` ${this.cap(this.plural(L))} with no matching row there are left out.`;
          else if (kind === 'LEFT') lost = ` ${this.cap(this.plural(L))} with no matching row are kept, with those columns empty.`;
          break;
        }
        sentence = `Looks up each ${L}'s ${what}${via}.`;
        if (kind === 'INNER') lost = ` ${this.cap(this.plural(L))} without a matching ${role || R} are left out.`;
        else if (kind === 'LEFT') lost = ` ${this.cap(this.plural(L))} without one are kept, with the ${R} columns empty.`;
        break;
      case '1:N':
        sentence = `Adds each ${L}'s ${this.plural(R)} from ${label}${via}, so from here on there is one row per ${R}.`;
        if (kind === 'INNER') lost = ` ${this.cap(this.plural(L))} with no ${this.plural(R)} are left out.`;
        else if (kind === 'LEFT') lost = ` ${this.cap(this.plural(L))} with no ${this.plural(R)} are kept once, with the ${R} columns empty.`;
        break;
      case 'N:N':
        sentence = `Matches rows of ${label} to the ${this.plural(L)}${via}. Neither side looks unique on these columns, so one row can match several and multiply the rows.`;
        if (kind === 'LEFT') lost = ` ${this.cap(this.plural(L))} with no match are kept.`;
        else if (kind === 'INNER') lost = ' Rows with no match are left out.';
        break;
      default:
        sentence = `Joins ${label}${s.join && s.join.on ? ` where ${this.cond(s.join.on, b)}` : ''}.`;
        if (kind === 'LEFT') lost = ' Rows with no match are kept, with empty columns.';
        if (kind === 'INNER') lost = ' Rows with no match are left out.';
    }
    if (kind === 'RIGHT') lost = ` Every ${R} is kept, even without a matching ${L} (RIGHT JOIN).`;
    if (kind === 'FULL') lost = ` Unmatched rows from both sides are kept (FULL OUTER JOIN).`;
    if (kind === 'SEMI') lost = ' Only checks that a match exists; no columns are added (SEMI JOIN).';
    if (kind === 'ANTI') lost = ' Keeps only rows that have no match (ANTI JOIN).';
    const oracle = s.join && s.join.oracle ? ' The (+) marker makes this an outer join in Oracle\'s old syntax.' : '';
    return `${sentence}${lost}${extra}${oracle}`;
  }

  dmlLines(b, add) {
    const st = this.m.stmt;
    const t = this.m.target;
    const ent = t.entity || 'row';
    if (st.type === 'update') {
      const sets = st.set.map((a) => `${this.code(a.columns.map((c) => c.parts[c.parts.length - 1]).join(', '))} to ${this.relativeDate(a.value, b) || this.say(a.value, b)}`);
      add('set', `Sets ${this.list(sets)}.`);
      if (!st.where) add('warn', `There is no WHERE clause, so every row in ${this.code(t.name)} is changed.`);
    }
    if (st.type === 'delete' && !st.where) add('warn', `There is no WHERE clause, so every ${ent} in ${this.code(t.name)} is deleted.`);
    if (st.type === 'merge') {
      for (const w of st.whens) {
        const when = w.matched ? `When a ${ent} already exists` : `When there is no matching ${ent}${w.by === 'SOURCE' ? ' in the source' : ''}`;
        const cond = w.cond ? ` and ${this.cond(w.cond, b)}` : '';
        let act = '';
        if (w.action === 'update') act = `updates ${this.list(w.set.map((a) => `${this.code(a.columns[0].parts[a.columns[0].parts.length - 1])} to ${this.say(a.value, b)}`))}`;
        else if (w.action === 'delete') act = 'deletes it';
        else if (w.action === 'insert') act = `inserts a new row${w.columns ? ` (${this.list(w.columns.map((c) => this.code(c)))})` : ''}`;
        else act = 'does nothing';
        add('set', `${when}${cond}: ${act}.`);
      }
    }
  }

  // ---------- outputs, tables ----------
  outputs(b) {
    const blk = b.setop ? b.branches[0] : b;
    return b.outputs.map((o, i) => {
      const expr = blk.outputs[i] ? blk.outputs[i].expr : o.expr;
      if (o.star) return { name: o.name, text: `Every column of ${o.source ? this.sourceLabel(o.source) : 'the tables in FROM'} (the exact list is not known without a schema).`, kind: 'all', origins: [], s: o.item && o.item.s, e: o.item && o.item.e };
      if (!expr || o.raw) return { name: o.name, text: 'Could not be read.', kind: 'unknown', origins: [] };
      const kind = expr.type === 'col' ? 'column' : hasWindow(expr) ? 'window' : hasAggregate(expr) ? 'aggregate' : expr.type === 'lit' ? 'constant' : expr.type === 'subquery' ? 'subquery' : 'calculated';
      let text = this.cap(this.say(expr, blk));
      let detail = null;
      if (expr.type === 'col') {
        const base = this.baseColumn(blk, expr);
        if (base && base.catalogColumn && base.catalogColumn.explain) detail = base.catalogColumn.explain;
      }
      if (kind === 'constant') text = `Always ${this.say(expr, blk)}`;
      const origins = this.origins(blk, expr);
      let branches = null;
      if (b.setop) branches = b.branches.slice(1).map((br) => (br.outputs[i] && br.outputs[i].expr ? this.say(br.outputs[i].expr, br) : null)).filter(Boolean);
      return { name: o.name, text, detail, kind, origins, branches, s: o.item ? o.item.s : expr.s, e: o.item ? o.item.e : expr.e };
    });
  }

  baseColumn(b, col, depth = 0) {
    const r = this.m.resolve(b, col) || {};
    if (!r.source || depth > 5) return null;
    if (r.source.kind === 'table') return r;
    const inner = r.source.kind === 'cte' ? r.source.cteBlock : r.source.kind === 'derived' ? r.source.inner : null;
    const o = inner && inner.outputs && inner.outputs.find((x) => x.name.toLowerCase() === String(r.column).toLowerCase());
    if (o && o.expr && o.expr.type === 'col') return this.baseColumn(inner.setop ? inner.branches[0] : inner, o.expr, depth + 1);
    return null;
  }

  origins(b, expr, depth = 0) {
    const out = new Set();
    if (!expr || depth > 6) return [];
    walkCount(expr, () => { const base = b.sources && b.sources.find((s) => s.entity === this.grainEntity(b)) || (b.sources || [])[0]; if (base && base.kind === 'table') out.add(`${base.displayName} (row count)`); else if (base) for (const x of this.countOrigins(base)) out.add(x); });
    if (expr.type === 'subquery') {
      const sb = this.blockFor(expr.query);
      if (sb && sb.outputs && sb.outputs[0] && sb.outputs[0].expr) for (const x of this.origins(sb, sb.outputs[0].expr, depth + 1)) out.add(x);
      return [...out];
    }
    for (const c of columnRefs(expr)) {
      const r = this.m.resolve(b, c) || {};
      if (!r.source) { if (r.outputAlias && r.output && r.output.expr) for (const x of this.origins(b, r.output.expr, depth + 1)) out.add(x); continue; }
      if (r.source.kind === 'table') { out.add(`${r.source.displayName}.${r.column}`); continue; }
      const inner = r.source.kind === 'cte' ? r.source.cteBlock : r.source.kind === 'derived' ? r.source.inner : null;
      if (!inner || inner.pending) continue;
      const pick = (blk) => blk.outputs && blk.outputs.find((x) => x.name.toLowerCase() === String(r.column).toLowerCase());
      const blocks = inner.setop ? inner.branches : [inner];
      for (const blk of blocks) {
        const idx = inner.setop ? inner.outputs.findIndex((x) => x.name.toLowerCase() === String(r.column).toLowerCase()) : -1;
        const o = inner.setop ? blk.outputs[idx] : pick(blk);
        if (o && o.expr && !o.star) for (const x of this.origins(blk, o.expr, depth + 1)) out.add(x);
        else if (o && o.star && o.source) out.add(`${o.source.displayName}.${r.column}`);
      }
    }
    return [...out];
  }

  countOrigins(s) {
    const inner = s.kind === 'cte' ? s.cteBlock : s.kind === 'derived' ? s.inner : null;
    if (!inner || !inner.sources || !inner.sources.length) return [];
    const base = inner.sources.find((x) => x.entity === this.grainEntity(inner)) || inner.sources[0];
    return base.kind === 'table' ? [`${base.displayName} (row count)`] : this.countOrigins(base);
  }

  tables() {
    const map = new Map();
    for (const b of this.m.blocks) {
      for (const s of b.sources || []) {
        if (s.kind !== 'table') continue;
        const key = s.displayName.toLowerCase();
        if (!map.has(key)) map.set(key, { name: s.displayName, aliases: new Set(), steps: new Set(), columns: new Set(), purpose: s.table ? s.table.purpose : null, known: s.table ? true : this.m.catalog ? false : null, entity: s.entity, roles: new Set() });
        const t = map.get(key);
        if (s.alias) t.aliases.add(s.alias);
        const sn = this.stepName(b) || this.stepName(enclosingStep(b, this.stepOf));
        if (sn) t.steps.add(sn);
        for (const c of s.used) t.columns.add(c);
        t.roles.add(s.index === 0 ? 'from' : (s.join && s.join.kind ? s.join.kind : 'join'));
      }
    }
    if (this.m.target && this.m.target.name && !map.has(this.m.target.name.toLowerCase()) && this.m.stmt.type !== 'create') {
      const t = this.m.target;
      map.set(t.name.toLowerCase(), { name: t.name, aliases: new Set(), steps: new Set(), columns: new Set(t.columns || []), purpose: t.table ? t.table.purpose : null, known: t.table ? true : this.m.catalog ? false : null, entity: t.entity, roles: new Set(['target']) });
    }
    return [...map.values()].map((t) => ({ ...t, aliases: [...t.aliases], steps: [...t.steps], columns: [...t.columns].filter((c) => c !== '*').sort(), allColumns: t.columns.has('*'), roles: [...t.roles] }));
  }

  // ---------- summary ----------
  title(st) {
    switch (st.type) {
      case 'insert': return `Insert into ${this.m.target.name}`;
      case 'update': return `Update ${this.m.target.name}`;
      case 'delete': return `Delete from ${this.m.target.name}`;
      case 'merge': return `Merge into ${this.m.target.name}`;
      case 'create': return `Create ${this.m.target.kind} ${this.m.target.name}`;
      default: return 'Query';
    }
  }

  summary(st, b, out) {
    const S = [];
    const tables = out.tables.filter((t) => !t.roles.includes('target') || st.type === 'update' || st.type === 'delete');
    const tableList = this.list(tables.map((t) => this.code(t.name)));
    const ctes = this.m.blocks.filter((x) => x.kind === 'cte');
    if (st.type === 'query' || st.type === 'create' || st.type === 'insert') {
      if (st.type === 'create') S.push(`Creates the ${this.m.target.kind} ${this.code(this.m.target.name)}. ${this.m.target.kind === 'table' ? 'It is filled once with' : 'Every time it is read, it returns'} ${out.grain}.`);
      else if (st.type === 'insert') {
        const cols = st.columns ? (st.columns.length > 8 ? ` (${st.columns.length} columns: ${st.columns.slice(0, 4).map((c) => this.code(c)).join(', ')}, …)` : ` (${this.list(st.columns.map((c) => this.code(c)))})`) : '';
        if (st.values) S.push(`Adds ${st.values.rows.length} row${st.values.rows.length === 1 ? '' : 's'} of fixed values to ${this.code(this.m.target.name)}${cols}.`);
        else S.push(`Copies ${/^each different combination/.test(out.grain) ? 'the matching rows, without duplicates,' : String(out.grain).replace(/, once$/, '')} into ${this.code(this.m.target.name)}${cols}.`);
        if (st.conflict) S.push(`If a row already exists, it follows the rule ${this.code(st.conflict.replace(/\s+/g, ' ').slice(0, 80))}.`);
      } else S.push(`Returns ${out.grain}.`);
      if (out.outputs.length && st.type !== 'insert') {
        const desc = out.outputs.slice(0, 6).map((o) => (o.kind === 'all' ? `every column of ${o.name.replace(/\.\*$/, '')}` : `${this.code(o.name)} (${o.text.charAt(0).toLowerCase()}${o.text.slice(1)})`));
        const more = out.outputs.length > 6 ? `, and ${out.outputs.length - 6} more` : '';
        S.push(`Each row has ${out.outputs.length === 1 ? '1 column' : `${out.outputs.length} columns`}: ${desc.join('; ')}${more}.`);
      }
      if (tableList) S.push(`The data comes from ${tableList}${ctes.length ? `, prepared in ${ctes.length} named step${ctes.length === 1 ? '' : 's'} (${this.list(ctes.map((c) => this.code(c.name)))})` : ''}.`);
    } else if (st.type === 'update') {
      const sets = st.set.map((a) => `${this.code(a.columns.map((c) => c.parts[c.parts.length - 1]).join(', '))} to ${this.relativeDate(a.value, b) || this.say(a.value, b)}`);
      const filters = this.filterConds(b);
      S.push(`Changes ${this.list(sets)} in ${this.code(this.m.target.name)}${filters.length ? `, for ${this.plural(this.m.target.entity)} where ${this.list(filters.slice(0, 3).map((c) => this.cond(c, b)))}` : ', for every row in the table'}.`);
      if (b.sources.length > 1) S.push(`It also reads ${this.list(b.sources.filter((s) => s !== this.m.target.source).map((s) => this.code(s.displayName)))} to decide which rows to change or what to set.`);
    } else if (st.type === 'delete') {
      const filters = this.filterConds(b);
      S.push(filters.length ? `Deletes the ${this.plural(this.m.target.entity)} in ${this.code(this.m.target.name)} where ${this.list(filters.slice(0, 3).map((c) => this.cond(c, b)))}.` : `Deletes every row in ${this.code(this.m.target.name)}.`);
      if (b.sources.length > 1) S.push(`It also reads ${this.list(b.sources.filter((s) => s !== this.m.target.source).map((s) => this.code(s.displayName)))} to decide which rows to delete.`);
    } else if (st.type === 'merge') {
      const using = b.sources[1];
      S.push(`Brings the rows of ${using ? this.sourceLabel(using) : 'the source'} into ${this.code(this.m.target.name)}, matching rows where ${this.cond(st.on, b)}.`);
      const acts = st.whens.map((w) => `${w.matched ? 'matches' : 'new rows'} are ${w.action === 'update' ? 'updated' : w.action === 'insert' ? 'inserted' : w.action === 'delete' ? 'deleted' : 'skipped'}`);
      if (acts.length) S.push(`${this.cap(this.list(acts))}.`);
    }
    // filters across blocks (for SELECT-like statements)
    if (!b.dml && b.select) {
      const filters = this.filterConds(b).filter((c) => { const t = this.topPerGroup(b); return !t || t.node !== c; });
      if (filters.length) S.push(`It only includes ${this.rowWord(b)} where ${this.list(filters.slice(0, 4).map((c) => this.cond(c, b)))}${filters.length > 4 ? `, plus ${filters.length - 4} more condition${filters.length - 4 === 1 ? '' : 's'}` : ''}.`);
      if (b.select.having) S.push(`Only groups where ${this.list(conjuncts(b.select.having).slice(0, 3).map((c) => this.cond(c, b)))} are kept.`);
    }
    for (const c of ctes) {
      if (!c.select) continue;
      const f = this.filterConds(c);
      if (f.length) S.push(`In ${this.code(c.name)}, only ${this.plural(this.grainEntity(c) || 'row')} where ${this.list(f.slice(0, 2).map((x) => this.cond(x, c)))} are used.`);
    }
    const ob = b.orderBy && b.orderBy.length ? `sorted by ${this.list(b.orderBy.map((o) => this.orderItem(o, b.setop ? b.branches[0] : b)))}` : '';
    const top = b.select && b.select.top;
    const limit = b.limit || (top && top.n);
    const rn = this.rownumLimit(b);
    const lim = limit ? `only the first ${limit.type === 'lit' ? limit.value : this.say(limit, b)}${top && top.percent ? '%' : ''} are returned` : rn ? `it stops after ${rn.n} rows (ROWNUM)${b.orderBy && b.orderBy.length ? ', which happens before sorting' : ''}` : '';
    if (ob || lim) S.push(`${this.cap([ob ? `Results are ${ob}` : '', lim].filter(Boolean).join(', and '))}.`);
    return S;
  }
}

// ---------- helpers ----------
function walkCount(e, fn) {
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'func' && (n.name === 'COUNT' || n.name === 'COUNT_BIG') && (!n.args.length || n.args[0].type === 'star' || n.args[0].type === 'lit')) fn();
    if (n.type === 'subquery' || n.type === 'exists') return;
    for (const k of ['left', 'right', 'expr', 'operand', 'else', 'low', 'high']) visit(n[k]);
    for (const k of ['args', 'items', 'list']) if (Array.isArray(n[k])) n[k].forEach(visit);
    if (n.whens) n.whens.forEach((w) => { visit(w.when); visit(w.then); });
  };
  visit(e);
}

function isRownum(c) {
  return c && c.type === 'bin' && ['<', '<=', '='].includes(c.op) && [c.left, c.right].some((x) => x && x.type === 'func' && x.name === 'ROWNUM') && [c.left, c.right].some((x) => x && x.type === 'lit');
}

function isFlagName(name) { return /^(is|has|can|should|was|allow|active|enabled|deleted|archived)([_A-Z]|$)|(_ind|_flg|_flag|Flag|Ind)$/i.test(String(name)); }

function flattenConcat(e) { return e.type === 'bin' && e.op === '||' ? [...flattenConcat(e.left), ...flattenConcat(e.right)] : [e]; }
function flattenOr(e) { return e.type === 'bin' && e.op === 'OR' ? [...flattenOr(e.left), ...flattenOr(e.right)] : [e]; }
function dedupe(a) { return [...new Set(a)]; }
function firstSentence(s) { const m = /^(.*?\.)(\s|$)/.exec(String(s).replace(/`/g, '')); return m ? m[1] : String(s); }

/** SUM(CASE WHEN c THEN 1 ELSE 0 END) -> count; SUM(CASE WHEN c THEN x ELSE 0 END) -> value */
function sumCase(e) {
  if (e.whens.length !== 1 || e.operand) return null;
  const w = e.whens[0];
  const zero = !e.else || (e.else.type === 'lit' && (e.else.value === 0 || e.else.kind === 'null'));
  if (!zero) return null;
  if (w.then.type === 'lit' && w.then.value === 1) return { count: true, cond: w.when };
  return { value: w.then, cond: w.when };
}

function numberish(e) {
  if (!e) return false;
  if (e.type === 'func' && (isAggregate(e) || e.over) && !['MIN', 'MAX', 'STRING_AGG', 'LISTAGG', 'GROUP_CONCAT', 'ARRAY_AGG'].includes(e.name)) return true;
  if (e.type === 'bin' && ['+', '-', '*', '/'].includes(e.op)) return true;
  if (e.type === 'col') return /(amount|amt|total|price|cost|qty|quantity|count|cnt|score|rank|revenue|value|balance|sum|avg|rating|number|nbr|num|pct|percent|rate|age|size|weight|probability|salary|_n)$/i.test(e.parts[e.parts.length - 1]);
  return false;
}

/** shipping_address_id -> "shipping address" when it differs from the entity it points to. */
function roleNoun(col, ent) {
  const w = words(col).replace(/\s*\b(id|key|code|no|number)$/, '').trim();
  if (!w || w === 'id') return null;
  return w === ent ? ent : w;
}

function enclosingStep(b, stepOf) {
  for (let x = b.parent; x; x = x.parent) if (stepOf.has(x)) return x;
  return null;
}

export { entityNoun };
