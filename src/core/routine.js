// Functions, procedures and anonymous blocks: PostgreSQL PL/pgSQL (CREATE FUNCTION/PROCEDURE,
// DO $$ ... $$), Oracle PL/SQL (CREATE PROCEDURE/FUNCTION ... IS ... BEGIN ... END;, DECLARE
// blocks) and SQL Server T-SQL (CREATE PROCEDURE ... AS, scripts with DECLARE/SET/IF).
//
// The body is read as an outline (IF / loops / assignments / SQL / RETURN / RAISE ...). Every SQL
// statement inside it is explained and reviewed like a normal query, with the routine's
// parameters and variables recognised as variables (not unknown columns). On top of that come
// checks that only make sense in procedural code: variables used but never set, SQL inside a
// loop that does the same work on every pass, check-then-insert races, conditions that are
// always true, dynamic SQL built by concatenation, and swallowed errors.
import { tokenize, identName } from './tokenize.js';
import { parse, conjuncts, hasAggregate } from './parse.js';
import { buildModel } from './model.js';
import { Speaker } from './explain.js';
import { analyzeStatement, shiftResult, lineOf } from './statement.js';

const SQL_START = new Set(['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'TRUNCATE', 'VALUES']);
const TSQL_START = new Set(['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'SET', 'IF', 'ELSE', 'WHILE', 'BEGIN', 'END', 'DECLARE', 'RETURN', 'PRINT', 'EXEC', 'EXECUTE', 'RAISERROR', 'THROW', 'BREAK', 'CONTINUE', 'GOTO', 'OPEN', 'FETCH', 'CLOSE', 'DEALLOCATE', 'COMMIT', 'ROLLBACK', 'SAVE', 'WAITFOR']);
const PG_IMPLICIT = ['found', 'new', 'old', 'tg_op', 'tg_name', 'tg_when', 'tg_table_name', 'tg_level', 'sqlstate', 'sqlerrm', 'sql'];
const code = (s) => `\`${String(s).replace(/`/g, "'").replace(/\s+/g, ' ').trim()}\``;
const list = (a, conj = 'and') => (a.length <= 1 ? a[0] || '' : a.length === 2 ? `${a[0]} ${conj} ${a[1]}` : `${a.slice(0, -1).join(', ')} ${conj} ${a[a.length - 1]}`);
const plural = (n, w, p = `${w}s`) => `${n} ${n === 1 ? w : p}`;
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

export function analyzeRoutine(st, full, ctx) {
  const dialect = ctx.dialect || 'generic';
  const header = parseHeader(full, st, dialect);
  const sc = new Scanner(full, header.bodyStart, header.bodyEnd, header.style);
  let tree;
  try {
    tree = header.style === 'sql' ? sc.sqlBody() : header.style === 'tsql' ? sc.tsqlBody() : sc.plBody(header.bareDecls);
  } catch (err) {
    tree = { decls: [], body: [], handlers: [], error: err.message };
  }
  const R = new RoutineAnalysis(full, header, tree, sc, { ...ctx, dialect });
  return R.result(st);
}

// ---------------------------------------------------------------- header
function parseHeader(full, st, dialect) {
  const text = full.slice(st.s, st.e);
  const toks = tokenize(text).filter((t) => t.t !== 'comment').map((t) => ({ ...t, s: t.s + st.s, e: t.e + st.s }));
  let i = 0;
  const peek = (k = 0) => toks[Math.min(i + k, toks.length - 1)];
  const isW = (u, k = 0) => peek(k).t === 'word' && (Array.isArray(u) ? u.includes(peek(k).u) : peek(k).u === u);
  const h = { kind: 'block', name: null, params: [], returns: null, language: null, style: dialect === 'sqlserver' ? 'tsql' : 'pl', bodyStart: st.s, bodyEnd: st.e, bareDecls: false, options: [] };
  if (isW('CREATE')) {
    i++;
    while (isW(['OR', 'REPLACE', 'ALTER', 'EDITIONABLE', 'NONEDITIONABLE', 'CONSTRAINT', 'AGGREGATE'])) i++;
    if (isW('DEFINER')) { i++; while (peek().t !== 'word' || !['FUNCTION', 'PROCEDURE', 'PROC', 'TRIGGER'].includes(peek().u)) i++; }
    h.kind = peek().u === 'PROC' ? 'procedure' : String(peek().v).toLowerCase();
    i++;
    if (isW('BODY')) { h.kind += ' body'; i++; }
    if (isW('IF') && isW('NOT', 1)) i += 3;
    const nameParts = [];
    while (peek().t === 'word' || peek().t === 'qid') { nameParts.push(identName(peek())); i++; if (peek().t === '.') i++; else break; }
    h.name = nameParts.join('.');
    // parameters
    if (peek().t === '(') {
      const open = i;
      let depth = 0;
      do { if (peek().t === '(') depth++; if (peek().t === ')') depth--; i++; } while (depth > 0 && peek().t !== 'eof');
      h.params = splitParams(toks.slice(open + 1, i - 1), full);
    } else if (peek().t === 'param') {
      // T-SQL: CREATE PROCEDURE p @a INT, @b INT = 1 OUTPUT AS
      const start = i;
      while (!(isW('AS') || isW('WITH')) && peek().t !== 'eof') i++;
      h.params = splitParams(toks.slice(start, i), full);
    }
    // options before the body
    while (peek().t !== 'eof') {
      const t = peek();
      if (t.t === 'str' && i > 0 && (toks[i - 1].t === 'word' && toks[i - 1].u === 'AS' || t.dollar)) {
        h.style = 'pg';
        const tag = t.dollar ? /^\$[A-Za-z_]*\$/.exec(t.v)[0] : "'";
        h.bodyStart = t.s + tag.length;
        h.bodyEnd = t.e - tag.length;
        i++;
        continue;
      }
      if (t.t === 'word') {
        if (t.u === 'RETURNS' || (t.u === 'RETURN' && h.style !== 'pg')) {
          i++;
          const s0 = peek().s;
          let depth = 0;
          while (peek().t !== 'eof') {
            const x = peek();
            if (x.t === '(') depth++;
            if (x.t === ')') depth--;
            if (depth === 0 && x.t === 'word' && ['LANGUAGE', 'AS', 'IS', 'IMMUTABLE', 'STABLE', 'VOLATILE', 'STRICT', 'SECURITY', 'COST', 'ROWS', 'PARALLEL', 'SET', 'CALLED', 'WINDOW', 'LEAKPROOF', 'DETERMINISTIC', 'PIPELINED', 'RESULT_CACHE', 'AUTHID', 'WITH', 'BEGIN', 'EXTERNAL'].includes(x.u)) break;
            if (depth === 0 && x.t === 'str') break;
            i++;
          }
          h.returns = oneLine(full.slice(s0, toks[i - 1].e));
          continue;
        }
        if (t.u === 'LANGUAGE') { i++; h.language = String(identName(peek())).toLowerCase().replace(/'/g, ''); i++; continue; }
        if ((t.u === 'IS' || t.u === 'AS') && h.style !== 'pg' && !(peek(1).t === 'str')) {
          i++;
          h.bodyStart = peek().s;
          h.bodyEnd = st.e;
          h.style = dialect === 'sqlserver' || h.params.some((p) => /^@/.test(p.name)) ? 'tsql' : 'pl';
          h.bareDecls = h.style === 'pl';
          break;
        }
        if (['IMMUTABLE', 'STABLE', 'VOLATILE', 'STRICT', 'LEAKPROOF', 'PARALLEL', 'SECURITY', 'DETERMINISTIC'].includes(t.u)) h.options.push(t.u);
      }
      i++;
    }
    if (h.style === 'pg' && h.language === 'sql') h.style = 'sql';
  } else if (isW('DO')) {
    h.kind = 'anonymous block';
    for (const t of toks) if (t.t === 'str') { const tag = t.dollar ? /^\$[A-Za-z_]*\$/.exec(t.v)[0] : "'"; h.bodyStart = t.s + tag.length; h.bodyEnd = t.e - tag.length; h.style = 'pl'; break; }
    const lang = /LANGUAGE\s+(\w+)/i.exec(text);
    h.language = lang ? lang[1].toLowerCase() : 'plpgsql';
  } else {
    h.kind = dialect === 'sqlserver' ? 'script' : 'anonymous block';
  }
  if (!h.language) h.language = h.style === 'tsql' ? 'T-SQL' : h.style === 'pl' ? (dialect === 'oracle' || (h.bareDecls && dialect !== 'postgres') ? 'PL/SQL' : 'plpgsql') : h.style === 'sql' ? 'sql' : null;
  return h;
}

function splitParams(toks, full) {
  const out = [];
  let cur = [];
  let depth = 0;
  const flush = () => {
    if (!cur.length) return;
    const txt = oneLine(full.slice(cur[0].s, cur[cur.length - 1].e));
    const words = cur.filter((t) => t.t === 'word' || t.t === 'qid' || t.t === 'param');
    let mode = 'IN';
    let k = 0;
    if (words[k] && words[k].t === 'word' && ['IN', 'OUT', 'INOUT', 'VARIADIC'].includes(words[k].u)) { mode = words[k].u; k++; }
    const nameTok = words[k];
    let name = nameTok ? (nameTok.t === 'param' ? nameTok.v : identName(nameTok)) : txt;
    let rest = txt.slice(txt.indexOf(nameTok ? nameTok.v : '') + (nameTok ? nameTok.v.length : 0)).trim();
    // Oracle: name IN OUT type
    const m = /^(IN\s+OUT|IN|OUT|NOCOPY)\b\s*/i.exec(rest);
    if (m) { mode = m[1].toUpperCase().replace(/\s+/, ' '); rest = rest.slice(m[0].length); }
    if (/\bOUTPUT\b|\bOUT\b$/i.test(rest)) mode = 'OUT';
    const def = /\s*(?:DEFAULT|:=|=)\s*(.+)$/i.exec(rest);
    const type = def ? rest.slice(0, def.index).trim() : rest.replace(/\bOUTPUT\b/i, '').trim();
    // unnamed PostgreSQL parameter (just a type) -> $1
    if (!type && nameTok && nameTok.t !== 'param') { name = `$${out.length + 1}`; }
    out.push({ name, mode, type: type || txt, default: def ? def[1] : null, s: cur[0].s, e: cur[cur.length - 1].e });
    cur = [];
  };
  for (const t of toks) {
    if (t.t === '(') depth++;
    if (t.t === ')') depth--;
    if (t.t === ',' && depth === 0) { flush(); continue; }
    cur.push(t);
  }
  flush();
  return out;
}

// ---------------------------------------------------------------- body scanner
class Scanner {
  constructor(full, start, end, style) {
    this.full = full;
    this.style = style;
    const txt = full.slice(start, end);
    this.all = tokenize(txt).map((t) => ({ ...t, s: t.s + start, e: t.e + start }));
    this.toks = this.all.filter((t) => t.t !== 'comment' && !(t.t === ';' && t.batch && style !== 'tsql'));
    this.i = 0;
    this.start = start;
    this.end = end;
  }

  peek(k = 0) { return this.toks[Math.min(this.i + k, this.toks.length - 1)]; }
  next() { const t = this.toks[this.i]; if (this.i < this.toks.length - 1) this.i++; return t; }
  prev() { return this.toks[Math.max(0, this.i - 1)]; }
  isW(u, k = 0) { const t = this.peek(k); return t.t === 'word' && (Array.isArray(u) ? u.includes(t.u) : t.u === u); }
  eof() { return this.peek().t === 'eof'; }
  acceptW(...u) { return this.isW(u) ? this.next() : null; }
  expectW(u) { if (!this.acceptW(u)) throw new Error(`expected ${u} near line ${lineOf(this.full, this.peek().s)} but found "${this.peek().v || 'end'}"`); }
  acceptSemi() { if (this.peek().t === ';' && !this.peek().batch) this.next(); }
  range(a, b) { return { s: a, e: b, text: this.full.slice(a, b) }; }

  /** Tokens until a stop word at depth 0 (not consumed). */
  until(stop) {
    const s0 = this.peek().s;
    let depth = 0;
    let caseDepth = 0;
    let last = null;
    while (!this.eof()) {
      const t = this.peek();
      if (depth === 0 && caseDepth === 0 && stop(t, this)) break;
      if (t.t === '(') depth++;
      if (t.t === ')') { if (depth === 0) break; depth--; }
      if (t.t === 'word' && t.u === 'CASE') caseDepth++;
      if (t.t === 'word' && t.u === 'END' && caseDepth > 0) caseDepth--;
      last = this.next();
    }
    return last ? this.range(s0, last.e) : this.range(s0, s0);
  }

  untilSemi() {
    const r = this.until((t) => t.t === ';');
    this.acceptSemi();
    return r;
  }

  node(k, startTok, props) { return { k, s: startTok.s, e: this.prev().e, line: lineOf(this.full, startTok.s), ...props }; }

  // ---- PL/pgSQL & PL/SQL ----
  plBody(bareDecls) {
    while (this.peek().t === 'op' && this.peek().v === '<<') this.label();
    if (this.isW(['DECLARE', 'BEGIN']) || bareDecls) return this.block(bareDecls);
    // body without BEGIN (unusual): read statements
    return { decls: [], body: this.stmtList(() => false), handlers: [] };
  }

  label() { this.next(); while (!this.eof() && !(this.peek().t === 'op' && this.peek().v === '>>')) this.next(); this.next(); }

  block(bareDecls) {
    const start = this.peek();
    let decls = [];
    if (this.acceptW('DECLARE') || bareDecls) decls = this.decls();
    this.expectW('BEGIN');
    const body = this.stmtList((t) => t.t === 'word' && (t.u === 'END' || t.u === 'EXCEPTION'));
    const handlers = [];
    if (this.acceptW('EXCEPTION')) {
      while (this.acceptW('WHEN')) {
        const hs = this.prev();
        const cond = this.until((t) => t.t === 'word' && t.u === 'THEN');
        this.expectW('THEN');
        const hbody = this.stmtList((t) => t.t === 'word' && (t.u === 'WHEN' || t.u === 'END'));
        handlers.push({ cond, body: hbody, line: lineOf(this.full, hs.s), s: hs.s, e: this.prev().e });
      }
    }
    this.expectW('END');
    if ((this.peek().t === 'word' || this.peek().t === 'qid') && !this.isW(['IF', 'LOOP'])) this.next();
    this.acceptSemi();
    return { decls, body, handlers, s: start.s, e: this.prev().e };
  }

  decls() {
    const out = [];
    while (!this.eof() && !this.isW('BEGIN')) {
      const t = this.peek();
      if (t.t === 'op' && t.v === '<<') { this.label(); continue; }
      if (this.isW('DECLARE')) { this.next(); continue; }
      if (this.isW(['TYPE', 'SUBTYPE', 'PRAGMA'])) { const r = this.untilSemi(); out.push({ k: 'decl-other', ...r, line: lineOf(this.full, r.s) }); continue; }
      if (this.isW('CURSOR')) {
        // Oracle: CURSOR c [(args)] IS SELECT ...;
        this.next();
        const name = identName(this.next());
        if (this.peek().t === '(') this.until((x) => x.t === 'word' && (x.u === 'IS' || x.u === 'FOR'));
        this.acceptW('IS', 'FOR');
        const q = this.untilSemi();
        out.push({ k: 'cursor', name, query: q, s: t.s, e: q.e, line: lineOf(this.full, t.s) });
        continue;
      }
      if (this.isW(['PROCEDURE', 'FUNCTION'])) {
        // nested subprogram: skip it as a unit
        const s0 = t.s;
        this.until((x) => x.t === ';' || (x.t === 'word' && (x.u === 'IS' || x.u === 'AS')));
        if (this.acceptW('IS', 'AS')) this.block(true); else this.acceptSemi();
        out.push({ k: 'decl-other', s: s0, e: this.prev().e, text: this.full.slice(s0, this.prev().e), line: lineOf(this.full, s0) });
        continue;
      }
      const nameTok = this.next();
      const name = identName(nameTok);
      if (this.isW('CURSOR') || (this.isW('NO') && this.isW('SCROLL', 1)) || this.isW('SCROLL')) {
        while (!this.isW(['FOR', 'IS']) && !this.eof()) this.next();
        this.next();
        const q = this.untilSemi();
        out.push({ k: 'cursor', name, query: q, s: nameTok.s, e: q.e, line: lineOf(this.full, nameTok.s) });
        continue;
      }
      if (this.isW('ALIAS') && this.isW('FOR', 1)) { this.next(); this.next(); const r = this.untilSemi(); out.push({ k: 'decl', name, type: `alias for ${r.text}`, default: r.text, alias: true, s: nameTok.s, e: r.e, line: lineOf(this.full, nameTok.s) }); continue; }
      const constant = !!this.acceptW('CONSTANT');
      const typeR = this.until((x) => x.t === ';' || (x.t === 'op' && (x.v === ':=' || x.v === '=')) || (x.t === 'word' && x.u === 'DEFAULT'));
      let def = null;
      if ((this.peek().t === 'op' && (this.peek().v === ':=' || this.peek().v === '=')) || this.isW('DEFAULT')) { this.next(); def = this.until((x) => x.t === ';'); }
      this.acceptSemi();
      out.push({ k: 'decl', name, type: oneLine(typeR.text.replace(/\bNOT\s+NULL\b/i, '')), notNull: /\bNOT\s+NULL\b/i.test(typeR.text), constant, default: def ? def.text : null, defaultRange: def, nameTok, s: nameTok.s, e: this.prev().e, line: lineOf(this.full, nameTok.s) });
    }
    return out;
  }

  stmtList(stop) {
    const out = [];
    let guard = 0;
    while (!this.eof() && !stop(this.peek())) {
      const before = this.i;
      const n = this.stmt();
      if (n) out.push(n);
      if (this.i === before) this.next();
      if (++guard > 20000) break;
    }
    return out;
  }

  stmt() {
    const t = this.peek();
    if (t.t === ';') { this.next(); return null; }
    if (t.t === 'op' && t.v === '<<') { this.label(); return null; }
    if (t.t === 'word') {
      switch (t.u) {
        case 'IF': return this.ifStmt();
        case 'CASE': return this.caseStmt();
        case 'FOR': return this.forStmt();
        case 'FOREACH': return this.foreachStmt();
        case 'WHILE': return this.whileStmt();
        case 'LOOP': { this.next(); const body = this.loopBody(); return this.node('loop', t, { kind: 'loop', body }); }
        case 'EXIT': case 'CONTINUE': {
          this.next();
          if ((this.peek().t === 'word' && this.peek().u !== 'WHEN') || this.peek().t === 'qid') this.next();
          let cond = null;
          if (this.acceptW('WHEN')) cond = this.until((x) => x.t === ';');
          this.acceptSemi();
          return this.node('exit', t, { kind: t.u, cond });
        }
        case 'RETURN': {
          this.next();
          if (this.acceptW('QUERY')) {
            if (this.acceptW('EXECUTE')) { const r = this.untilSemi(); return this.node('exec', t, { expr: r, returnsQuery: true }); }
            const q = this.untilSemi();
            return this.node('sql', t, { sql: q, purpose: 'return-query' });
          }
          if (this.acceptW('NEXT')) { const r = this.untilSemi(); return this.node('return', t, { kind: 'next', expr: r }); }
          const r = this.untilSemi();
          return this.node('return', t, { kind: r.text.trim() ? 'value' : 'void', expr: r });
        }
        case 'RAISE': {
          this.next();
          let level = 'EXCEPTION';
          if (this.isW(['NOTICE', 'EXCEPTION', 'WARNING', 'INFO', 'LOG', 'DEBUG'])) level = this.next().u;
          const r = this.untilSemi();
          return this.node('raise', t, { level, msg: r });
        }
        case 'PERFORM': { this.next(); const q = this.untilSemi(); return this.node('sql', t, { sql: q, purpose: 'perform', prefix: 'SELECT ' }); }
        case 'EXECUTE': {
          this.next();
          this.acceptW('IMMEDIATE');
          const expr = this.until((x) => x.t === ';' || (x.t === 'word' && (x.u === 'INTO' || x.u === 'USING')));
          let into = null;
          let using = null;
          if (this.acceptW('INTO')) { this.acceptW('STRICT'); into = this.until((x) => x.t === ';' || (x.t === 'word' && x.u === 'USING')); }
          if (this.acceptW('USING')) using = this.until((x) => x.t === ';');
          this.acceptSemi();
          return this.node('exec', t, { expr, into, using });
        }
        case 'OPEN': {
          this.next();
          const name = identName(this.next());
          let q = null;
          if (this.acceptW('FOR')) { if (this.acceptW('EXECUTE')) { const r = this.untilSemi(); return this.node('exec', t, { expr: r, cursor: name }); } q = this.untilSemi(); } else this.untilSemi();
          return q ? this.node('sql', t, { sql: q, purpose: 'open-cursor', cursor: name }) : this.node('cursor', t, { op: 'open', name });
        }
        case 'FETCH': { this.next(); const r = this.untilSemi(); const m = /\bINTO\s+([\s\S]+)$/i.exec(r.text); return this.node('cursor', t, { op: 'fetch', into: m ? m[1].split(',').map((x) => x.trim()) : [], text: r.text }); }
        case 'CLOSE': { this.next(); const r = this.untilSemi(); return this.node('cursor', t, { op: 'close', name: r.text.trim() }); }
        case 'COMMIT': case 'ROLLBACK': case 'SAVEPOINT': case 'RELEASE': { this.next(); const r = this.untilSemi(); return this.node('tx', t, { op: t.u, text: oneLine(`${t.u} ${r.text}`) }); }
        case 'NULL': { this.next(); this.acceptSemi(); return this.node('null', t, {}); }
        case 'GET': {
          this.next();
          this.acceptW('CURRENT', 'STACKED');
          this.acceptW('DIAGNOSTICS');
          const r = this.untilSemi();
          const targets = r.text.split(',').map((x) => x.split(/:=|=/)[0].trim()).filter(Boolean);
          return this.node('diag', t, { targets, text: r.text });
        }
        case 'DECLARE': case 'BEGIN': {
          if (t.u === 'BEGIN' && this.isW(['TRANSACTION', 'WORK'], 1)) { this.next(); const r = this.untilSemi(); return this.node('tx', t, { op: 'BEGIN', text: oneLine(`BEGIN ${r.text}`) }); }
          const b = this.block(false);
          return { k: 'block', ...b, line: lineOf(this.full, t.s) };
        }
        default: break;
      }
      if (SQL_START.has(t.u)) { const q = this.untilSemi(); return this.node('sql', t, { sql: q, purpose: 'stmt' }); }
    }
    // assignment: target := expr  (PL/pgSQL also allows target = expr)
    if (t.t === 'word' || t.t === 'qid') {
      let k = 1;
      while (this.peek(k).t === '.' || (this.peek(k).t === 'op' && (this.peek(k).v === '[' || this.peek(k).v === ']')) || this.peek(k).t === 'num' || ((this.peek(k).t === 'word' || this.peek(k).t === 'qid') && this.peek(k - 1).t === '.')) k++;
      const op = this.peek(k);
      if (op.t === 'op' && (op.v === ':=' || op.v === '=')) {
        const targetEnd = this.peek(k - 1).e;
        const target = oneLine(this.full.slice(t.s, targetEnd));
        for (let x = 0; x <= k; x++) this.next();
        const expr = this.untilSemi();
        return this.node('assign', t, { target, targetTok: t, expr });
      }
      // procedure call / output: name(...); pkg.proc(...);
      const r = this.untilSemi();
      const name = oneLine(r.text.split('(')[0]);
      if (/^(dbms_output\.put_line|dbms_output\.put|raise_application_error)$/i.test(name)) return this.node('raise', t, { level: /raise_application_error/i.test(name) ? 'EXCEPTION' : 'NOTICE', msg: r, oracle: true });
      return this.node('call', t, { name, text: r.text });
    }
    const r = this.untilSemi();
    return this.node('other', t, { text: r.text });
  }

  loopBody() {
    const body = this.stmtList((x) => x.t === 'word' && x.u === 'END');
    this.expectW('END');
    this.acceptW('LOOP');
    if (this.peek().t === 'word' && this.peek().t !== ';') { if (!this.isW(['END', 'IF', 'ELSE', 'ELSIF', 'ELSEIF', 'WHEN', 'EXCEPTION'])) { const nx = this.peek(1); if (nx.t === ';') this.next(); } }
    this.acceptSemi();
    return body;
  }

  ifStmt() {
    const t = this.next();
    const branches = [];
    let cond = this.until((x) => x.t === 'word' && x.u === 'THEN');
    this.expectW('THEN');
    const stops = (x) => x.t === 'word' && ['ELSIF', 'ELSEIF', 'ELSE', 'END'].includes(x.u);
    branches.push({ cond, body: this.stmtList(stops) });
    while (this.isW(['ELSIF', 'ELSEIF'])) {
      this.next();
      cond = this.until((x) => x.t === 'word' && x.u === 'THEN');
      this.expectW('THEN');
      branches.push({ cond, body: this.stmtList(stops) });
    }
    if (this.acceptW('ELSE')) branches.push({ cond: null, body: this.stmtList((x) => x.t === 'word' && x.u === 'END') });
    this.expectW('END');
    this.acceptW('IF');
    this.acceptSemi();
    return this.node('if', t, { branches });
  }

  caseStmt() {
    const t = this.next();
    const subject = this.isW('WHEN') ? null : this.until((x) => x.t === 'word' && x.u === 'WHEN');
    const branches = [];
    while (this.acceptW('WHEN')) {
      const v = this.until((x) => x.t === 'word' && x.u === 'THEN');
      this.expectW('THEN');
      const body = this.stmtList((x) => x.t === 'word' && ['WHEN', 'ELSE', 'END'].includes(x.u));
      branches.push({ cond: subject ? { s: v.s, e: v.e, text: `${subject.text} = ${v.text}`, synthetic: true } : v, body });
    }
    if (this.acceptW('ELSE')) branches.push({ cond: null, body: this.stmtList((x) => x.t === 'word' && x.u === 'END') });
    this.expectW('END');
    this.acceptW('CASE');
    this.acceptSemi();
    return this.node('if', t, { branches, wasCase: true });
  }

  forStmt() {
    const t = this.next();
    const vars = [];
    do { vars.push(identName(this.next())); } while (this.peek().t === ',' && this.next());
    this.expectW('IN');
    this.acceptW('REVERSE');
    let kind;
    let source;
    if (this.peek().t === '(' && (this.isW(['SELECT', 'WITH'], 1))) {
      this.next();
      source = this.until(() => false);
      this.next(); // )
      kind = 'query';
      this.acceptW('LOOP');
    } else if (this.isW(['SELECT', 'WITH'])) {
      source = this.until((x) => x.t === 'word' && x.u === 'LOOP');
      kind = 'query';
      this.expectW('LOOP');
    } else if (this.isW('EXECUTE')) {
      this.next();
      source = this.until((x) => x.t === 'word' && x.u === 'LOOP');
      kind = 'dynamic';
      this.expectW('LOOP');
    } else {
      source = this.until((x) => x.t === 'word' && x.u === 'LOOP');
      kind = /\.\./.test(source.text) ? 'range' : 'cursor';
      this.expectW('LOOP');
    }
    const body = this.loopBody();
    return this.node('loop', t, { kind: `for-${kind}`, vars, source, body });
  }

  foreachStmt() {
    const t = this.next();
    const v = identName(this.next());
    if (this.acceptW('SLICE')) this.next();
    this.expectW('IN');
    this.acceptW('ARRAY');
    const source = this.until((x) => x.t === 'word' && x.u === 'LOOP');
    this.expectW('LOOP');
    const body = this.loopBody();
    return this.node('loop', t, { kind: 'foreach', vars: [v], source, body });
  }

  whileStmt() {
    const t = this.next();
    const cond = this.until((x) => x.t === 'word' && x.u === 'LOOP');
    this.expectW('LOOP');
    const body = this.loopBody();
    return this.node('loop', t, { kind: 'while', cond, body });
  }

  // ---- LANGUAGE sql: plain statements separated by ';' ----
  sqlBody() {
    const body = [];
    while (!this.eof()) {
      const t = this.peek();
      if (t.t === ';') { this.next(); continue; }
      const q = this.untilSemi();
      body.push({ k: 'sql', sql: q, purpose: 'stmt', s: q.s, e: q.e, line: lineOf(this.full, q.s) });
    }
    return { decls: [], body, handlers: [] };
  }

  // ---- T-SQL ----
  tsqlBody() {
    const body = this.tList(() => false);
    return { decls: [], body, handlers: [] };
  }

  tList(stop) {
    const out = [];
    let guard = 0;
    while (!this.eof() && !stop(this.peek())) {
      const before = this.i;
      const n = this.tStmt();
      if (Array.isArray(n)) out.push(...n); else if (n) out.push(n);
      if (this.i === before) this.next();
      if (++guard > 20000) break;
    }
    return out;
  }

  /** End of a T-SQL statement: ';', or the next statement keyword at the start of a line. */
  tEnd(kind) {
    const s0 = this.peek().s;
    let depth = 0;
    let caseDepth = 0;
    let last = null;
    let seenSelect = false;
    let seenSet = false;
    while (!this.eof()) {
      const t = this.peek();
      if (depth === 0 && caseDepth === 0) {
        if (t.t === ';') { this.next(); break; }
        if (t.t === 'word' && (last || ['END', 'ELSE'].includes(t.u) || (TSQL_START.has(t.u) && t.nl > 0 && kind === 'RETURN'))) {
          const prevU = last && last.t === 'word' ? last.u : null;
          const isNew = t.u === 'ELSE' || t.u === 'END' || (TSQL_START.has(t.u) && t.nl > 0);
          let exception = false;
          if (t.u === 'SELECT' || t.u === 'WITH' || t.u === 'VALUES') exception = (kind === 'INSERT' && !seenSelect) || ['UNION', 'ALL', 'EXCEPT', 'INTERSECT', 'AS'].includes(prevU) || (last && last.t === '(');
          if (t.u === 'SET') exception = kind === 'UPDATE' && !seenSet;
          if (t.u === 'WITH') exception = exception || this.peek(1).t === '(';
          if (t.u === 'FETCH') exception = ['ROWS', 'ROW'].includes(prevU);
          if ((t.u === 'UPDATE' || t.u === 'DELETE' || t.u === 'INSERT') && prevU === 'THEN') exception = true;
          if (isNew && !exception) break;
        }
      }
      if (t.t === '(') depth++;
      if (t.t === ')') depth--;
      if (t.t === 'word' && t.u === 'CASE') caseDepth++;
      if (t.t === 'word' && t.u === 'END' && caseDepth > 0) caseDepth--;
      if (t.t === 'word' && (t.u === 'SELECT' || t.u === 'VALUES')) seenSelect = true;
      if (t.t === 'word' && t.u === 'SET') seenSet = true;
      last = this.next();
      if (depth < 0) break;
    }
    const e = last ? last.e : s0;
    return this.range(s0, e);
  }

  tCond() {
    // condition after IF / WHILE: until BEGIN or a statement keyword at depth 0
    const s0 = this.peek().s;
    let depth = 0;
    let last = null;
    while (!this.eof()) {
      const t = this.peek();
      if (depth === 0 && t.t === 'word' && (t.u === 'BEGIN' || (TSQL_START.has(t.u) && t.u !== 'SELECT' && t.u !== 'WITH') || ((t.u === 'SELECT' || t.u === 'WITH') && last && last.t !== '(' && last.t !== 'op' && !(last.t === 'word' && ['EXISTS', 'IN', 'NOT', 'AND', 'OR'].includes(last.u))))) break;
      if (t.t === '(') depth++;
      if (t.t === ')') depth--;
      last = this.next();
    }
    return this.range(s0, last ? last.e : s0);
  }

  tStmt() {
    const t = this.peek();
    if (t.t === ';') { this.next(); return null; }
    if (t.t === 'word') {
      switch (t.u) {
        case 'BEGIN': {
          this.next();
          if (this.isW(['TRAN', 'TRANSACTION', 'DISTRIBUTED'])) { const r = this.tEnd('TX'); return this.node('tx', t, { op: 'BEGIN', text: oneLine(`BEGIN ${r.text}`) }); }
          if (this.acceptW('TRY')) {
            const body = this.tList((x) => x.t === 'word' && x.u === 'END' && this.isW('TRY', 1));
            this.expectW('END'); this.acceptW('TRY');
            let handlers = [];
            if (this.isW('BEGIN') && this.isW('CATCH', 1)) {
              const hs = this.next(); this.next();
              const hb = this.tList((x) => x.t === 'word' && x.u === 'END' && this.isW('CATCH', 1));
              this.expectW('END'); this.acceptW('CATCH');
              handlers = [{ cond: { text: 'any error', s: hs.s, e: hs.e }, body: hb, line: lineOf(this.full, hs.s), s: hs.s, e: this.prev().e }];
            }
            this.acceptSemi();
            return { k: 'block', decls: [], body, handlers, s: t.s, e: this.prev().e, line: lineOf(this.full, t.s), tryCatch: true };
          }
          const body = this.tList((x) => x.t === 'word' && x.u === 'END');
          this.expectW('END');
          this.acceptSemi();
          return { k: 'block', decls: [], body, handlers: [], s: t.s, e: this.prev().e, line: lineOf(this.full, t.s) };
        }
        case 'IF': {
          this.next();
          const cond = this.tCond();
          const then = this.tStmt();
          const branches = [{ cond, body: [].concat(then || []) }];
          this.acceptSemi();
          if (this.acceptW('ELSE')) {
            const els = this.tStmt();
            if (els && els.k === 'if' && !els.wasElse) branches.push(...els.branches);
            else branches.push({ cond: null, body: [].concat(els || []) });
          }
          return this.node('if', t, { branches });
        }
        case 'WHILE': {
          this.next();
          const cond = this.tCond();
          const body = this.tStmt();
          return this.node('loop', t, { kind: 'while', cond, body: [].concat(body || []) });
        }
        case 'DECLARE': {
          this.next();
          const out = [];
          for (;;) {
            const nameTok = this.next();
            const name = nameTok.v;
            if (this.isW('CURSOR')) {
              while (!this.isW('FOR') && !this.eof()) this.next();
              this.next();
              const q = this.tEnd('SELECT');
              out.push({ k: 'cursor', name, query: q, s: nameTok.s, e: q.e, line: lineOf(this.full, nameTok.s), tsql: true });
              return out;
            }
            this.acceptW('AS');
            const typeR = this.until((x) => x.t === ',' || x.t === ';' || (x.t === 'op' && x.v === '=') || (x.t === 'word' && TSQL_START.has(x.u) && x.nl > 0));
            let def = null;
            if (this.peek().t === 'op' && this.peek().v === '=') { this.next(); def = this.until((x) => x.t === ',' || x.t === ';' || (x.t === 'word' && TSQL_START.has(x.u) && x.nl > 0)); }
            out.push({ k: 'decl', name, type: oneLine(typeR.text), default: def ? def.text : null, defaultRange: def, nameTok, s: nameTok.s, e: this.prev().e, line: lineOf(this.full, nameTok.s), tsql: true });
            if (this.peek().t === ',') { this.next(); continue; }
            break;
          }
          this.acceptSemi();
          return out;
        }
        case 'SET': {
          if (this.peek(1).t === 'param') {
            this.next();
            const target = this.next();
            const op = this.next();
            const expr = this.tEnd('SET');
            return this.node('assign', t, { target: target.v, targetTok: target, op: op.v, expr });
          }
          const r = this.tEnd('OPTION');
          return this.node('option', t, { text: oneLine(r.text) });
        }
        case 'RETURN': { this.next(); const r = this.tEnd('RETURN'); return this.node('return', t, { kind: r.text.trim() ? 'value' : 'void', expr: r }); }
        case 'PRINT': { this.next(); const r = this.tEnd('PRINT'); return this.node('raise', t, { level: 'NOTICE', msg: r }); }
        case 'RAISERROR': case 'THROW': { this.next(); const r = this.tEnd('RAISE'); return this.node('raise', t, { level: 'EXCEPTION', msg: r }); }
        case 'EXEC': case 'EXECUTE': {
          this.next();
          if (this.peek().t === '(') { const r = this.tEnd('EXEC'); return this.node('exec', t, { expr: r }); }
          const r = this.tEnd('EXEC');
          if (/^\s*(sp_executesql|sys\.sp_executesql)\b/i.test(r.text)) {
            const arg = /^\s*\S+\s+([^,]+)/.exec(r.text);
            return this.node('exec', t, { expr: { text: arg ? arg[1] : r.text, s: r.s, e: r.e }, using: r });
          }
          return this.node('call', t, { name: oneLine(r.text.split(/\s|\(/)[0]), text: r.text });
        }
        case 'BREAK': case 'CONTINUE': { this.next(); this.acceptSemi(); return this.node('exit', t, { kind: t.u === 'BREAK' ? 'EXIT' : 'CONTINUE' }); }
        case 'OPEN': case 'CLOSE': case 'DEALLOCATE': { this.next(); const r = this.tEnd('CUR'); return this.node('cursor', t, { op: t.u.toLowerCase(), name: r.text.trim() }); }
        case 'FETCH': { this.next(); const r = this.tEnd('FETCH'); const m = /\bINTO\s+([\s\S]+)$/i.exec(r.text); return this.node('cursor', t, { op: 'fetch', into: m ? m[1].split(',').map((x) => x.trim()) : [], text: r.text }); }
        case 'COMMIT': case 'ROLLBACK': case 'SAVE': { this.next(); const r = this.tEnd('TX'); return this.node('tx', t, { op: t.u, text: oneLine(`${t.u} ${r.text}`) }); }
        case 'GOTO': case 'WAITFOR': { this.next(); const r = this.tEnd('X'); return this.node('other', t, { text: `${t.u} ${r.text}` }); }
        default: break;
      }
      if (SQL_START.has(t.u)) { const q = this.tEnd(t.u); return this.node('sql', t, { sql: q, purpose: 'stmt' }); }
      if (this.peek(1).t === 'op' && this.peek(1).v === ':') { this.next(); this.next(); return null; } // label:
    }
    const r = this.tEnd('X');
    return this.node('other', t, { text: r.text });
  }
}

// ---------------------------------------------------------------- analysis
class RoutineAnalysis {
  constructor(full, header, tree, scanner, ctx) {
    this.full = full;
    this.h = header;
    this.tree = tree;
    this.sc = scanner;
    this.ctx = ctx;
    this.embedded = [];
    this.findings = [];
    this.counts = { sql: 0, raise: 0, assign: 0 };
    this.vars = new Map(); // lower name -> { name, kind: 'param'|'var'|'loop'|'cursor', decl, assigned: [], line }
    this.collectVars();
    this.varSet = new Set([...this.vars.keys(), ...(header.style === 'tsql' ? [] : PG_IMPLICIT)]);
  }

  collectVars() {
    const add = (name, kind, extra = {}) => {
      const k = String(name).toLowerCase();
      if (!this.vars.has(k)) this.vars.set(k, { name, kind, assigned: [], reads: 0, ...extra });
    };
    for (const p of this.h.params) add(p.name, 'param', { param: p, line: lineOf(this.full, p.s) });
    const visit = (nodes) => {
      for (const n of nodes || []) {
        if (n.k === 'decl') add(n.name, 'var', { decl: n, line: n.line, hasDefault: !!n.default });
        if (n.k === 'cursor' && n.name) add(n.name, 'cursor', { decl: n, line: n.line, hasDefault: true });
        if (n.k === 'loop' && n.vars) for (const v of n.vars) add(v, 'loop', { line: n.line, hasDefault: true });
        if (n.k === 'block') { visit(n.decls); visit(n.body); for (const hd of n.handlers || []) visit(hd.body); }
        if (n.k === 'if') for (const br of n.branches) visit(br.body);
        if (n.k === 'loop') visit(n.body);
      }
    };
    visit(this.tree.decls);
    visit(this.tree.body);
    for (const hd of this.tree.handlers || []) visit(hd.body);
  }

  // ---- phrasing helpers (reuse the query explainer on small snippets) ----
  speakerFor(sqlText) {
    const p = parse(sqlText, { dialect: this.ctx.dialect === 'generic' ? 'auto' : this.ctx.dialect });
    const st = p.statements[0];
    if (!st || st.type !== 'query') return null;
    const m = buildModel(st, this.ctx.catalog || null, { variables: this.varSet });
    const sp = new Speaker(m);
    sp.fullSql = sqlText;
    return { sp, m };
  }

  exprPhrase(text) {
    const t = String(text || '').trim();
    if (!t) return '';
    try {
      const x = this.speakerFor(`SELECT ${tsqlVars(t)}`);
      if (x && x.m.main && x.m.main.outputs[0] && x.m.main.outputs[0].expr && x.m.main.outputs[0].expr.type !== 'raw') return x.sp.say(x.m.main.outputs[0].expr, x.m.main);
    } catch { /* fall through */ }
    return code(t);
  }

  condPhrase(text) {
    const t = String(text || '').trim();
    if (!t) return '';
    try {
      const x = this.speakerFor(`SELECT 1 WHERE ${tsqlVars(t)}`);
      if (x && x.m.main && x.m.main.select && x.m.main.select.where && x.m.main.select.where.type !== 'raw') return x.sp.cond(x.m.main.select.where, x.m.main);
    } catch { /* fall through */ }
    return code(t);
  }

  /** Explain + review an embedded SQL statement; offsets are mapped back to the full text. */
  embed(range, prefix = '') {
    const snippet = prefix + this.full.slice(range.s, range.e);
    const p = parse(snippet, { dialect: this.ctx.dialect === 'generic' ? 'auto' : this.ctx.dialect });
    const st = p.statements.find((x) => x.type !== 'skipped') || p.statements[0];
    if (!st) return null;
    let r;
    if (st.type === 'skipped' || st.type === 'ddl' || st.type === 'routine') {
      r = { type: st.type, s: st.s, e: st.e, summary: [], steps: [], outputs: [], tables: [], findings: [], flow: null, skipped: true };
    } else {
      r = analyzeStatement(st, snippet, { catalog: this.ctx.catalog, dialect: this.ctx.dialect, variables: this.varSet, index: this.embedded.length, keepModel: true });
    }
    r.notes = p.notes;
    shiftResult(r, range.s, prefix.length, this.full);
    r.sql = this.full.slice(range.s, range.e).trim();
    r.ast = st;
    this.embedded.push(r);
    this.pendingFindings = r.findings;
    return r;
  }

  /** Query-level findings of an embedded statement, minus the ones that do not apply in context. */
  keepFindings(r) {
    for (const f of r.findings) {
      if (f.rule === 'select-star' && (r.purpose === 'return-query' || r.purpose === 'loop-source' || r.purpose === 'cursor')) continue; // RETURNS SETOF / loops over records need the whole row
      if (f.rule === 'select-star' && r.model && r.model.main && r.model.main.sources.every((s) => s.kind === 'function')) continue;
      this.findings.push({ ...f, step: f.step && f.step !== 'step 1' ? `${f.step} of the statement on line ${r.line}` : null });
    }
    r.findings = this.findings.filter((f) => f.s >= r.s && f.e <= r.e + 1);
  }

  // ---- outline ----
  result(st) {
    // T-SQL: CREATE PROCEDURE ... AS BEGIN ... END - the outer BEGIN/END only groups the body
    if (this.tree.body.length === 1 && this.tree.body[0].k === 'block' && !this.tree.body[0].handlers.length && !this.tree.body[0].tryCatch && !(this.tree.body[0].decls || []).length) this.tree.body = this.tree.body[0].body;
    const outline = [];
    this.loopStack = [];
    const declNodes = [...(this.tree.decls || [])];
    if (declNodes.length) {
      const vars = declNodes.filter((d) => d.k === 'decl');
      const curs = declNodes.filter((d) => d.k === 'cursor');
      const item = { k: 'decls', line: declNodes[0].line, s: declNodes[0].s, e: declNodes[declNodes.length - 1].e, text: `Declares ${list([vars.length ? plural(vars.length, 'variable') : null, curs.length ? plural(curs.length, 'cursor') : null].filter(Boolean))}${vars.some((v) => v.default) ? `; ${plural(vars.filter((v) => v.default).length, 'starts', 'start')} with a value` : ''}.`, items: [] };
      for (const d of vars) item.items.push({ text: `${code(d.name)} ${d.type ? `(${d.type})` : ''}${d.default ? ` = ${this.exprPhrase(d.default)}` : ''}${d.constant ? ', constant' : ''}`, line: d.line });
      for (const c of curs) { const r = this.embed(c.query); if (r) { r.purpose = 'cursor'; this.keepFindings(r); } item.items.push({ text: `cursor ${code(c.name)}: ${r ? this.sqlLine(r, 'cursor') : code(c.query.text)}`, line: c.line, sql: r }); }
      outline.push(item);
    }
    outline.push(...this.walk(this.tree.body));
    for (const hd of this.tree.handlers || []) outline.push(this.handler(hd));
    this.outline = outline;
    this.rules();
    const tables = this.tables();
    const ret = this.embedded.find((r) => r.purpose === 'return-query');
    const out = {
      index: this.ctx.index || 0,
      type: 'routine',
      s: st.s,
      e: st.e,
      sql: this.full.slice(st.s, st.e).trim(),
      line: lineOf(this.full, st.s),
      title: this.h.name ? `${cap(this.h.kind)} ${this.h.name}` : cap(this.h.kind),
      routine: {
        kind: this.h.kind, name: this.h.name, language: this.h.language, params: this.h.params.map(({ s, e, ...p }) => p), returns: this.h.returns,
        variables: [...this.vars.values()].filter((v) => v.kind === 'var').length, sqlCount: this.embedded.length, parseError: this.tree.error || null,
      },
      outline,
      summary: this.summary(tables, ret),
      grain: null,
      steps: [],
      outputs: ret ? ret.outputs : [],
      tables,
      findings: this.findings.sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.severity] - { high: 0, medium: 1, low: 2 }[b.severity]) || a.s - b.s),
      flow: this.flow(tables),
      embedded: this.embedded.map(({ ast, ...r }) => r),
    };
    return out;
  }

  walk(nodes, inLoop = null) {
    const out = [];
    let assignRun = null;
    const flushAssign = () => { if (assignRun) { out.push(assignRun.items.length > 2 ? assignRun : assignRun.items.map((x) => ({ ...x, k: 'assign' }))[0] && assignRun.items.length === 1 ? { ...assignRun.items[0], k: 'assign' } : { k: 'assigns', ...assignRun }); assignRun = null; } };
    for (const n of nodes || []) {
      if (n.k === 'raise' && n.level !== 'EXCEPTION') { this.counts.raise++; continue; }
      if (n.k === 'null' || n.k === 'option') continue;
      if (n.k === 'block' && !(n.handlers || []).length && !(n.decls || []).length && !n.tryCatch) { flushAssign(); out.push(...this.walk(n.body, inLoop)); continue; }
      if (n.k === 'decl' || (n.k === 'cursor' && n.query)) {
        flushAssign();
        const last = out[out.length - 1];
        let r = null;
        if (n.k === 'cursor') { r = this.embed(n.query); if (r) { r.purpose = 'cursor'; this.keepFindings(r); } }
        const it = n.k === 'cursor' ? { text: `cursor ${code(n.name)}: ${r ? this.sqlLine(r, 'cursor') : code(n.query.text)}`, line: n.line, sql: r } : { text: `${code(n.name)}${n.type ? ` (${n.type})` : ''}${n.default ? ` = ${this.exprPhrase(n.default)}` : ''}`, line: n.line };
        if (last && last.k === 'decls' && last.e != null && !last.closed) { last.items.push(it); last.e = n.e; last.count++; last.text = `Declares ${plural(last.count, 'variable')}:`; } else out.push({ k: 'decls', line: n.line, s: n.s, e: n.e, count: 1, text: 'Declares 1 variable:', items: [it] });
        continue;
      }
      if (out.length && out[out.length - 1].k === 'decls') out[out.length - 1].closed = true;
      if (n.k === 'assign' || n.k === 'diag') {
        this.counts.assign++;
        const items = n.k === 'diag' ? n.targets.map((tg) => ({ text: `${code(tg)} = ${/row_count|rowcount/i.test(n.text) ? 'the number of rows the last statement changed' : code(n.text)}`, line: n.line })) : [{ text: `${code(n.target)} = ${this.exprPhrase(n.expr.text)}`, line: n.line, s: n.s, e: n.e }];
        if (!assignRun) assignRun = { k: 'assigns', line: n.line, s: n.s, e: n.e, items: [] };
        assignRun.items.push(...items);
        assignRun.e = n.e;
        continue;
      }
      flushAssign();
      if (Array.isArray(n)) { out.push(...this.walk(n, inLoop)); continue; }
      out.push(this.item(n, inLoop));
    }
    flushAssign();
    if (!out.length && (nodes || []).length) {
      const notice = [].concat(nodes).find((n) => n && n.k === 'raise');
      const msg = notice && /'((?:[^']|'')*)'/.exec(notice.msg.text);
      if (notice) out.push({ k: 'raise', line: notice.line, s: notice.s, e: notice.e, text: `Prints a message${msg ? `: “${msg[1].replace(/''/g, "'")}”` : ''}.` });
      else if ([].concat(nodes).every((n) => n && (n.k === 'null' || n.k === 'option'))) out.push({ k: 'null', line: nodes[0].line, text: 'Does nothing (NULL).' });
    }
    // label for collapsed assignment groups
    for (const o of out) if (o.k === 'assigns') o.text = `Sets ${plural(o.items.length, 'variable')}:`;
    return out;
  }

  item(n, inLoop) {
    const base = { k: n.k, line: n.line, s: n.s, e: n.e };
    switch (n.k) {
      case 'sql': {
        const r = this.embed(n.sql, n.prefix || '');
        if (r) { r.purpose = n.purpose; r.inLoop = !!inLoop; this.keepFindings(r); }
        return { ...base, text: r ? this.sqlLine(r, n.purpose) : code(n.sql.text), sql: r, sqlIndex: r ? this.embedded.length - 1 : null };
      }
      case 'if': {
        const branches = n.branches.map((br, i) => ({ text: br.cond ? `${i === 0 ? 'If' : 'Otherwise, if'} ${this.condPhrase(br.cond.text)}:` : 'Otherwise:', line: br.cond ? lineOf(this.full, br.cond.s) : null, children: this.walk(br.body, inLoop) }));
        return { ...base, text: null, branches };
      }
      case 'loop': {
        this.loopStack.push(n);
        let text;
        let sql = null;
        if (n.kind === 'for-query') {
          const r = this.embed(n.source);
          if (r) { r.purpose = 'loop-source'; r.inLoop = !!inLoop; this.keepFindings(r); }
          sql = r;
          text = `For each row ${code(n.vars.join(', '))} of ${r ? this.loopSource(r) : code(n.source.text)}:`;
        } else if (n.kind === 'for-range') text = `For ${code(n.vars[0])} from ${code(n.source.text.split('..')[0].trim())} to ${code(n.source.text.split('..')[1].trim())}:`;
        else if (n.kind === 'for-cursor') text = `For each row ${code(n.vars[0])} of the cursor ${code(n.source.text)}:`;
        else if (n.kind === 'for-dynamic') text = `For each row ${code(n.vars[0])} of a query built at run time (${code(n.source.text.slice(0, 60))}):`;
        else if (n.kind === 'foreach') text = `For each element ${code(n.vars[0])} of the array ${this.exprPhrase(n.source.text)}:`;
        else if (n.kind === 'while') text = `Repeats while ${this.condPhrase(n.cond.text)}:`;
        else text = 'Repeats until an EXIT:';
        const children = this.walk(n.body, n);
        this.loopStack.pop();
        n.outlineSql = sql;
        return { ...base, text, children, sql, loop: true };
      }
      case 'block': {
        const children = [];
        if (n.decls && n.decls.length) children.push({ k: 'decls', line: n.decls[0].line, text: `Declares ${plural(n.decls.filter((d) => d.k === 'decl').length, 'variable')} for this block.` });
        children.push(...this.walk(n.body, inLoop));
        for (const hd of n.handlers || []) children.push(this.handler(hd, inLoop));
        return { ...base, text: n.tryCatch ? 'Tries the following (errors jump to the CATCH part):' : 'Runs a nested block:', children };
      }
      case 'return':
        if (n.kind === 'void') return { ...base, text: 'Stops and returns.' };
        if (n.kind === 'next') return { ...base, text: `Adds ${this.exprPhrase(n.expr.text)} to the rows returned (RETURN NEXT).` };
        return { ...base, text: `Returns ${this.exprPhrase(n.expr.text)}.` };
      case 'raise': {
        this.counts.raise++;
        const msg = /'((?:[^']|'')*)'/.exec(n.msg.text);
        return { ...base, text: `Stops with an error${msg ? `: “${msg[1].replace(/''/g, "'")}”` : ` (${code(n.msg.text.slice(0, 80))})`}.` };
      }
      case 'exit': return { ...base, text: `${n.kind === 'CONTINUE' ? 'Skips to the next pass of the loop' : 'Leaves the loop'}${n.cond ? ` when ${this.condPhrase(n.cond.text)}` : ''}.` };
      case 'exec': return { ...base, text: `Runs SQL built at run time from ${this.exprPhrase(n.expr.text)}${n.into ? `, storing the result in ${code(n.into.text)}` : ''}${n.using ? ' (with bound values)' : ''}.`, dynamic: true };
      case 'cursor': return { ...base, text: n.op === 'fetch' ? `Reads the next row of the cursor into ${list(n.into.map(code))}.` : n.op === 'open' ? `Opens the cursor ${code(n.name)}.` : `Closes the cursor ${code(n.name)}.` };
      case 'tx': if (n.op === 'BEGIN') return { ...base, text: 'Starts a transaction.' }; return { ...base, text: n.op === 'COMMIT' ? 'Commits the transaction (makes the changes so far permanent).' : n.op === 'ROLLBACK' ? 'Rolls back the transaction (undoes the changes).' : `${code(n.text)}.` };
      case 'call': return { ...base, text: `Calls ${code(n.name)}${/\(/.test(n.text) ? ` with ${code(n.text.slice(n.text.indexOf('(')))}` : ''}.` };
      case 'decl': case 'cursor-decl': return { ...base, text: `Declares ${code(n.name)}${n.type ? ` (${n.type})` : ''}${n.default ? ` = ${this.exprPhrase(n.default)}` : ''}.` };
      default: return { ...base, text: code(oneLine(n.text || '').slice(0, 120)) };
    }
  }

  handler(hd, inLoop) {
    const cond = /^\s*others\s*$|^any error$/i.test(hd.cond.text) ? 'any error' : code(hd.cond.text);
    return { k: 'handler', line: hd.line, s: hd.s, e: hd.e, text: `If ${cond} happens:`, children: this.walk(hd.body, inLoop) };
  }

  loopSource(r) {
    const ast = r.ast;
    const main = r.model && r.model.main;
    if (main && main.sources && main.sources.length === 1 && main.sources[0].kind === 'function' && !main.select.where) {
      const call = main.sources[0].node.call;
      if (call && /^(JSON_ARRAY_ELEMENTS|JSONB_ARRAY_ELEMENTS|JSON_ARRAY_ELEMENTS_TEXT|JSONB_ARRAY_ELEMENTS_TEXT|UNNEST)$/.test(call.name)) return `the elements of ${this.exprPhrase(this.full.slice(r.s, r.e).match(/\(([\s\S]*)\)/) ? call.args.map((a) => r.sql.slice(a.s - (r.ast.s || 0), a.e - (r.ast.s || 0))).join(', ') : '')}`.replace(/the elements of $/, 'the elements of the array');
      if (call && /^GENERATE_SERIES$/.test(call.name)) return `the numbers from ${code(r.sql.slice(call.args[0].s, call.args[0].e))} to ${code(r.sql.slice(call.args[1].s, call.args[1].e))}`;
    }
    void ast;
    const s0 = (r.summary[0] || '').replace(/^Returns /, '').replace(/\.$/, '');
    const f = r.summary.find((x) => /^It only includes/.test(x));
    return `${s0}${f ? ` (${f.replace(/^It only includes /, 'only ').replace(/\.$/, '')})` : ''} from ${list(r.tables.map((t) => code(t.name)))}`;
  }

  sqlLine(r, purpose) {
    if (r.skipped || r.failed) return code(oneLine(r.sql).slice(0, 120));
    const m = r.model;
    const main = m && m.main;
    const sel = main && main.select;
    const filterSentence = r.summary.find((x) => /^It only includes/.test(x));
    if (purpose === 'return-query') return `Returns ${(r.summary[0] || '').replace(/^Returns /, '').replace(/\.$/, '')}${filterSentence ? `; ${filterSentence.replace(/^It only includes /, 'only ').replace(/\.$/, '')}` : ''}.`;
    const only = (x) => x.replace(/^It only includes [\w ]+? where /, 'only when ').replace(/\.$/, '');
    if (purpose === 'cursor' || purpose === 'open-cursor') return `${(r.summary[0] || '').replace(/^Returns /, '').replace(/\.$/, '')}${filterSentence ? `, ${filterSentence.replace(/^It only includes /, 'only ').replace(/\.$/, '')}` : ''}`;
    if (r.type === 'query' && sel && (sel.into || main.outputs.some((o) => o.item && o.item.assignTo))) {
      const targets = sel.intoList ? sel.intoList.map((x) => x.parts.join('.')) : main.outputs.filter((o) => o.item && o.item.assignTo).map((o) => o.item.assignTo);
      const sp = new Speaker(m);
      sp.fullSql = this.full;
      const offs = r.ast.s;
      sp.fullSql = (purpose === 'perform' ? 'SELECT ' : '') + this.full.slice(r.s, r.e);
      void offs;
      const what = main.outputs.map((o) => (o.expr ? sp.say(o.expr, main) : o.name));
      const conds = sp.filterConds(main).map((c) => sp.cond(c, main));
      const from = main.sources.length ? ` from ${list(main.sources.map((s) => code(s.displayName)))}` : '';
      return `Looks up ${list(what)}${from}${conds.length ? ` where ${list(conds.slice(0, 4))}` : ''}, and stores ${what.length > 1 ? 'them' : 'it'} in ${list(targets.map(code))}.`;
    }
    if (purpose === 'perform') return `Runs ${(r.summary[0] || '').replace(/^Returns /, 'a query returning ').replace(/\.$/, '')} and discards the result (PERFORM).`;
    if (r.type === 'insert' || r.type === 'update' || r.type === 'delete' || r.type === 'merge') {
      return `${(r.summary[0] || '').replace(/\.$/, '')}${filterSentence && r.type === 'insert' ? `; ${only(filterSentence)}` : ''}.`;
    }
    return r.summary.slice(0, 2).join(' ');
  }

  // ---- routine-level rules ----
  addFinding(rule, severity, node, title, detail, fix = null, fixSql = null) {
    const s = node.s;
    const e = node.e;
    this.findings.push({ rule, severity, title, detail, fix, fixSql, s, e, line: lineOf(this.full, s), step: null, snippet: oneLine(this.full.slice(s, e)).slice(0, 300) });
  }

  rules() {
    const body = this.sc.toks;
    const varTok = (t) => (t.t === 'word' || t.t === 'qid' || t.t === 'param') && this.vars.has(String(t.t === 'param' ? t.v : identName(t)).toLowerCase());
    // assignments
    const assignedAt = new Map();
    const markAssigned = (name, line) => { const k = String(name).split(/[.[]/)[0].toLowerCase(); if (!assignedAt.has(k)) assignedAt.set(k, []); assignedAt.get(k).push(line); };
    const targetOffsets = new Set();
    const visit = (nodes, loop) => {
      for (const n of [].concat(nodes || [])) {
        if (!n) continue;
        if (Array.isArray(n)) { visit(n, loop); continue; }
        n.loop = loop;
        if (n.k === 'assign') { markAssigned(n.target, n.line); targetOffsets.add(n.targetTok.s); }
        if (n.k === 'diag') for (const tg of n.targets) markAssigned(tg, n.line);
        if (n.k === 'cursor' && n.op === 'fetch') for (const tg of n.into) markAssigned(tg, n.line);
        if (n.k === 'exec' && n.into) for (const tg of n.into.text.split(',')) markAssigned(tg.trim(), n.line);
        if (n.k === 'decl') targetOffsets.add(n.nameTok.s);
        if (n.k === 'sql') {
          const r = this.embedded.find((x) => x.s >= n.sql.s && x.s <= n.sql.e + 8 && x.sql === this.full.slice(n.sql.s, n.sql.e).trim());
          const ast = r && r.ast;
          const intos = [];
          if (ast && ast.type === 'query' && ast.body && ast.body.intoList) intos.push(...ast.body.intoList);
          if (ast && ast.returning && ast.returning.into) intos.push(...ast.returning.into);
          for (const x of intos) markAssigned(x.parts.join('.'), n.line);
          if (r && r.model && r.model.main) for (const o of r.model.main.outputs) if (o.item && o.item.assignTo) markAssigned(o.item.assignTo, n.line);
          n.result = r;
          // INTO target tokens are writes, not reads
          const into = /\bINTO\b([\s\S]*?)\bFROM\b/i.exec(this.full.slice(n.sql.s, n.sql.e));
          if (into && ast && ast.body && ast.body.intoList) for (const t of body) if (t.s >= n.sql.s + into.index && t.s < n.sql.s + into.index + into[0].length && varTok(t)) targetOffsets.add(t.s);
        }
        if (n.k === 'loop') { for (const v of n.vars || []) markAssigned(v, n.line); visit(n.body, n); }
        if (n.k === 'if') for (const br of n.branches) visit(br.body, loop);
        if (n.k === 'block') { visit(n.decls, loop); visit(n.body, loop); for (const hd of n.handlers || []) visit(hd.body, loop); }
      }
    };
    visit(this.tree.decls, null);
    visit(this.tree.body, null);
    for (const hd of this.tree.handlers || []) visit(hd.body, null);
    // reads
    const reads = new Map();
    const readLines = new Map();
    const firstRead = new Map();
    for (const t of body) {
      if (!varTok(t) || targetOffsets.has(t.s)) continue;
      const prevTok = body[body.indexOf(t) - 1];
      if (prevTok && prevTok.t === '.') continue; // alias.column, not a variable
      const k = String(t.t === 'param' ? t.v : identName(t)).toLowerCase();
      reads.set(k, (reads.get(k) || 0) + 1);
      if (!readLines.has(k)) readLines.set(k, []);
      readLines.get(k).push(lineOf(this.full, t.s));
      if (!firstRead.has(k)) firstRead.set(k, t);
    }
    // 1. used but never set
    for (const [k, v] of this.vars) {
      if (v.kind !== 'var' || v.hasDefault || v.decl.alias) continue;
      if ((reads.get(k) || 0) > 0 && !assignedAt.has(k)) {
        const lines = [...new Set(readLines.get(k))];
        const at = firstRead.get(k);
        this.addFinding('unassigned-variable', 'high', at ? { s: at.s, e: at.e } : v.decl, `${code(v.name)} is used but never given a value, so it is always NULL`,
          `It is declared on line ${v.line} and read on line${lines.length > 1 ? 's' : ''} ${list(lines.map(String))}, but nothing assigns it (no \`:=\`, SELECT … INTO or FETCH … INTO). Every comparison with it is NULL, so conditions such as \`col = ${v.name}\` never match.`,
          'Assign it before it is used (it may have been set in code that is now commented out), or remove the conditions that use it.');
      }
    }
    // 2. declared but never read
    const unused = [...this.vars.values()].filter((v) => v.kind === 'var' && !reads.get(v.name.toLowerCase()));
    if (unused.length) {
      const first = unused[0].decl;
      this.addFinding('unused-variable', 'low', first, `${plural(unused.length, 'variable is', 'variables are')} never read: ${list(unused.slice(0, 12).map((v) => code(v.name)))}${unused.length > 12 ? ' …' : ''}`,
        `${unused.some((v) => assignedAt.has(v.name.toLowerCase())) ? 'Some are set but their value is never used. ' : ''}Unused variables make the code harder to follow and can hide a bug (the value was meant to be used somewhere).`,
        'Remove them, or use them where intended.');
    }
    // 3. SQL in a loop that does not depend on the loop
    const assignedIn = (loop) => {
      const names = new Set((loop.vars || []).map((x) => x.toLowerCase()));
      const walk = (nodes) => {
        for (const n of [].concat(nodes || [])) {
          if (!n || Array.isArray(n)) { if (Array.isArray(n)) walk(n); continue; }
          if (n.k === 'assign') names.add(n.target.split(/[.[]/)[0].toLowerCase());
          if (n.k === 'diag') n.targets.forEach((x) => names.add(x.toLowerCase()));
          if (n.k === 'cursor' && n.op === 'fetch') n.into.forEach((x) => names.add(x.toLowerCase()));
          if (n.k === 'exec' && n.into) n.into.text.split(',').forEach((x) => names.add(x.trim().toLowerCase()));
          if (n.k === 'sql' && n.result) {
            const ast = n.result.ast;
            if (ast && ast.body && ast.body.intoList) ast.body.intoList.forEach((x) => names.add(x.parts.join('.').toLowerCase()));
            if (ast && ast.returning && ast.returning.into) ast.returning.into.forEach((x) => names.add(x.parts.join('.').toLowerCase()));
          }
          if (n.k === 'loop') { (n.vars || []).forEach((x) => names.add(x.toLowerCase())); walk(n.body); }
          if (n.k === 'if') n.branches.forEach((br) => walk(br.body));
          if (n.k === 'block') { walk(n.body); (n.handlers || []).forEach((hd) => walk(hd.body)); }
        }
      };
      walk(loop.body);
      return names;
    };
    const checkLoop = (nodes, loop) => {
      for (const n of [].concat(nodes || [])) {
        if (!n || Array.isArray(n)) { if (Array.isArray(n)) checkLoop(n, loop); continue; }
        if (loop && n.k === 'sql' && n.result && ['update', 'delete', 'insert', 'merge'].includes(n.result.type)) {
          const changing = loop.changing || (loop.changing = assignedIn(loop));
          const used = body.filter((t) => t.s >= n.sql.s && t.e <= n.sql.e && (t.t === 'word' || t.t === 'qid' || t.t === 'param')).map((t) => String(t.t === 'param' ? t.v : identName(t)).toLowerCase());
          if (!used.some((u) => changing.has(u))) {
            if (n.result.type === 'insert') {
              this.addFinding('loop-invariant-sql', 'medium', n, 'This INSERT adds an identical row on every pass of the loop',
                `It uses nothing that changes inside the loop that starts on line ${loop.line}, so 1,000 passes insert 1,000 identical rows.`,
                'If one row per pass is intended, include the loop value (for example the ID being processed) so the rows can be told apart; otherwise move it after the loop.');
            } else {
              this.addFinding('loop-invariant-sql', 'medium', n, `This ${n.result.type.toUpperCase()} runs on every pass of the loop but does not depend on it`,
                `It uses nothing that changes inside the loop that starts on line ${loop.line}, so it does exactly the same work on every pass: with 1,000 input rows it runs 1,000 times over the same rows.`,
                'Move it after the loop so it runs once (or add a condition on the loop variable if it should only touch the current row).');
            }
          }
        }
        if (n.k === 'loop') checkLoop(n.body, n);
        if (n.k === 'if') n.branches.forEach((br) => checkLoop(br.body, loop));
        if (n.k === 'block') { checkLoop(n.body, loop); (n.handlers || []).forEach((hd) => checkLoop(hd.body, loop)); }
      }
    };
    checkLoop(this.tree.body, null);
    // 4. check-then-insert
    const sqlNodes = [];
    const collect = (nodes) => { for (const n of [].concat(nodes || [])) { if (!n) continue; if (Array.isArray(n)) { collect(n); continue; } if (n.k === 'sql') sqlNodes.push(n); if (n.k === 'loop') collect(n.body); if (n.k === 'if') n.branches.forEach((br) => collect(br.body)); if (n.k === 'block') { collect(n.body); (n.handlers || []).forEach((hd) => collect(hd.body)); } } };
    collect(this.tree.body);
    for (const n of sqlNodes) {
      const r = n.result;
      if (!r || r.type !== 'query' || !r.model || !r.model.main || !r.model.main.select) continue;
      const main = r.model.main;
      const intoTarget = main.select.into || main.outputs.find((o) => o.item && o.item.assignTo);
      if (!intoTarget || !main.outputs.some((o) => o.expr && o.expr.type === 'func' && (o.expr.name === 'COUNT' || o.expr.name === 'COUNT_BIG'))) continue;
      const tbl = main.sources[0] && main.sources[0].kind === 'table' ? main.sources[0].parts[main.sources[0].parts.length - 1].toLowerCase() : null;
      const ins = tbl && sqlNodes.find((x) => x.s > n.s && x.result && x.result.type === 'insert' && x.result.ast && x.result.ast.table && x.result.ast.table.parts[x.result.ast.table.parts.length - 1].toLowerCase() === tbl);
      if (ins) {
        const keyCond = conjuncts(main.select.where).find((c) => c.type === 'bin' && c.op === '=');
        const keyCol = keyCond ? this.full.slice(r.s, r.e).slice(0, 0) || (keyCond.left.type === 'col' ? keyCond.left.parts[keyCond.left.parts.length - 1] : null) : null;
        this.addFinding('check-then-insert', 'medium', n, `Counting rows in ${code(main.sources[0].displayName)} and then inserting (line ${ins.line}) can create duplicates`,
          'Between the count and the INSERT, another call of this routine can insert the same row, so both see "0" and both insert. Counting all matching rows is also more work than checking whether one exists.',
          keyCol ? `Add a unique constraint on ${code(keyCol)} and insert with ${code(this.ctx.dialect === 'oracle' ? 'MERGE' : `INSERT … ON CONFLICT (${keyCol}) DO NOTHING`)}. For the check alone, ${code('EXISTS (SELECT 1 …)')} is cheaper than COUNT.` : 'Use a unique constraint plus an upsert (INSERT … ON CONFLICT / MERGE) instead of check-then-insert.');
      }
    }
    // 5. SELECT INTO that may match several rows
    for (const n of sqlNodes) {
      const r = n.result;
      if (!r || r.type !== 'query' || !r.model || !r.model.main || !r.model.main.select) continue;
      const main = r.model.main;
      const tsqlAssign = main.outputs.some((o) => o.item && o.item.assignTo);
      if (!main.select.into && !tsqlAssign) continue;
      if (main.outputs.every((o) => o.expr && hasAggregate(o.expr)) || main.limit || (main.select.top) || main.select.groupBy) continue;
      const base = main.sources[0];
      if (!base) continue;
      const eqCols = conjuncts(main.select.where).filter((c) => c.type === 'bin' && c.op === '=').flatMap((c) => [c.left, c.right]).filter((x) => x.type === 'col').map((x) => r.model.resolve(main, x)).filter((x) => x && x.source === base).map((x) => x.column);
      if (eqCols.length && r.model.isKey(base, eqCols)) continue;
      if (main.sources.length === 1 && eqCols.some((c) => /^(id|.*_id)$/i.test(c)) && r.model.isKey(base, eqCols)) continue;
      const pg = this.h.style === 'pg' || this.h.language === 'plpgsql';
      if (tsqlAssign) {
        this.addFinding('select-into-many', 'low', n, 'This SELECT @variable = … can match more than one row', 'If several rows match, the variable ends up with the value from whichever row is read last, which can change from run to run; if none match, the variable keeps its old value.', 'Make the filter unique, or use SELECT TOP (1) … ORDER BY … to choose the row deliberately.');
        continue;
      }
      this.addFinding('select-into-many', 'low', n, `This SELECT … INTO can match more than one row`,
        pg ? 'In PL/pgSQL, if several rows match, the variable silently gets whichever row comes first (and NULL if none match), so the result can change from run to run.' : 'In PL/SQL this raises TOO_MANY_ROWS if several rows match and NO_DATA_FOUND if none do.',
        pg ? `Make the filter unique, add ORDER BY … LIMIT 1 to choose deliberately, or use ${code('SELECT … INTO STRICT')} to get an error instead of a silent pick.` : 'Make the filter unique, or handle TOO_MANY_ROWS / NO_DATA_FOUND explicitly.');
    }
    // 6. IF on a value that cannot be NULL
    const nonNull = new Set();
    const seq = (nodes) => {
      for (const n of [].concat(nodes || [])) {
        if (!n) continue;
        if (Array.isArray(n)) { seq(n); continue; }
        if (n.k === 'assign') {
          const k = n.target.toLowerCase();
          if (/^\s*(coalesce|nvl|ifnull|isnull)\s*\([\s\S]*,\s*('(?:[^']|'')*'|-?\d+(\.\d+)?)\s*\)\s*$/i.test(n.expr.text) || /^\s*('(?:[^']|'')+'|-?\d+(\.\d+)?)\s*$/.test(n.expr.text)) nonNull.add(k);
          else nonNull.delete(k);
        }
        if (n.k === 'if') {
          const c = n.branches[0].cond && n.branches[0].cond.text;
          const m = c && /^\s*\(?\s*([\w.@]+)\s+IS\s+(NOT\s+)?NULL\s*\)?\s*$/i.exec(c);
          if (m && nonNull.has(m[1].toLowerCase())) {
            this.addFinding('always-true-condition', 'low', n, `${code(c.trim())} is always ${m[2] ? 'true' : 'false'}`,
              `${code(m[1])} was just set with a fallback value (for example COALESCE(…, 'Other')), so it can never be NULL here.`,
              m[2] ? 'The IF can be removed, or test what was really meant (for example whether the original value was missing).' : 'This branch never runs; check what was meant.');
          }
          n.branches.forEach((br) => seq(br.body));
        }
        if (n.k === 'loop') { (n.vars || []).forEach((v) => nonNull.delete(v.toLowerCase())); seq(n.body); }
        if (n.k === 'block') seq(n.body);
        if (n.k === 'sql' && n.result && n.result.ast && n.result.ast.body && n.result.ast.body.intoList) n.result.ast.body.intoList.forEach((x) => nonNull.delete(x.parts.join('.').toLowerCase()));
      }
    };
    seq(this.tree.body);
    // 7. dynamic SQL built by concatenation
    const dyn = (nodes) => {
      for (const n of [].concat(nodes || [])) {
        if (!n) continue;
        if (Array.isArray(n)) { dyn(n); continue; }
        if ((n.k === 'exec') && /\|\||\+|concat\s*\(/i.test(n.expr.text) && !/\bformat\s*\(|quote_ident|quote_literal|quote_nullable|QUOTENAME/i.test(n.expr.text)) {
          this.addFinding('dynamic-sql-concat', 'high', n, 'Dynamic SQL is built by joining strings', `${code(n.expr.text.slice(0, 120))} pastes values straight into SQL text. If any part comes from a parameter or a table, a quote in it breaks the statement or lets someone run their own SQL (SQL injection).`,
            this.h.style === 'tsql' ? 'Pass values as parameters with sp_executesql (@params), and wrap names in QUOTENAME().' : this.ctx.dialect === 'oracle' ? 'Use bind variables: EXECUTE IMMEDIATE \'… :1 …\' USING v_value, and DBMS_ASSERT for object names.' : "Use EXECUTE format('… %I … %L …', name, value) or EXECUTE '… $1 …' USING value.");
        }
        if (n.k === 'loop') { if (n.kind === 'for-dynamic' && /\|\|/.test(n.source.text)) this.addFinding('dynamic-sql-concat', 'high', n, 'A loop runs SQL built by joining strings', 'Values pasted into SQL text can break the query or allow SQL injection.', 'Build it with format(…) and USING parameters.'); dyn(n.body); }
        if (n.k === 'if') n.branches.forEach((br) => dyn(br.body));
        if (n.k === 'block') { dyn(n.body); (n.handlers || []).forEach((hd) => dyn(hd.body)); }
      }
    };
    dyn(this.tree.body);
    // 8. errors swallowed
    const handlers = [...(this.tree.handlers || [])];
    const collectH = (nodes) => { for (const n of [].concat(nodes || [])) { if (!n || Array.isArray(n)) { if (Array.isArray(n)) collectH(n); continue; } if (n.k === 'block') { handlers.push(...(n.handlers || [])); collectH(n.body); } if (n.k === 'loop') collectH(n.body); if (n.k === 'if') n.branches.forEach((br) => collectH(br.body)); } };
    collectH(this.tree.body);
    for (const hd of handlers) {
      const meaningful = hd.body.filter((x) => !(x.k === 'null' || (x.k === 'raise' && x.level !== 'EXCEPTION')));
      if (/\bothers\b|any error/i.test(hd.cond.text) && !meaningful.length) {
        this.addFinding('swallowed-error', 'medium', hd, 'Errors are caught and ignored', 'Any error inside the block is silently discarded (at most a message is printed), so failures go unnoticed and partial changes may stay in place.', 'Log the error and re-raise it (RAISE; / THROW;), or catch only the specific errors you expect.');
      }
    }
  }

  // ---- summary, tables, flow ----
  summary(tables, ret) {
    const S = [];
    const h = this.h;
    const lang = h.language ? (h.language === 'plpgsql' ? 'PL/pgSQL' : h.language === 'sql' ? 'SQL' : h.language) : '';
    const params = h.params.length ? `(${h.params.map((p) => `${p.name}${p.mode && p.mode !== 'IN' ? ` ${p.mode}` : ''}`).join(', ')})` : '()';
    if (h.name) {
      const ret0 = h.returns ? returnsPhrase(h.returns) : null;
      S.push(`Defines the ${lang} ${h.kind} ${code(h.name + params)}${ret0 ? `, which returns ${ret0}` : ''}.`);
    } else S.push(`An ${lang} ${h.kind}${h.kind === 'script' ? ' (a batch of statements)' : ''}.`);
    const top = this.outline;
    const loops = top.filter((o) => o.loop);
    const writes = tables.filter((t) => t.writes.length);
    const reads = tables.filter((t) => t.reads && !t.writes.length);
    const sqlN = this.embedded.length;
    if (loops.length === 1) {
      const inside = this.embedded.filter((r) => r.inLoop).length;
      S.push(`${loops[0].text.replace(/:$/, '')}, it runs ${plural(inside, 'SQL statement')}.`);
    } else if (sqlN) S.push(`It runs ${plural(sqlN, 'SQL statement')}.`);
    if (writes.length) S.push(`It changes data in ${list(writes.map((t) => `${code(t.name)} (${t.writes.join(', ')})`))}.`);
    if (reads.length) S.push(`It also reads ${list(reads.map((t) => code(t.name)))}.`);
    if (ret) S.push(`At the end it ${this.sqlLine(ret, 'return-query').replace(/^Returns/, 'returns')}`);
    const extras = [];
    const nVars = [...this.vars.values()].filter((v) => v.kind === 'var').length;
    if (nVars) extras.push(`declares ${plural(nVars, 'variable')}`);
    if (this.counts.raise) extras.push(`prints or raises ${plural(this.counts.raise, 'message')}`);
    if (extras.length) S.push(`Along the way it ${list(extras)}.`);
    if (this.tree.error) S.push(`Part of the body could not be read (${this.tree.error}); the outline below stops there.`);
    return S;
  }

  tables() {
    const map = new Map();
    for (const r of this.embedded) {
      for (const t of r.tables || []) {
        const k = t.name.toLowerCase();
        if (!map.has(k)) map.set(k, { name: t.name, aliases: [], steps: [], columns: new Set(), purpose: t.purpose, known: t.known, entity: t.entity, roles: new Set(), writes: [], reads: 0, allColumns: false, lines: new Set() });
        const m = map.get(k);
        t.columns.forEach((c) => { if (![...m.columns].some((x) => x.toLowerCase() === c.toLowerCase())) m.columns.add(c); });
        if (t.allColumns) m.allColumns = true;
        m.lines.add(r.line);
        const isTarget = ['insert', 'update', 'delete', 'merge'].includes(r.type) && r.target && r.target.name && r.target.name.toLowerCase() === k;
        if (isTarget) { const verb = r.type.toUpperCase(); if (!m.writes.includes(verb)) m.writes.push(verb); m.roles.add('target'); } else { m.reads++; m.roles.add('from'); }
      }
    }
    return [...map.values()].map((t) => ({ ...t, columns: [...t.columns].sort(), roles: [...t.roles], lines: [...t.lines].sort((a, b) => a - b), steps: [] }));
  }

  flow(tables) {
    const nodes = [{ id: 'r', kind: 'main', label: this.h.name ? this.h.name.split('.').pop() : this.h.kind, step: null, ops: [`${plural(this.embedded.length, 'SQL statement')}`, ...(this.outline.some((o) => o.loop) ? ['loop'] : [])], sub: this.h.language || null }];
    const edges = [];
    tables.forEach((t, i) => {
      const read = t.reads > 0;
      const id = `t${i + 1}`;
      if (read && t.writes.length) {
        nodes.push({ id: `${id}r`, kind: 'table', label: t.name, sub: 'read', known: t.known });
        edges.push({ from: `${id}r`, to: 'r', label: 'reads', style: 'solid' });
        nodes.push({ id: `${id}w`, kind: 'target', label: t.name, sub: t.writes.join(', ') });
        edges.push({ from: 'r', to: `${id}w`, label: t.writes.join(', '), style: 'solid' });
      } else if (read) {
        nodes.push({ id, kind: 'table', label: t.name, sub: 'read', known: t.known });
        edges.push({ from: id, to: 'r', label: 'reads', style: 'solid' });
      } else {
        nodes.push({ id, kind: 'target', label: t.name, sub: t.writes.join(', ') });
        edges.push({ from: 'r', to: id, label: t.writes.join(', '), style: 'solid' });
      }
    });
    return { nodes, edges };
  }
}

function returnsPhrase(r) {
  const x = r.trim();
  let m;
  if ((m = /^SETOF\s+(.+)$/i.exec(x))) return `a set of ${code(m[1])} rows`;
  if ((m = /^TABLE\s*\(([\s\S]*)\)$/i.exec(x))) return `a table with columns ${list(m[1].split(',').map((c) => code(c.trim().split(/\s+/)[0])))}`;
  if (/^void$/i.test(x)) return 'nothing';
  if (/^trigger$/i.test(x)) return 'a trigger result (it runs when rows change)';
  return `a value of type ${code(x)}`;
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

/** T-SQL @variables are parameters to the query parser; keep them as they are. */
function tsqlVars(t) { return t; }
