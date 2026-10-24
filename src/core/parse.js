// Tolerant SQL parser: turns query text into a small AST that the explainer, the review
// rules and the flow diagram share. It reads the parts of SQL that decide what a query
// means (WITH, SELECT, FROM/JOIN, WHERE, GROUP BY, HAVING, QUALIFY, windows, set operations,
// ORDER BY/LIMIT/TOP/FETCH, INSERT/UPDATE/DELETE/MERGE, CREATE VIEW/TABLE AS) across
// PostgreSQL, Oracle, SQL Server, MySQL, Snowflake, BigQuery and SQLite. When it meets syntax
// it does not know, it skips to the next clause and records a note instead of giving up.
//
// Every node has { type, s, e } (source offsets) so findings can quote the original text.
import { tokenize, KEYWORDS, identName } from './tokenize.js';

const CLAUSE_STOP = new Set(['FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH', 'UNION', 'INTERSECT',
  'EXCEPT', 'MINUS', 'WINDOW', 'QUALIFY', 'INTO', 'CONNECT', 'START', 'RETURNING', 'FOR', 'OPTION', 'SETTINGS']);
const JOIN_START = new Set(['JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'OUTER', 'STRAIGHT_JOIN', 'ANTI', 'SEMI', 'ASOF']);
// words that may follow a source and are not its alias
const NOT_ALIAS = new Set([...KEYWORDS, 'LIMIT', 'OFFSET', 'FETCH', 'QUALIFY', 'WINDOW', 'RETURNING', 'CONNECT', 'START',
  'APPLY', 'OUTER', 'SEMI', 'ANTI', 'ASOF', 'SAMPLE', 'TABLESAMPLE', 'PIVOT', 'UNPIVOT', 'MATCH_RECOGNIZE', 'GO', 'OPTION',
  'LOCK', 'NOWAIT', 'SKIP', 'KEEP', 'MINUS', 'EXCEPT', 'INTERSECT', 'UNION', 'PARTITION', 'VERSIONS', 'AT', 'BEFORE', 'CHANGES', 'FINAL']);

const NO_PAREN_FUNCS = new Set(['CURRENT_DATE', 'CURRENT_TIMESTAMP', 'CURRENT_TIME', 'LOCALTIMESTAMP', 'LOCALTIME', 'SYSDATE',
  'SYSTIMESTAMP', 'CURRENT_USER', 'SESSION_USER', 'SYSTEM_USER', 'USER', 'CURRENT_SCHEMA', 'CURRENT_ROLE', 'ROWNUM', 'LEVEL', 'ROWID']);
const TYPED_LITERALS = new Set(['DATE', 'TIMESTAMP', 'TIME', 'TIMESTAMPTZ', 'DATETIME']);

const DATE_UNIT_FUNCS = new Set(['DATEADD', 'DATEDIFF', 'DATEDIFF_BIG', 'DATEPART', 'DATENAME', 'DATE_TRUNC', 'DATETRUNC', 'TIMESTAMPADD', 'TIMESTAMPDIFF', 'DATE_DIFF', 'DATETIME_DIFF', 'TIMESTAMP_DIFF', 'DATE_ADD', 'DATE_SUB', 'TIMESTAMP_TRUNC', 'DATETIME_TRUNC', 'TIME_SLICE', 'LAST_DAY', 'DATE_PART']);
const DATE_UNIT_RE = /^(year|yy|yyyy|quarter|qq|q|month|mm|m|week|wk|ww|isoweek|day|dd|d|dayofyear|dy|y|weekday|dw|hour|hh|minute|mi|n|second|ss|s|millisecond|ms|microsecond|mcs|nanosecond|ns|years|months|days|hours|minutes|seconds|weeks|isoyear|dow|doy|epoch)$/i;

class ParseError extends Error {
  constructor(msg, tok) { super(msg); this.tok = tok; }
}

export function parse(sql, options = {}) {
  const all = tokenize(sql);
  const toks = all.filter((t) => t.t !== 'comment');
  const p = new Parser(sql, toks, options);
  const statements = p.statements();
  return { sql, tokens: all, statements, notes: p.notes };
}

class Parser {
  constructor(sql, toks, options) {
    this.sql = sql;
    this.toks = toks;
    this.i = 0;
    this.notes = [];
    this.dialect = options.dialect || 'auto';
  }

  // ---------- token helpers ----------
  peek(k = 0) { return this.toks[Math.min(this.i + k, this.toks.length - 1)]; }
  next() { const t = this.toks[this.i]; if (this.i < this.toks.length - 1) this.i++; return t; }
  prev() { return this.toks[Math.max(0, this.i - 1)]; }
  isW(u, k = 0) { const t = this.peek(k); return t.t === 'word' && (Array.isArray(u) ? u.includes(t.u) : t.u === u); }
  isT(type, k = 0) { return this.peek(k).t === type; }
  isOp(v, k = 0) { const t = this.peek(k); return t.t === 'op' && t.v === v; }
  acceptW(...us) { if (this.peek().t === 'word' && us.includes(this.peek().u)) return this.next(); return null; }
  acceptT(type) { return this.isT(type) ? this.next() : null; }
  acceptOp(v) { return this.isOp(v) ? this.next() : null; }
  expectW(u) { const t = this.acceptW(u); if (!t) throw new ParseError(`Expected ${u} but found "${this.peek().v || 'end of query'}"`, this.peek()); return t; }
  expectT(type) { const t = this.acceptT(type); if (!t) throw new ParseError(`Expected "${type}" but found "${this.peek().v || 'end of query'}"`, this.peek()); return t; }
  node(type, startTok, props) { return { type, s: startTok.s, e: this.prev().e, ...props }; }
  text(s, e) { return this.sql.slice(s, e); }
  atEnd() { return this.isT('eof') || this.isT(';'); }

  note(msg, tok) {
    this.notes.push({ message: msg, line: tok ? tok.line : null });
  }

  /** Skip tokens (keeping parentheses balanced) until one of the stop words / types at depth 0. */
  skipUntil(stopWords = CLAUSE_STOP, stopTypes = [';', 'eof', ')', ',']) {
    let depth = 0;
    const start = this.peek();
    while (!this.isT('eof')) {
      const t = this.peek();
      if (depth === 0 && (stopTypes.includes(t.t) || (t.t === 'word' && stopWords.has(t.u)))) break;
      if (t.t === '(') depth++;
      if (t.t === ')') { if (depth === 0) break; depth--; }
      if (t.t === ';' && depth > 0) break;
      this.next();
    }
    return { s: start.s, e: this.prev().e >= start.s ? this.prev().e : start.s };
  }

  /** Run fn; on a parse error, note it, skip to the next clause and return a raw node. */
  guard(fn, what, stopWords = CLAUSE_STOP, stopTypes) {
    const save = this.i;
    try {
      return fn();
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
      this.i = save;
      const tok = this.peek();
      const r = this.skipUntil(stopWords, stopTypes);
      if (this.i === save && !this.isT('eof') && !this.isT(';')) this.next();
      const text = this.text(tok.s, this.prev().e).trim();
      this.note(`Could not fully read ${what} near line ${tok.line} ("${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"): ${err.message}.`, tok);
      return { type: 'raw', s: r.s, e: this.prev().e, text };
    }
  }

  // ---------- statements ----------
  statements() {
    const out = [];
    while (!this.isT('eof')) {
      if (this.acceptT(';')) continue;
      const start = this.i;
      let st = null;
      try {
        st = this.statement();
      } catch (err) {
        if (!(err instanceof ParseError)) throw err;
        const tok = this.toks[start];
        this.i = start;
        const r = this.skipUntil(new Set(), [';', 'eof']);
        this.note(`Could not read the statement starting on line ${tok.line} ("${this.text(r.s, r.e).trim().slice(0, 60)}"): ${err.message}.`, tok);
        st = { type: 'skipped', keyword: tok.u || tok.v, s: r.s, e: r.e, line: tok.line, unreadable: true };
      }
      if (st) out.push(st);
      if (this.i === start) this.next();
      if (!this.isT(';') && !this.isT('eof')) {
        const tok = this.peek();
        const r = this.skipUntil(new Set(), [';', 'eof']);
        const text = this.text(r.s, r.e).trim();
        if (text) this.note(`Ignored text after the statement near line ${tok.line}: "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`, tok);
      }
    }
    return out;
  }

  statement() {
    const t = this.peek();
    if (t.t === '(' || this.isW(['SELECT', 'WITH', 'VALUES'])) {
      const q = this.query();
      if (q.dml) return q.dml;
      return q;
    }
    if (t.t !== 'word') { this.skipUntil(new Set(), [';', 'eof']); return null; }
    switch (t.u) {
      case 'EXPLAIN': {
        this.next();
        while (this.acceptW('ANALYZE', 'VERBOSE', 'PLAN', 'FOR', 'QUERY')) { /* skip */ }
        if (this.isT('(')) this.skipParens();
        this.note('EXPLAIN was removed: the statement after it is explained instead.', t);
        return this.statement();
      }
      case 'INSERT': case 'UPSERT': case 'REPLACE': return this.insert();
      case 'UPDATE': return this.update();
      case 'DELETE': return this.del();
      case 'MERGE': return this.merge();
      case 'CREATE': {
        if (this.isRoutineCreate()) { const r = this.routineExtent(); return { type: 'routine', keyword: this.text(t.s, r.e).match(/^\s*CREATE\s+(?:OR\s+(?:REPLACE|ALTER)\s+)?(?:EDITIONABLE\s+|NONEDITIONABLE\s+|DEFINER\s*=\s*\S+\s+)?(\w+(?:\s+BODY)?)/i)[1].toUpperCase(), s: r.s, e: r.e, line: t.line }; }
        return this.create();
      }
      case 'DO': if (this.isT('str', 1) || this.isW('LANGUAGE', 1)) { const r = this.routineExtent(); return { type: 'routine', keyword: 'DO', s: r.s, e: r.e, line: t.line }; } break;
      case 'DECLARE': case 'BEGIN': {
        if (t.u === 'BEGIN' && this.isW(['TRANSACTION', 'TRAN', 'WORK', 'ISOLATION'], 1) && this.dialect !== 'sqlserver') break;
        if (t.u === 'BEGIN' && (this.isT(';', 1) || this.isT('eof', 1))) break;
        const r = this.routineExtent();
        return { type: 'routine', keyword: this.dialect === 'sqlserver' ? 'BATCH' : 'BLOCK', s: r.s, e: r.e, line: t.line };
      }
      case 'SET': case 'IF': case 'WHILE': case 'PRINT': case 'EXEC': case 'EXECUTE':
        if (this.dialect === 'sqlserver' && !(t.u === 'SET' && this.isW(['NOCOUNT', 'ANSI_NULLS', 'QUOTED_IDENTIFIER', 'XACT_ABORT', 'TRANSACTION', 'STATISTICS', 'ANSI_WARNINGS', 'ARITHABORT'], 1))) {
          const r = this.routineExtent();
          return { type: 'routine', keyword: 'BATCH', s: r.s, e: r.e, line: t.line };
        }
        break;
      default: break;
    }
    const r = this.skipBlock();
    return { type: 'skipped', keyword: t.u, s: r.s, e: r.e, line: t.line };
  }

  isRoutineCreate() {
    for (let k = 1; k < 6; k++) {
      const t = this.peek(k);
      if (t.t !== 'word') return false;
      if (['FUNCTION', 'PROCEDURE', 'PROC', 'TRIGGER', 'PACKAGE', 'TYPE'].includes(t.u)) return t.u !== 'TYPE' || this.isW('BODY', k + 1);
      if (!['OR', 'REPLACE', 'ALTER', 'EDITIONABLE', 'NONEDITIONABLE', 'DEFINER', 'CONSTRAINT', 'AGGREGATE'].includes(t.u)) return false;
    }
    return false;
  }

  skipBlock() {
    // BEGIN ... END blocks (PL/SQL, T-SQL) may contain ';' - skip to the matching END.
    const start = this.peek();
    let depth = 0;
    while (!this.isT('eof')) {
      const t = this.peek();
      if (t.t === 'word' && (t.u === 'BEGIN' || (t.u === 'CASE'))) depth++;
      if (t.t === 'word' && t.u === 'END' && !this.isW(['IF', 'LOOP', 'WHILE', 'REPEAT'], 1)) depth = Math.max(0, depth - 1);
      if (t.t === ';' && depth === 0) break;
      this.next();
    }
    return { s: start.s, e: this.prev().e };
  }

  /**
   * Extent of a function / procedure / anonymous block, from the current token.
   * PostgreSQL: the body is one quoted token, so it ends at the next top-level ';'.
   * SQL Server: a procedure or script runs to the end of the batch (GO) or the file.
   * Oracle / PL/SQL: declarations, then BEGIN ... END; (END IF / END LOOP do not count).
   */
  routineExtent() {
    const start = this.peek();
    let pgStyle = false;
    for (let k = 0, depth = 0; ; k++) {
      const t = this.peek(k);
      if (t.t === 'eof' || (t.t === ';' && depth === 0)) break;
      if (t.t === '(') depth++;
      if (t.t === ')') depth--;
      if (t.t === 'str' && (t.dollar || (this.peek(k - 1).t === 'word' && ['AS', 'DO'].includes(this.peek(k - 1).u)))) { pgStyle = true; break; }
      if (t.t === 'word' && (t.u === 'BEGIN' || t.u === 'IS' || t.u === 'DECLARE')) break;
    }
    const tsql = this.dialect === 'sqlserver';
    let depth = 0;
    let seenBegin = false;
    while (!this.isT('eof')) {
      const t = this.peek();
      if (pgStyle) { if (t.t === ';') break; this.next(); continue; }
      if (tsql) { if (t.t === ';' && t.batch) break; this.next(); continue; }
      if (t.t === ';' && t.batch) break;
      if (t.t === 'word' && (t.u === 'BEGIN' || t.u === 'CASE')) { depth++; if (t.u === 'BEGIN') seenBegin = true; }
      if (t.t === 'word' && t.u === 'END' && !this.isW(['IF', 'LOOP', 'WHILE', 'REPEAT'], 1)) depth = Math.max(0, depth - 1);
      if (t.t === ';' && depth === 0 && seenBegin) break;
      this.next();
    }
    return { s: start.s, e: this.prev().e };
  }

  skipParens() {
    let depth = 0;
    do {
      const t = this.next();
      if (t.t === '(') depth++;
      else if (t.t === ')') depth--;
      else if (t.t === 'eof') break;
    } while (depth > 0);
  }

  qualifiedName() {
    const start = this.peek();
    const parts = [];
    const first = this.peek();
    if (first.t !== 'word' && first.t !== 'qid') throw new ParseError(`Expected a name but found "${first.v || 'end of query'}"`, first);
    parts.push(identName(this.next()));
    while (this.isT('.') && (this.isT('word', 1) || this.isT('qid', 1) || this.isOp('*', 1))) {
      this.next();
      if (this.isOp('*')) { this.next(); parts.push('*'); break; }
      parts.push(identName(this.next()));
    }
    // SQL Server db..table
    while (this.isT('.') && this.isT('.', 1)) { this.next(); this.next(); parts.push(''); parts.push(identName(this.next())); }
    return { parts: parts.filter((x) => x !== ''), s: start.s, e: this.prev().e };
  }

  /** INTO target: a name (v_x, rec.field, schema.table) or a T-SQL/bind variable (@x, :x). */
  intoTarget() {
    if (this.isT('param')) { const t = this.next(); return { parts: [t.v], s: t.s, e: t.e, variable: true }; }
    return this.qualifiedName();
  }

  /** RETURNING ... [INTO a, b] (PL/pgSQL, PL/SQL) */
  returningClause() {
    const list = this.selectList();
    let into = null;
    if (this.acceptW('INTO')) { this.acceptW('STRICT'); into = [this.intoTarget()]; while (this.acceptT(',')) into.push(this.intoTarget()); }
    return { list, into };
  }

  identList() {
    this.expectT('(');
    const out = [];
    do { const t = this.next(); out.push(identName(t)); while (!this.isT(',') && !this.isT(')') && !this.isT('eof')) this.next(); } while (this.acceptT(','));
    this.expectT(')');
    return out;
  }

  insert() {
    const start = this.next();
    this.acceptW('OR'); this.acceptW('REPLACE', 'IGNORE', 'ROLLBACK', 'ABORT', 'FAIL');
    this.acceptW('IGNORE', 'OVERWRITE', 'ALL', 'LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY');
    this.acceptW('INTO', 'TABLE');
    const table = this.qualifiedName();
    let alias = null;
    if (this.acceptW('AS')) alias = identName(this.next());
    let columns = null;
    if (this.isT('(') && !this.isW(['SELECT', 'WITH'], 1)) columns = this.identList();
    let query = null;
    let rows = null;
    if (this.isW('VALUES')) {
      rows = this.values();
    } else if (this.isW('DEFAULT')) {
      this.next(); this.acceptW('VALUES');
    } else if (this.isW(['SELECT', 'WITH']) || this.isT('(')) {
      query = this.query();
    } else if (this.isW('SET')) {
      // MySQL INSERT ... SET a = 1
      this.next();
      rows = { type: 'values', rows: [[]] };
      do { this.qualifiedName(); this.expectOpEq(); rows.rows[0].push(this.expr()); } while (this.acceptT(','));
    }
    let conflict = null;
    if (this.isW('ON')) { const t = this.peek(); this.skipUntil(new Set(['RETURNING']), [';', 'eof']); conflict = this.text(t.s, this.prev().e); }
    let returning = null;
    if (this.acceptW('RETURNING')) returning = this.returningClause();
    return this.node('insert', start, { table, alias, columns, query, values: rows, conflict, returning });
  }

  expectOpEq() { if (!this.acceptOp('=')) throw new ParseError('Expected "="', this.peek()); }

  values() {
    const start = this.expectW('VALUES');
    const rows = [];
    do {
      this.acceptW('ROW');
      this.expectT('(');
      const row = [];
      if (!this.isT(')')) do { row.push(this.expr()); } while (this.acceptT(','));
      this.expectT(')');
      rows.push(row);
    } while (this.acceptT(','));
    return this.node('values', start, { rows });
  }

  update() {
    const start = this.next();
    this.acceptW('ONLY');
    if (this.isW('TOP')) { this.next(); if (this.isT('(')) this.skipParens(); else this.next(); }
    const targetItem = this.fromItem(); // MySQL: UPDATE a JOIN b ON ... SET ...
    const target = targetItem.source;
    const targetJoins = targetItem.joins;
    const set = [];
    this.expectW('SET');
    do {
      const s0 = this.peek();
      let cols;
      if (this.isT('(')) cols = this.identList().map((x) => ({ parts: [x] }));
      else cols = [this.qualifiedName()];
      this.expectOpEq();
      const value = this.expr();
      set.push({ columns: cols, value, s: s0.s, e: this.prev().e });
    } while (this.acceptT(','));
    let from = null;
    if (this.acceptW('FROM')) from = this.fromList();
    let where = null;
    if (this.acceptW('WHERE')) where = this.guard(() => this.expr(), 'the WHERE clause');
    let returning = null;
    if (this.acceptW('RETURNING')) returning = this.returningClause();
    if (this.isW('OUTPUT')) this.skipUntil(new Set(['WHERE']), [';', 'eof']);
    return this.node('update', start, { target, targetJoins, set, from, where, returning });
  }

  del() {
    const start = this.next();
    if (this.isW('TOP')) { this.next(); if (this.isT('(')) this.skipParens(); else this.next(); }
    let target;
    let from = null;
    if (this.acceptW('FROM')) {
      target = this.source();
      if (this.acceptW('FROM') || this.acceptW('USING')) from = this.fromList();
    } else {
      // T-SQL: DELETE alias FROM table alias JOIN ...
      const alias = this.qualifiedName();
      if (this.acceptW('FROM')) {
        from = this.fromList();
        target = { type: 'table', name: alias, alias: null, aliasRef: alias.parts[alias.parts.length - 1], s: alias.s, e: alias.e };
      } else {
        target = { type: 'table', name: alias, alias: null, s: alias.s, e: alias.e };
      }
    }
    let where = null;
    if (this.acceptW('WHERE')) where = this.guard(() => this.expr(), 'the WHERE clause');
    let returning = null;
    if (this.acceptW('RETURNING')) returning = this.returningClause();
    return this.node('delete', start, { target, from, where, returning });
  }

  merge() {
    const start = this.next();
    this.acceptW('INTO');
    const target = this.source();
    this.expectW('USING');
    const using = this.source();
    this.expectW('ON');
    const on = this.expr();
    const whens = [];
    while (this.acceptW('WHEN')) {
      const s0 = this.prev();
      const not = !!this.acceptW('NOT');
      this.expectW('MATCHED');
      let by = null;
      if (this.acceptW('BY')) by = this.next().u;
      let cond = null;
      if (this.acceptW('AND')) cond = this.expr();
      this.expectW('THEN');
      let action = 'other';
      let set = null;
      let columns = null;
      let values = null;
      if (this.acceptW('UPDATE')) {
        action = 'update'; this.expectW('SET'); set = [];
        do { const c = this.qualifiedName(); this.expectOpEq(); set.push({ columns: [c], value: this.expr() }); } while (this.acceptT(','));
        if (this.acceptW('WHERE')) this.expr();
        if (this.acceptW('DELETE')) { this.acceptW('WHERE'); this.expr(); }
      } else if (this.acceptW('DELETE')) {
        action = 'delete';
      } else if (this.acceptW('INSERT')) {
        action = 'insert';
        if (this.isT('(')) columns = this.identList();
        if (this.isW('VALUES')) values = this.values();
        if (this.acceptW('WHERE')) this.expr();
      } else if (this.acceptW('DO')) { this.acceptW('NOTHING'); action = 'nothing'; }
      whens.push({ matched: !not, by, cond, action, set, columns, values, s: s0.s, e: this.prev().e });
    }
    return this.node('merge', start, { target, using, on, whens });
  }

  create() {
    const start = this.next();
    this.acceptW('OR'); this.acceptW('REPLACE', 'ALTER');
    let temp = false;
    while (this.isW(['TEMP', 'TEMPORARY', 'GLOBAL', 'LOCAL', 'TRANSIENT', 'VOLATILE', 'MATERIALIZED', 'SECURE', 'RECURSIVE', 'FORCE', 'NOFORCE', 'EDITIONABLE', 'UNLOGGED', 'EXTERNAL'])) {
      if (this.isW(['TEMP', 'TEMPORARY', 'VOLATILE'])) temp = true;
      this.next();
    }
    const kindTok = this.peek();
    if (this.isW(['VIEW', 'TABLE'])) {
      const objectKind = this.next().u === 'VIEW' ? (this.text(start.s, kindTok.s).toUpperCase().includes('MATERIALIZED') ? 'materialized view' : 'view') : 'table';
      if (this.isW('IF')) { this.next(); this.acceptW('NOT'); this.expectW('EXISTS'); }
      const name = this.qualifiedName();
      let columns = null;
      if (objectKind !== 'table' && this.isT('(')) columns = this.identList();
      // skip options until AS
      if (objectKind === 'table' && this.isT('(')) {
        const r = this.skipBlock();
        return { type: 'ddl', keyword: 'CREATE TABLE', name, s: start.s, e: r.e, line: start.line };
      }
      while (!this.isW('AS') && !this.atEnd()) this.next();
      if (!this.acceptW('AS')) return { type: 'ddl', keyword: `CREATE ${objectKind.toUpperCase()}`, name, s: start.s, e: this.prev().e, line: start.line };
      const query = this.query();
      if (this.isW('WITH')) this.skipUntil(new Set(), [';', 'eof']);
      return this.node('create', start, { objectKind, temp, name, columns, query });
    }
    const r = this.skipBlock();
    return { type: 'ddl', keyword: `CREATE ${kindTok.u || ''}`.trim(), s: start.s, e: r.e, line: start.line };
  }

  // ---------- queries ----------
  query() {
    const start = this.peek();
    let ctes = null;
    let recursive = false;
    if (this.acceptW('WITH')) {
      recursive = !!this.acceptW('RECURSIVE');
      ctes = [];
      do {
        const s0 = this.peek();
        const name = identName(this.next());
        let columns = null;
        if (this.isT('(')) columns = this.identList();
        this.expectW('AS');
        this.acceptW('NOT'); this.acceptW('MATERIALIZED');
        this.expectT('(');
        const q = this.query();
        this.expectT(')');
        // Postgres SEARCH / CYCLE clauses
        while (this.isW(['SEARCH', 'CYCLE'])) this.skipUntil(new Set(), [',', ';', 'eof', ')']);
        ctes.push({ type: 'cte', name, columns, query: q, recursive, s: s0.s, e: this.prev().e, nameTok: s0 });
      } while (this.acceptT(','));
      if (this.isW(['INSERT', 'UPDATE', 'DELETE', 'MERGE'])) {
        const dml = this.statement();
        dml.ctes = ctes;
        return { type: 'query', dml, s: start.s, e: this.prev().e };
      }
    }
    const body = this.setExpr();
    const tail = this.queryTail();
    return this.node('query', start, { ctes, recursive, body, ...tail });
  }

  queryTail() {
    const out = { orderBy: null, limit: null, offset: null, fetch: null, forUpdate: null };
    if (this.isW('ORDER') && this.isW('BY', 1)) { this.next(); this.next(); out.orderBy = this.orderItems(); }
    for (let guard = 0; guard < 4; guard++) {
      if (this.acceptW('LIMIT')) {
        const a = this.expr();
        if (this.acceptT(',')) { out.offset = a; out.limit = this.expr(); } else out.limit = a; // MySQL LIMIT off, n
        if (this.acceptW('OFFSET')) out.offset = this.expr();
        continue;
      }
      if (this.acceptW('OFFSET')) { out.offset = this.expr(); this.acceptW('ROW', 'ROWS'); continue; }
      if (this.isW('FETCH')) {
        this.next(); this.acceptW('FIRST', 'NEXT');
        const n = this.isW(['ROW', 'ROWS']) ? { type: 'lit', kind: 'number', value: 1, raw: '1' } : this.expr();
        this.acceptW('PERCENT');
        this.acceptW('ROW', 'ROWS');
        const ties = !!(this.acceptW('WITH') && this.acceptW('TIES'));
        this.acceptW('ONLY');
        out.fetch = n; out.limit = out.limit || n; out.ties = ties;
        continue;
      }
      break;
    }
    if (this.isW('FOR') && this.isW(['UPDATE', 'SHARE', 'NO', 'KEY', 'READ', 'XML', 'JSON', 'BROWSE'], 1)) { const t = this.peek(); this.skipUntil(new Set(), [';', 'eof', ')']); out.forUpdate = this.text(t.s, this.prev().e); }
    if (this.isW('OPTION') && this.isT('(', 1)) { this.next(); this.skipParens(); }
    return out;
  }

  setExpr() {
    let left = this.setPrimary();
    while (this.isW(['UNION', 'INTERSECT', 'EXCEPT', 'MINUS'])) {
      const opTok = this.next();
      let all = false;
      if (this.acceptW('ALL')) all = true;
      else this.acceptW('DISTINCT');
      // BigQuery/Snowflake: UNION ALL BY NAME
      if (this.acceptW('BY')) this.acceptW('NAME');
      const right = this.setPrimary();
      left = { type: 'setop', op: opTok.u === 'MINUS' ? 'EXCEPT' : opTok.u, all, left, right, s: left.s, e: right.e, opTok };
    }
    return left;
  }

  setPrimary() {
    if (this.isT('(')) {
      const start = this.next();
      const q = this.query();
      this.expectT(')');
      return { type: 'pquery', query: q, s: start.s, e: this.prev().e };
    }
    if (this.isW('VALUES')) return this.values();
    if (this.isW('SELECT')) return this.select();
    if (this.isW('TABLE')) { const s = this.next(); const name = this.qualifiedName(); return this.node('select', s, { columns: [{ type: 'star', expr: { type: 'star', s: s.s, e: s.e }, s: s.s, e: s.e }], from: [{ source: { type: 'table', name, alias: null, s: name.s, e: name.e }, joins: [] }] }); }
    throw new ParseError(`Expected SELECT but found "${this.peek().v || 'end of query'}"`, this.peek());
  }

  select() {
    const start = this.expectW('SELECT');
    const sel = { type: 'select', s: start.s, e: start.e, distinct: false, distinctOn: null, top: null, columns: [], into: null, from: [], where: null, connectBy: null, groupBy: null, having: null, qualify: null, windows: null };
    // hints /*+ ... */ are comments already
    if (this.acceptW('DISTINCT') || this.acceptW('UNIQUE')) {
      sel.distinct = true;
      if (this.acceptW('ON')) { this.expectT('('); sel.distinctOn = []; do sel.distinctOn.push(this.expr()); while (this.acceptT(',')); this.expectT(')'); }
    } else this.acceptW('ALL');
    this.acceptW('STRAIGHT_JOIN', 'SQL_CALC_FOUND_ROWS', 'SQL_NO_CACHE', 'HIGH_PRIORITY');
    if (this.isW('TOP')) {
      const t = this.next();
      let n;
      if (this.isT('(')) { this.next(); n = this.expr(); this.expectT(')'); } else n = this.primary();
      const percent = !!this.acceptW('PERCENT');
      const ties = !!(this.isW('WITH') && this.isW('TIES', 1) && this.next() && this.next());
      sel.top = { n, percent, ties, s: t.s, e: this.prev().e };
    }
    sel.columns = this.selectList();
    if (this.isW('INTO') && !this.isW('OUTFILE', 1)) {
      this.next();
      const t = this.peek();
      this.acceptW('STRICT');
      sel.into = this.intoTarget();
      sel.intoList = [sel.into];
      while (this.acceptT(',')) sel.intoList.push(this.intoTarget()); // PL/SQL INTO a, b
      void t;
    }
    if (this.acceptW('FROM')) sel.from = this.fromList();
    if (this.acceptW('WHERE')) sel.where = this.guard(() => this.expr(), 'the WHERE clause');
    if (this.isW(['START', 'CONNECT'])) {
      const t = this.peek();
      sel.connectBy = { s: t.s };
      for (let k = 0; k < 2 && this.isW(['START', 'CONNECT']); k++) {
        if (this.acceptW('START')) { this.expectW('WITH'); sel.connectBy.start = this.expr(); }
        if (this.acceptW('CONNECT')) { this.expectW('BY'); this.acceptW('NOCYCLE'); sel.connectBy.cond = this.expr(); }
      }
      sel.connectBy.e = this.prev().e;
    }
    if (this.isW('GROUP') && this.isW('BY', 1)) {
      const g = this.next(); this.next();
      sel.groupBy = this.guard(() => this.groupItems(g), 'the GROUP BY clause');
    }
    if (this.acceptW('HAVING')) sel.having = this.guard(() => this.expr(), 'the HAVING clause');
    if (this.acceptW('WINDOW')) {
      sel.windows = [];
      do { const name = identName(this.next()); this.expectW('AS'); sel.windows.push({ name, spec: this.windowSpec() }); } while (this.acceptT(','));
    }
    if (this.acceptW('QUALIFY')) sel.qualify = this.guard(() => this.expr(), 'the QUALIFY clause');
    sel.e = this.prev().e;
    return sel;
  }

  selectList() {
    const items = [];
    do {
      items.push(this.guard(() => this.selectItem(), 'a selected column', CLAUSE_STOP, [';', 'eof', ')', ',']));
    } while (this.acceptT(','));
    return items;
  }

  selectItem() {
    const start = this.peek();
    // T-SQL variable assignment: SELECT @total = SUM(x)
    if (start.t === 'param' && /^@/.test(start.v) && this.isOp('=', 1)) {
      this.next(); this.next();
      const expr = this.expr();
      return { type: 'item', expr, alias: start.v, assignTo: start.v, s: start.s, e: this.prev().e };
    }
    // SQL Server: SELECT Total = SUM(x)
    if ((start.t === 'word' || start.t === 'qid') && this.isOp('=', 1) && !KEYWORDS.has(start.u || '') && this.dialectIs('sqlserver')) {
      this.next(); this.next();
      const expr = this.expr();
      return { type: 'item', expr, alias: identName(start), s: start.s, e: this.prev().e };
    }
    if (this.isOp('*')) {
      this.next();
      const star = { type: 'star', parts: ['*'], s: start.s, e: this.prev().e };
      this.starModifiers(star);
      return { type: 'item', expr: star, alias: null, s: start.s, e: this.prev().e };
    }
    const expr = this.expr();
    if (expr.type === 'col' && expr.parts[expr.parts.length - 1] === '*') {
      expr.type = 'star';
      this.starModifiers(expr);
      return { type: 'item', expr, alias: null, s: start.s, e: this.prev().e };
    }
    const alias = this.alias();
    return { type: 'item', expr, alias, s: start.s, e: this.prev().e };
  }

  starModifiers(star) {
    // Snowflake * EXCLUDE (a, b) / BigQuery * EXCEPT (a) / * REPLACE (...)
    while (this.isW(['EXCLUDE', 'EXCEPT', 'REPLACE', 'RENAME', 'ILIKE']) && (this.isT('(', 1) || this.isT('word', 1) || this.isT('str', 1)) && !this.isW(['SELECT', 'WITH'], 2)) {
      const kw = this.next().u;
      if (this.isT('(')) { const s = this.peek(); this.skipParens(); (star.modifiers ||= []).push(`${kw} ${this.text(s.s, this.prev().e)}`); } else { (star.modifiers ||= []).push(`${kw} ${this.next().v}`); }
    }
  }

  dialectIs(d) { return this.dialect === d || this.dialect === 'auto'; }

  alias() {
    if (this.acceptW('AS')) {
      const t = this.next();
      if (t.t === 'str') return t.value;
      return identName(t);
    }
    const t = this.peek();
    if (t.t === 'qid') { this.next(); return t.name; }
    if (t.t === 'word' && !NOT_ALIAS.has(t.u) && !JOIN_START.has(t.u)) { this.next(); return t.v; }
    if (t.t === 'str' && this.dialectIs('sqlserver')) { this.next(); return t.value; }
    return null;
  }

  // ---------- FROM ----------
  fromList() {
    const items = [];
    do {
      items.push(this.guard(() => this.fromItem(), 'the FROM clause', CLAUSE_STOP, [';', 'eof', ')', ',']));
    } while (this.acceptT(','));
    return items;
  }

  fromItem() {
    const start = this.peek();
    const source = this.source();
    const joins = [];
    for (;;) {
      const j = this.join();
      if (!j) break;
      joins.push(j);
    }
    return { type: 'from', source, joins, s: start.s, e: this.prev().e };
  }

  join() {
    const start = this.peek();
    let kind = null;
    let natural = false;
    if (this.isW('NATURAL')) { this.next(); natural = true; }
    if (this.isW('CROSS') && this.isW('APPLY', 1)) { this.next(); this.next(); kind = 'CROSS APPLY'; }
    else if (this.isW('OUTER') && this.isW('APPLY', 1)) { this.next(); this.next(); kind = 'OUTER APPLY'; }
    else if (this.isW('STRAIGHT_JOIN')) { this.next(); kind = 'INNER'; }
    else if (this.isW('JOIN')) { this.next(); kind = 'INNER'; }
    else if (this.isW(['INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'SEMI', 'ANTI', 'ASOF'])) {
      const save = this.i;
      const k = this.next().u;
      this.acceptW('OUTER');
      this.acceptW('SEMI', 'ANTI');
      if (!this.acceptW('JOIN')) { this.i = save; return null; }
      kind = k;
    } else {
      if (natural) throw new ParseError('Expected JOIN after NATURAL', this.peek());
      return null;
    }
    const lateral = !!this.acceptW('LATERAL');
    const source = this.source();
    if (lateral) source.lateral = true;
    let on = null;
    let using = null;
    if (this.acceptW('ON')) on = this.guard(() => this.expr(), 'a join condition', new Set([...CLAUSE_STOP, ...JOIN_START]));
    else if (this.isW('USING') && this.isT('(', 1)) { this.next(); using = this.identList(); }
    return { type: 'join', kind, natural, source, on, using, s: start.s, e: this.prev().e };
  }

  source() {
    const start = this.peek();
    let src;
    const lateral = !!this.acceptW('LATERAL');
    if (this.isT('(')) {
      if (this.isW(['SELECT', 'WITH', 'VALUES'], 1) || (this.isT('(', 1) && this.looksLikeQueryParen())) {
        this.next();
        const q = this.query();
        this.expectT(')');
        src = { type: 'derived', query: q, s: start.s, e: this.prev().e };
      } else {
        this.next();
        const inner = this.fromItem();
        this.expectT(')');
        src = { type: 'group', item: inner, s: start.s, e: this.prev().e };
      }
    } else if (this.isW('TABLE') && this.isT('(', 1)) {
      this.next();
      const call = this.primary();
      src = { type: 'function', call, name: { parts: ['TABLE'] }, s: start.s, e: this.prev().e };
    } else if (this.isW('VALUES')) {
      src = { ...this.values(), type: 'valuesrc' };
    } else {
      this.acceptW('ONLY');
      const name = this.qualifiedName();
      if (this.isT('(')) {
        // table function: UNNEST(...), generate_series(...), FLATTEN(input => ...), OPENJSON(...)
        this.i -= 0;
        const call = this.callRest(name, start);
        src = { type: 'function', call, name, s: start.s, e: this.prev().e };
      } else {
        src = { type: 'table', name, s: name.s, e: name.e };
      }
      if (this.acceptOp('*')) src.inherit = true;
    }
    if (lateral) src.lateral = true;
    this.sourceSuffix(src);
    src.alias = this.alias();
    if (src.alias && this.isT('(') && !this.isW(['SELECT', 'WITH'], 1) && (this.isT('word', 1) || this.isT('qid', 1))) src.columnAliases = this.identList();
    this.sourceSuffix(src);
    src.e = this.prev().e;
    return src;
  }

  looksLikeQueryParen() {
    // ((SELECT ...) UNION (SELECT ...)) as a derived table
    let k = 1;
    while (this.isT('(', k)) k++;
    return this.isW(['SELECT', 'WITH'], k);
  }

  sourceSuffix(src) {
    for (let guard = 0; guard < 6; guard++) {
      if (this.isW('WITH') && this.isT('(', 1) && !this.isW(['SELECT'], 2)) {
        // T-SQL table hints WITH (NOLOCK)
        const s = this.next();
        this.skipParens();
        src.hints = this.text(s.s, this.prev().e);
        continue;
      }
      if (this.isT('(') && this.isW(['NOLOCK', 'READPAST', 'UPDLOCK', 'ROWLOCK', 'HOLDLOCK', 'NOEXPAND', 'INDEX', 'TABLOCK'], 1)) {
        const s = this.peek(); this.skipParens(); src.hints = this.text(s.s, this.prev().e); continue;
      }
      if (this.isW(['TABLESAMPLE', 'SAMPLE']) && (this.isT('(', 1) || this.isW(['BERNOULLI', 'SYSTEM', 'ROW', 'BLOCK'], 1))) {
        this.next(); while (this.isT('word')) this.next(); if (this.isT('(')) this.skipParens(); if (this.acceptW('REPEATABLE', 'SEED')) this.skipParens(); continue;
      }
      if (this.isW(['PIVOT', 'UNPIVOT']) && (this.isT('(', 1) || this.isW(['INCLUDE', 'EXCLUDE'], 1))) {
        const s = this.next(); this.acceptW('INCLUDE', 'EXCLUDE'); this.acceptW('NULLS'); this.skipParens();
        src.pivot = this.text(s.s, this.prev().e);
        continue;
      }
      if (this.isW('FOR') && this.isW('SYSTEM_TIME', 1)) { this.skipUntil(new Set(['WHERE', 'JOIN', 'LEFT', 'INNER', 'ON', 'GROUP', 'ORDER']), [';', 'eof', ')', ',']); continue; }
      if (this.isW(['AT', 'BEFORE']) && this.isT('(', 1)) { this.next(); this.skipParens(); continue; }
      if (this.isW('PARTITION') && this.isT('(', 1)) { this.next(); this.skipParens(); continue; }
      if (this.isW(['USE', 'FORCE', 'IGNORE']) && this.isW(['INDEX', 'KEY'], 1)) { this.next(); this.next(); this.acceptW('FOR'); if (this.isW(['JOIN', 'ORDER', 'GROUP'])) { this.next(); this.acceptW('BY'); } this.skipParens(); continue; }
      break;
    }
  }

  // ---------- GROUP / ORDER ----------
  groupItems(gTok) {
    const items = [];
    let kind = 'plain';
    this.acceptW('ALL', 'DISTINCT');
    do {
      if (this.isW(['ROLLUP', 'CUBE']) && this.isT('(', 1)) {
        kind = this.next().u.toLowerCase();
        this.expectT('(');
        do items.push(this.expr()); while (this.acceptT(','));
        this.expectT(')');
      } else if (this.isW('GROUPING') && this.isW('SETS', 1)) {
        this.next(); this.next(); kind = 'grouping sets';
        this.expectT('(');
        do { if (this.isT('(')) { this.next(); if (!this.isT(')')) do items.push(this.expr()); while (this.acceptT(',')); this.expectT(')'); } else items.push(this.expr()); } while (this.acceptT(','));
        this.expectT(')');
      } else if (this.isT('(') && this.isT(')', 1)) {
        this.next(); this.next();
      } else {
        items.push(this.expr());
      }
    } while (this.acceptT(','));
    if (this.acceptW('WITH')) { const k = this.next().u; kind = k === 'ROLLUP' ? 'rollup' : k === 'CUBE' ? 'cube' : kind; }
    return { type: 'groupby', kind, items, s: gTok.s, e: this.prev().e };
  }

  orderItems() {
    const items = [];
    do {
      items.push(this.guard(() => {
        const s0 = this.peek();
        const expr = this.expr();
        let dir = null;
        if (this.isW(['ASC', 'DESC'])) dir = this.next().u;
        let nulls = null;
        if (this.acceptW('NULLS')) nulls = this.next().u;
        if (this.acceptW('USING')) this.next();
        return { type: 'orderitem', expr, dir, nulls, s: s0.s, e: this.prev().e };
      }, 'the ORDER BY clause', new Set([...CLAUSE_STOP, 'ROWS', 'RANGE', 'GROUPS']), [';', 'eof', ')', ',']));
    } while (this.acceptT(','));
    return items;
  }

  // ---------- expressions (Pratt parser) ----------
  expr(minBp = 0) {
    let left = this.prefix();
    for (;;) {
      const t = this.peek();
      const info = this.infix(t);
      if (!info || info.bp <= minBp) break;
      left = info.parse(left);
    }
    return left;
  }

  infix(t) {
    const P = this;
    const bin = (op, bp, rightBp = bp) => ({ bp, parse: (left) => { P.next(); const right = P.expr(rightBp); return { type: 'bin', op, left, right, s: left.s, e: right.e }; } });
    if (t.t === 'word') {
      switch (t.u) {
        case 'OR': return bin('OR', 10);
        case 'XOR': return bin('XOR', 10);
        case 'AND': return bin('AND', 20);
        case 'IS': return { bp: 40, parse: (left) => this.isExpr(left) };
        case 'IN': return { bp: 40, parse: (left) => this.inExpr(left, false) };
        case 'BETWEEN': return { bp: 40, parse: (left) => this.betweenExpr(left, false) };
        case 'LIKE': case 'ILIKE': case 'RLIKE': case 'REGEXP': case 'GLOB': case 'MATCH':
          return { bp: 40, parse: (left) => this.likeExpr(left, false) };
        case 'SIMILAR': return { bp: 40, parse: (left) => { this.next(); this.expectW('TO'); const right = this.expr(40); return { type: 'like', op: 'SIMILAR TO', not: false, left, right, s: left.s, e: right.e }; } };
        case 'NOT': {
          const n1 = this.peek(1);
          if (n1.t !== 'word') return null;
          if (n1.u === 'IN') return { bp: 40, parse: (left) => { this.next(); return this.inExpr(left, true); } };
          if (n1.u === 'BETWEEN') return { bp: 40, parse: (left) => { this.next(); return this.betweenExpr(left, true); } };
          if (['LIKE', 'ILIKE', 'RLIKE', 'REGEXP', 'GLOB'].includes(n1.u)) return { bp: 40, parse: (left) => { this.next(); return this.likeExpr(left, true); } };
          if (n1.u === 'SIMILAR') return { bp: 40, parse: (left) => { this.next(); this.next(); this.expectW('TO'); const right = this.expr(40); return { type: 'like', op: 'SIMILAR TO', not: true, left, right, s: left.s, e: right.e }; } };
          return null;
        }
        case 'COLLATE': return { bp: 85, parse: (left) => { this.next(); const c = this.next(); return { ...left, collate: identName(c), e: this.prev().e }; } };
        case 'AT': if (this.isW('TIME', 1)) return { bp: 85, parse: (left) => { this.next(); this.next(); this.expectW('ZONE'); const z = this.expr(85); return { type: 'func', name: 'AT TIME ZONE', args: [left, z], s: left.s, e: z.e }; } }; return null;
        case 'OVERLAPS': return bin('OVERLAPS', 40);
        case 'DIV': return bin('DIV', 70);
        case 'MOD': return bin('%', 70);
        default: return null;
      }
    }
    if (t.t === 'op') {
      if (t.outer) return { bp: 95, parse: (left) => { this.next(); left.oracleOuter = true; left.e = this.prev().e; return left; } };
      switch (t.v) {
        case '=': case '<>': case '!=': case '<': case '>': case '<=': case '>=': case '<=>': case '^=': case '==':
          return { bp: 40, parse: (left) => this.compare(left) };
        case '~': case '~*': case '!~': case '!~*': case '@>': case '<@': case '&&': case '?|': case '?&':
          return bin(t.v, 40);
        case '||': return bin('||', 50);
        case '+': case '-': return bin(t.v, 60);
        case '*': case '/': case '%': return bin(t.v, 70);
        case '^': case '**': return bin(t.v, 75);
        case '&': case '|': case '<<': case '>>': return bin(t.v, 55);
        case '->': case '->>': case '#>': case '#>>': return bin(t.v, 88);
        case ':': return { bp: 92, parse: (left) => { this.next(); const k = this.next(); return { type: 'func', name: 'JSON PATH', args: [left, { type: 'lit', kind: 'string', value: identName(k), raw: k.v }], s: left.s, e: this.prev().e }; } };
        case '::': return { bp: 90, parse: (left) => { this.next(); const to = this.typeName(); return { type: 'cast', expr: left, to, s: left.s, e: this.prev().e }; } };
        case '[': return { bp: 95, parse: (left) => { this.next(); let idx = null; if (!this.isOp(']')) idx = this.expr(); if (this.acceptOp(':')) { if (!this.isOp(']')) this.expr(); } this.expectOpClose(']'); return { type: 'func', name: 'SUBSCRIPT', args: [left, idx].filter(Boolean), s: left.s, e: this.prev().e }; } };
        default: return null;
      }
    }
    if (t.t === '.' && (this.isT('word', 1) || this.isT('qid', 1))) {
      // (expr).field  / func().field
      return { bp: 95, parse: (left) => { this.next(); const f = this.next(); return { type: 'func', name: 'FIELD', args: [left, { type: 'lit', kind: 'string', value: identName(f), raw: f.v }], s: left.s, e: this.prev().e }; } };
    }
    return null;
  }

  expectOpClose(v) { if (!this.acceptOp(v)) throw new ParseError(`Expected "${v}"`, this.peek()); }

  compare(left) {
    const opTok = this.next();
    const op = opTok.v === '!=' || opTok.v === '^=' ? '<>' : opTok.v === '==' ? '=' : opTok.v;
    if (this.isW(['ANY', 'ALL', 'SOME']) && this.isT('(', 1)) {
      const q = this.next().u;
      const s0 = this.next();
      let query = null;
      let list = null;
      if (this.isW(['SELECT', 'WITH'])) query = this.query();
      else { list = []; do list.push(this.expr()); while (this.acceptT(',')); }
      this.expectT(')');
      return { type: 'quant', op, quant: q === 'SOME' ? 'ANY' : q, left, query, list, s: left.s, e: this.prev().e, inner: s0.s };
    }
    const right = this.expr(40);
    return { type: 'bin', op, left, right, s: left.s, e: right.e };
  }

  isExpr(left) {
    this.next();
    const not = !!this.acceptW('NOT');
    if (this.acceptW('NULL')) return { type: 'isnull', not, expr: left, s: left.s, e: this.prev().e };
    if (this.isW(['TRUE', 'FALSE', 'UNKNOWN'])) { const v = this.next().u; return { type: 'istruth', not, value: v, expr: left, s: left.s, e: this.prev().e }; }
    if (this.acceptW('DISTINCT')) { this.expectW('FROM'); const right = this.expr(40); return { type: 'bin', op: not ? 'IS NOT DISTINCT FROM' : 'IS DISTINCT FROM', left, right, s: left.s, e: right.e }; }
    if (this.acceptW('JSON')) { this.acceptW('OBJECT', 'ARRAY', 'SCALAR', 'VALUE'); return { type: 'istruth', not, value: 'JSON', expr: left, s: left.s, e: this.prev().e }; }
    throw new ParseError('Expected NULL, TRUE, FALSE or DISTINCT FROM after IS', this.peek());
  }

  inExpr(left, not) {
    this.expectW('IN');
    if (this.isW('UNNEST')) { const r = this.expr(40); return { type: 'in', not, left, list: [r], s: left.s, e: r.e }; }
    if (!this.isT('(')) { const r = this.primary(); return { type: 'in', not, left, list: [r], s: left.s, e: r.e }; } // IN :param
    const open = this.next();
    if (this.isW(['SELECT', 'WITH'])) {
      const query = this.query();
      this.expectT(')');
      return { type: 'in', not, left, query, s: left.s, e: this.prev().e, inner: open.s };
    }
    const list = [];
    if (!this.isT(')')) do list.push(this.expr()); while (this.acceptT(','));
    this.expectT(')');
    return { type: 'in', not, left, list, s: left.s, e: this.prev().e };
  }

  betweenExpr(left, not) {
    this.expectW('BETWEEN');
    this.acceptW('SYMMETRIC', 'ASYMMETRIC');
    const low = this.expr(40);
    this.expectW('AND');
    const high = this.expr(40);
    return { type: 'between', not, left, low, high, s: left.s, e: high.e };
  }

  likeExpr(left, not) {
    const op = this.next().u;
    if (this.isW(['ANY', 'ALL', 'SOME']) && this.isT('(', 1)) {
      const q = this.next().u;
      this.next();
      const list = [];
      do list.push(this.expr()); while (this.acceptT(','));
      this.expectT(')');
      return { type: 'like', op, not, quant: q, left, list, right: list[0], s: left.s, e: this.prev().e };
    }
    const right = this.expr(40);
    let escape = null;
    if (this.acceptW('ESCAPE')) escape = this.primary();
    return { type: 'like', op, not, left, right, escape, s: left.s, e: this.prev().e };
  }

  prefix() {
    const t = this.peek();
    if (t.t === 'word') {
      if (t.u === 'NOT') {
        this.next();
        if (this.isW('EXISTS')) { const ex = this.prefix(); ex.not = !ex.not; ex.s = t.s; return ex; }
        const e = this.expr(30);
        return { type: 'not', expr: e, s: t.s, e: e.e };
      }
      if (t.u === 'PRIOR') { this.next(); const e = this.expr(80); return { ...e, prior: true, s: t.s }; }
    }
    if (t.t === 'op' && (t.v === '-' || t.v === '+' || t.v === '~')) {
      this.next();
      const e = this.expr(80);
      if (t.v === '-' && e.type === 'lit' && e.kind === 'number') return { ...e, value: -e.value, raw: `-${e.raw}`, s: t.s };
      return t.v === '+' ? e : { type: 'neg', op: t.v, expr: e, s: t.s, e: e.e };
    }
    return this.primary();
  }

  primary() {
    const t = this.peek();
    switch (t.t) {
      case 'num': this.next(); return { type: 'lit', kind: 'number', value: Number(t.v), raw: t.v, s: t.s, e: t.e };
      case 'str': this.next(); return { type: 'lit', kind: 'string', value: t.value, raw: t.v, s: t.s, e: t.e };
      case 'param': this.next(); return { type: 'param', raw: t.v, s: t.s, e: t.e };
      case '(': {
        this.next();
        if (this.isW(['SELECT', 'WITH']) || (this.isT('(') && this.looksLikeQueryParen0())) {
          const q = this.query();
          this.expectT(')');
          return { type: 'subquery', query: q, s: t.s, e: this.prev().e };
        }
        const first = this.expr();
        if (this.acceptT(',')) {
          const items = [first];
          do items.push(this.expr()); while (this.acceptT(','));
          this.expectT(')');
          return { type: 'tuple', items, s: t.s, e: this.prev().e };
        }
        this.expectT(')');
        return { ...first, paren: true, s: t.s, e: this.prev().e };
      }
      case 'op':
        if (t.v === '*') { this.next(); return { type: 'star', parts: ['*'], s: t.s, e: t.e }; }
        if (t.v === '[') { // array literal [1,2] (BigQuery/Snowflake/DuckDB)
          this.next(); const items = []; if (!this.isOp(']')) do items.push(this.expr()); while (this.acceptT(',')); this.expectOpClose(']');
          return { type: 'func', name: 'ARRAY', args: items, s: t.s, e: this.prev().e };
        }
        if (t.v === '{') { this.skipUntil(new Set(), [';', 'eof', ')', ',']); return { type: 'raw', text: this.text(t.s, this.prev().e), s: t.s, e: this.prev().e }; }
        break;
      case 'qid': return this.nameOrCall();
      case 'word': {
        const u = t.u;
        if (u === 'NULL') { this.next(); return { type: 'lit', kind: 'null', value: null, raw: t.v, s: t.s, e: t.e }; }
        if (u === 'TRUE' || u === 'FALSE') { this.next(); return { type: 'lit', kind: 'bool', value: u === 'TRUE', raw: t.v, s: t.s, e: t.e }; }
        if (u === 'CASE') return this.caseExpr();
        if (u === 'EXISTS' && this.isT('(', 1)) {
          this.next(); const open = this.next(); const q = this.query(); this.expectT(')');
          return { type: 'exists', not: false, query: q, s: t.s, e: this.prev().e, inner: open.s };
        }
        if ((u === 'CAST' || u === 'TRY_CAST' || u === 'SAFE_CAST') && this.isT('(', 1)) {
          this.next(); this.next();
          const e = this.expr();
          this.expectW('AS');
          const to = this.typeName();
          if (this.acceptW('FORMAT')) this.expr();
          this.expectT(')');
          return { type: 'cast', expr: e, to, fn: u, s: t.s, e: this.prev().e };
        }
        if (u === 'EXTRACT' && this.isT('(', 1)) {
          this.next(); this.next();
          const field = this.next();
          let source;
          if (this.acceptW('FROM') || this.acceptT(',')) source = this.expr();
          this.expectT(')');
          return { type: 'func', name: 'EXTRACT', args: [{ type: 'lit', kind: 'string', value: field.v.toUpperCase(), raw: field.v }, source], s: t.s, e: this.prev().e };
        }
        if (u === 'INTERVAL' && !this.isT('(', 1)) {
          this.next();
          const v = this.isT('str') || this.isT('num') ? this.next() : null;
          let value = v ? (v.t === 'str' ? v.value : v.v) : null;
          let expr = null;
          if (!v) expr = this.expr(80);
          let unit = null;
          if (this.isT('word') && /^(YEAR|MONTH|DAY|HOUR|MINUTE|SECOND|WEEK|QUARTER|MILLISECOND|MICROSECOND)S?$/.test(this.peek().u)) {
            unit = this.next().u.replace(/S$/, '');
            if (this.acceptW('TO')) this.next();
          }
          return { type: 'interval', value, unit, expr, s: t.s, e: this.prev().e };
        }
        if (TYPED_LITERALS.has(u) && this.isT('str', 1)) {
          this.next(); const v = this.next();
          return { type: 'lit', kind: u === 'DATE' ? 'date' : 'timestamp', value: v.value, raw: this.text(t.s, v.e), s: t.s, e: v.e };
        }
        if (u === 'ARRAY' && (this.isOp('[', 1) || this.isT('(', 1))) {
          this.next();
          if (this.acceptOp('[')) { const items = []; if (!this.isOp(']')) do items.push(this.expr()); while (this.acceptT(',')); this.expectOpClose(']'); return { type: 'func', name: 'ARRAY', args: items, s: t.s, e: this.prev().e }; }
          this.next(); const q = this.query(); this.expectT(')');
          return { type: 'func', name: 'ARRAY', args: [{ type: 'subquery', query: q, s: t.s, e: this.prev().e }], s: t.s, e: this.prev().e };
        }
        if (NO_PAREN_FUNCS.has(u) && !this.isT('(', 1) && !this.isT('.', 1)) {
          this.next();
          if ((u === 'CURRENT_TIMESTAMP' || u === 'SYSTIMESTAMP') && this.isT('(')) this.skipParens();
          return { type: 'func', name: u, args: [], noParens: true, s: t.s, e: this.prev().e };
        }
        if (KEYWORDS.has(u) && !['LEFT', 'RIGHT', 'REPLACE', 'FIRST', 'KEY', 'CURRENT', 'FILTER', 'SET', 'ROWS', 'RANGE', 'VALUES', 'DEFAULT', 'COLUMN', 'TABLE', 'VIEW', 'START', 'GROUPING', 'TOP', 'SAMPLE', 'NULLS', 'CHECK', 'INSERT'].includes(u) && !this.isT('(', 1)) {
          throw new ParseError(`Unexpected keyword ${u}`, t);
        }
        return this.nameOrCall();
      }
      default: break;
    }
    throw new ParseError(`Unexpected "${t.v || 'end of query'}"`, t);
  }

  looksLikeQueryParen0() {
    let k = 0;
    while (this.isT('(', k)) k++;
    return this.isW(['SELECT', 'WITH'], k);
  }

  nameOrCall() {
    const start = this.peek();
    const name = this.qualifiedName();
    if (this.isT('(')) return this.callRest(name, start);
    const parts = name.parts;
    if (parts[parts.length - 1] === '*') return { type: 'star', parts, s: name.s, e: name.e };
    return { type: 'col', parts, s: name.s, e: name.e };
  }

  callRest(name, start) {
    const fname = name.parts.join('.').toUpperCase();
    const short = name.parts[name.parts.length - 1].toUpperCase();
    this.expectT('(');
    const call = { type: 'func', name: short, fullName: fname, rawName: name.parts.join('.'), args: [], distinct: false, s: start.s, e: start.e };
    if (this.acceptW('DISTINCT')) call.distinct = true;
    else this.acceptW('ALL');
    if (!this.isT(')')) {
      do {
        if (this.isOp('*') && (this.isT(')', 1) || this.isT(',', 1))) { const st = this.next(); call.args.push({ type: 'star', parts: ['*'], s: st.s, e: st.e }); continue; }
        // named args: name => value / name := value
        if ((this.isT('word') || this.isT('qid')) && (this.isOp('=>', 1) || this.isOp(':=', 1))) { const k = this.next(); this.next(); const v = this.expr(); v.argName = identName(k); call.args.push(v); continue; }
        if ((short === 'CONVERT' || short === 'TRY_CONVERT') && call.args.length === 0 && this.isT('word') && /^(N?VARCHAR2?|N?CHAR|INT|INTEGER|BIGINT|SMALLINT|DATE|DATETIME2?|DECIMAL|NUMERIC|FLOAT|MONEY|BIT|TIME|UNIQUEIDENTIFIER|NVARCHAR)$/.test(this.peek().u)) {
          const tn = this.typeName(); call.args.push({ type: 'typename', name: tn, s: start.s, e: this.prev().e }); call.convertTypeFirst = true; continue;
        }
        const a = short === 'POSITION' && call.args.length === 0 ? this.expr(40) : this.expr();
        // trailing modifiers inside the call
        if (this.isW('AS') && (short === 'CONVERT' || short === 'CAST')) { this.next(); a.castTo = this.typeName(); }
        if (this.isW('USING') && short === 'CONVERT') { this.next(); this.next(); }
        if (this.isW(['IGNORE', 'RESPECT']) && this.isW('NULLS', 1)) { this.next(); this.next(); }
        if (this.isW('ORDER') && this.isW('BY', 1)) { this.next(); this.next(); call.orderBy = this.orderItems(); }
        if (this.acceptW('SEPARATOR')) call.separator = this.expr();
        if (this.isW('ON') && this.isW('OVERFLOW', 1)) this.skipUntil(new Set(), [')']);
        if (this.isW('FROM') && ['SUBSTRING', 'TRIM', 'POSITION', 'OVERLAY'].includes(short)) { this.next(); call.args.push(a); call.args.push(this.expr()); if (this.acceptW('FOR')) call.args.push(this.expr()); continue; }
        if (this.isW('IN') && short === 'POSITION') { this.next(); call.args.push(a); call.args.push(this.expr()); continue; }
        if (this.isW('FOR') && short === 'SUBSTRING') { this.next(); call.args.push(a); call.args.push(this.expr()); continue; }
        call.args.push(a);
      } while (this.acceptT(','));
    }
    // date-part keywords used as arguments: DATEADD(month, ...), DATEDIFF(day, ...), DATE_DIFF(a, b, DAY)
    if (DATE_UNIT_FUNCS.has(short)) {
      call.args = call.args.map((a) => (a.type === 'col' && a.parts.length === 1 && DATE_UNIT_RE.test(a.parts[0]) ? { type: 'lit', kind: 'unit', value: a.parts[0].toLowerCase(), raw: a.parts[0], s: a.s, e: a.e } : a));
    }
    if (short === 'TRIM' && call.args.length && call.args[0].type === 'col' && /^(BOTH|LEADING|TRAILING)$/i.test(call.args[0].parts[0])) call.args.shift();
    this.expectT(')');
    if (this.isW('WITHIN') && this.isW('GROUP', 1)) { this.next(); this.next(); this.expectT('('); this.expectW('ORDER'); this.expectW('BY'); call.orderBy = this.orderItems(); this.expectT(')'); }
    if (this.isW('FILTER') && this.isT('(', 1)) { this.next(); this.next(); this.expectW('WHERE'); call.filter = this.expr(); this.expectT(')'); }
    if (this.isW(['IGNORE', 'RESPECT']) && this.isW('NULLS', 1)) { this.next(); this.next(); }
    if (this.isW('KEEP') && this.isT('(', 1)) { this.next(); const s = this.peek(); this.skipParens(); call.keep = this.text(s.s, this.prev().e); }
    if (this.acceptW('OVER')) {
      if (this.isT('(')) call.over = this.windowSpec();
      else call.over = { name: identName(this.next()), partitionBy: [], orderBy: [] };
    }
    call.e = this.prev().e;
    return call;
  }

  windowSpec() {
    const start = this.expectT('(');
    const spec = { name: null, partitionBy: [], orderBy: [], frame: null, s: start.s };
    if ((this.isT('word') || this.isT('qid')) && !this.isW(['PARTITION', 'ORDER', 'ROWS', 'RANGE', 'GROUPS'])) spec.name = identName(this.next());
    if (this.isW('PARTITION') && this.isW('BY', 1)) { this.next(); this.next(); do spec.partitionBy.push(this.expr()); while (this.acceptT(',')); }
    if (this.isW('ORDER') && this.isW('BY', 1)) { this.next(); this.next(); spec.orderBy = this.orderItems(); }
    if (this.isW(['ROWS', 'RANGE', 'GROUPS'])) {
      const f = this.peek();
      let depth = 0;
      while (!this.isT('eof') && !(depth === 0 && this.isT(')'))) { if (this.isT('(')) depth++; if (this.isT(')')) depth--; this.next(); }
      spec.frame = this.text(f.s, this.prev().e);
    }
    this.expectT(')');
    spec.e = this.prev().e;
    return spec;
  }

  caseExpr() {
    const start = this.next();
    let operand = null;
    if (!this.isW('WHEN')) operand = this.expr();
    const whens = [];
    while (this.acceptW('WHEN')) {
      const when = this.expr();
      this.expectW('THEN');
      const then = this.expr();
      whens.push({ when, then });
    }
    let otherwise = null;
    if (this.acceptW('ELSE')) otherwise = this.expr();
    this.expectW('END');
    this.acceptW('CASE'); // some dialects allow END CASE
    return { type: 'case', operand, whens, else: otherwise, s: start.s, e: this.prev().e };
  }

  typeName() {
    const start = this.peek();
    const parts = [];
    while (this.isT('word') || this.isT('qid')) {
      parts.push(identName(this.next()));
      if (this.isT('.') ) { this.next(); continue; }
      if (!this.isW(['PRECISION', 'VARYING', 'WITH', 'WITHOUT', 'TIME', 'ZONE', 'LOCAL', 'UNSIGNED', 'SIGNED', 'CHARACTER', 'CHAR', 'BYTE'])) break;
      if (this.isW('WITH') && !this.isW(['TIME', 'LOCAL'], 1)) break;
    }
    if (this.isT('(')) this.skipParens();
    while (this.isOp('[')) { this.next(); this.acceptOp(']'); }
    if (this.isOp('<')) { let depth = 0; do { if (this.isOp('<')) depth++; else if (this.isOp('>')) depth--; else if (this.isOp('>>')) depth -= 2; this.next(); } while (depth > 0 && !this.isT('eof')); }
    if (!parts.length) throw new ParseError('Expected a type name', start);
    return this.text(start.s, this.prev().e);
  }
}

// ---------- AST helpers used by the analysis modules ----------

/** Visit every expression node (not descending into subqueries unless deep). */
export function walkExpr(node, fn, opts = {}) {
  if (!node || typeof node !== 'object') return;
  if (fn(node) === false) return;
  const kids = exprChildren(node, opts);
  for (const k of kids) walkExpr(k, fn, opts);
}

export function exprChildren(n, opts = {}) {
  switch (n.type) {
    case 'bin': return [n.left, n.right];
    case 'not': case 'neg': return [n.expr];
    case 'isnull': case 'istruth': return [n.expr];
    case 'in': return [n.left, ...(n.list || [])];
    case 'between': return [n.left, n.low, n.high];
    case 'like': return [n.left, n.right, ...(n.list || []).slice(1)];
    case 'quant': return [n.left, ...(n.list || [])];
    case 'func': return [...n.args, n.filter, ...(n.over ? [...n.over.partitionBy, ...n.over.orderBy.map((o) => o.expr)] : []), ...((n.orderBy || []).map((o) => o.expr))].filter(Boolean);
    case 'case': return [n.operand, ...n.whens.flatMap((w) => [w.when, w.then]), n.else].filter(Boolean);
    case 'cast': return [n.expr];
    case 'tuple': return n.items;
    case 'interval': return n.expr ? [n.expr] : [];
    case 'subquery': case 'exists': return opts.deep ? [] : [];
    default: return [];
  }
}

/** Split an expression on top-level AND. */
export function conjuncts(e) {
  if (!e) return [];
  if (e.type === 'bin' && e.op === 'AND') return [...conjuncts(e.left), ...conjuncts(e.right)];
  return [e];
}

export const AGG_FUNCS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'STRING_AGG', 'LISTAGG', 'GROUP_CONCAT', 'ARRAY_AGG',
  'STDDEV', 'STDDEV_POP', 'STDDEV_SAMP', 'VARIANCE', 'VAR_POP', 'VAR_SAMP', 'MEDIAN', 'PERCENTILE_CONT', 'PERCENTILE_DISC',
  'COUNT_BIG', 'BOOL_AND', 'BOOL_OR', 'EVERY', 'ANY_VALUE', 'APPROX_COUNT_DISTINCT', 'COUNTIF', 'JSON_AGG', 'JSONB_AGG',
  'JSON_OBJECT_AGG', 'JSONB_OBJECT_AGG', 'XMLAGG', 'BIT_AND', 'BIT_OR', 'MODE', 'COLLECT', 'OBJECT_AGG', 'ARRAY_UNIQUE_AGG',
  'APPROX_DISTINCT', 'SUMIF', 'AVGIF', 'MINIF', 'MAXIF', 'CORR', 'COVAR_POP', 'COVAR_SAMP', 'STDEV', 'STDEVP', 'VAR', 'VARP',
  'CHECKSUM_AGG', 'STRING_AGG', 'ARBITRARY', 'KURTOSIS', 'SKEW']);

export function isAggregate(f) {
  return f && f.type === 'func' && AGG_FUNCS.has(f.name) && !f.over;
}

/** Does expression contain an aggregate (outside window functions and subqueries)? */
export function hasAggregate(e) {
  let found = false;
  walkExpr(e, (n) => {
    if (found) return false;
    if (n.type === 'func' && n.over) return false;
    if (isAggregate(n)) { found = true; return false; }
    return true;
  });
  return found;
}

export function hasWindow(e) {
  let found = false;
  walkExpr(e, (n) => { if (found) return false; if (n.type === 'func' && n.over) { found = true; return false; } return true; });
  return found;
}

/** Collect the column references in an expression (not inside subqueries). */
export function columnRefs(e, opts = {}) {
  const out = [];
  walkExpr(e, (n) => {
    if (n.type === 'col') out.push(n);
    if (opts.skipAggregates && isAggregate(n)) return false;
    if (opts.skipWindows && n.type === 'func' && n.over) return false;
    return true;
  });
  return out;
}

/** Subqueries directly inside an expression. */
export function subqueriesIn(e) {
  const out = [];
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'subquery' || n.type === 'exists') { out.push(n); return; }
    if ((n.type === 'in' || n.type === 'quant') && n.query) out.push(n);
    for (const k of exprChildren(n)) visit(k);
  };
  visit(e);
  return out;
}
