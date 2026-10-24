// SQL formatter. Works on tokens, never on the AST, so it keeps comments and any syntax the
// parser does not understand. It only changes whitespace and the case of SQL keywords, and the
// test suite checks that the token stream (and query results) stay the same.
import { tokenize, KEYWORDS, SOFT_KEYWORDS } from './tokenize.js';

const CLAUSES_1 = new Set(['SELECT', 'FROM', 'WHERE', 'HAVING', 'LIMIT', 'OFFSET', 'FETCH', 'UNION', 'INTERSECT', 'EXCEPT', 'MINUS', 'WINDOW', 'QUALIFY', 'VALUES', 'SET', 'RETURNING', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'INTO', 'USING', 'OPTION']);
const JOIN_LEAD = new Set(['JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'STRAIGHT_JOIN']);
const NO_SPACE_BEFORE_PAREN_KW = new Set(['LEFT', 'RIGHT', 'REPLACE', 'VALUES', 'COALESCE', 'NULLIF', 'CAST', 'EXTRACT', 'GROUPING', 'ROLLUP', 'CUBE', 'ANY', 'ALL', 'SOME', 'ARRAY', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'CURRENT_TIME', 'INTERVAL', 'KEY', 'FILTER', 'DATE', 'TIME', 'TIMESTAMP', 'FIRST', 'TRIM', 'POSITION', 'SUBSTRING', 'CHECK']);
const SPACE_BEFORE_PAREN = new Set(['IN', 'AS', 'EXISTS', 'OVER', 'USING', 'ON', 'AND', 'OR', 'NOT', 'FROM', 'JOIN', 'INTO', 'WITHIN', 'WHERE', 'SELECT', 'THEN', 'ELSE', 'WHEN', 'CASE', 'BY', 'IS', 'LIKE', 'ILIKE', 'BETWEEN', 'UNION', 'ALL', 'APPLY', 'LATERAL', 'TABLE', 'VIEW', 'SET', 'RETURNING', 'HAVING', 'QUALIFY', 'WINDOW', 'PIVOT', 'UNPIVOT', 'PARTITION', 'OPTION', 'TOP', 'LIMIT', 'DISTINCT', 'EXCEPT', 'INTERSECT', 'MINUS', 'VALUES', 'ANY', 'SOME', 'FILTER', 'WITH', 'DO', 'MATCHED', 'NOLOCK']);

export function formatSql(sql, opts = {}) {
  const toks = tokenize(sql);
  const IND = ' '.repeat(opts.indent || 2);
  const upper = opts.uppercase !== false;
  let out = '';
  let lineStart = true;
  let lineIndent = 0;
  let prev = null; // previous emitted significant token
  let unaryNext = false;
  const stack = [{ kind: 'query', base: 0, clause: null, between: 0 }];
  const top = () => stack[stack.length - 1];
  const sigAt = (i, k = 1) => {
    let c = 0;
    for (let j = i + 1; j < toks.length; j++) {
      if (toks[j].t === 'comment') continue;
      if (++c === k) return toks[j];
    }
    return toks[toks.length - 1];
  };
  const isW = (t, u) => t && t.t === 'word' && (Array.isArray(u) ? u.includes(t.u) : t.u === u);

  const trimEnd = () => { out = out.replace(/[ \t]+$/, ''); };
  const newline = (indent) => {
    trimEnd();
    if (out.length && !out.endsWith('\n')) out += '\n';
    lineIndent = Math.max(0, indent);
    lineStart = true;
  };
  const emit = (text, space = true) => {
    if (lineStart) { out += ' '.repeat(lineIndent); lineStart = false; } else if (space) out += ' ';
    out += text;
  };

  const caseText = (t, i) => {
    if (t.t !== 'word' || !upper) return t.v;
    if (KEYWORDS.has(t.u)) return t.u;
    const nx = sigAt(i);
    if (SOFT_KEYWORDS.has(t.u) && (nx.t === '(' || (nx.t === 'str' && ['DATE', 'TIMESTAMP', 'TIME'].includes(t.u)))) return t.u;
    if (['NULLS', 'ROWS', 'ROW', 'ONLY', 'NEXT', 'TIES', 'PERCENT', 'PRECEDING', 'FOLLOWING', 'UNBOUNDED', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'SYSDATE', 'ROWNUM', 'MATERIALIZED', 'REPLACE', 'TEMPORARY', 'TEMP', 'IF', 'NOTHING', 'CONFLICT', 'DUPLICATE', 'IGNORE', 'RESPECT', 'EXCLUDE', 'LAST', 'OUTER', 'APPLY', 'SEMI', 'ANTI', 'ZONE', 'SYSTIMESTAMP'].includes(t.u) && prev && prev.t === 'word' && (KEYWORDS.has(prev.u) || ['NULLS', 'FETCH', 'FIRST', 'NEXT', 'ROWS', 'ROW', 'WITH', 'ON', 'DO', 'BETWEEN', 'AND', 'UNBOUNDED', 'CURRENT', 'OR', 'CREATE', 'IGNORE', 'RESPECT', 'TIME', 'CROSS', 'OUTER', 'LEFT', 'AT'].includes(prev.u))) return t.u;
    if (['CURRENT_DATE', 'CURRENT_TIMESTAMP', 'SYSDATE', 'SYSTIMESTAMP', 'ROWNUM', 'LOCALTIMESTAMP'].includes(t.u)) return t.u;
    return t.v;
  };

  const needSpace = (t) => {
    if (!prev) return false;
    if (unaryNext) return false;
    if (prev.t === '(' || prev.t === '.') return false;
    if (prev.t === 'op' && (prev.v === '::' || prev.v === '[')) return false;
    if (t.t === ')' || t.t === ',' || t.t === '.' || t.t === ';') return false;
    if (t.t === 'op' && (t.v === '::' || t.outer || t.v === ']')) return false;
    if (t.t === 'op' && t.v === '[' && (prev.t === 'word' || prev.t === 'qid' || prev.t === ')' || (prev.t === 'op' && prev.v === ']'))) return false;
    if (t.t === '(') {
      if (prev.t === 'qid') return false;
      if (prev.t === 'word') {
        if (SPACE_BEFORE_PAREN.has(prev.u) && !NO_SPACE_BEFORE_PAREN_KW.has(prev.u)) return true;
        if (KEYWORDS.has(prev.u) && !NO_SPACE_BEFORE_PAREN_KW.has(prev.u)) return true;
        return false;
      }
      if (prev.t === 'op' && prev.v === ']') return false;
      return true;
    }
    if (prev.t === 'param' && t.t === 'word' && /^@/.test(prev.v)) return true;
    return true;
  };

  const caseSpan = (i) => {
    // length of CASE ... END in source characters
    let depth = 0;
    for (let j = i; j < toks.length; j++) {
      const t = toks[j];
      if (t.t === 'word' && t.u === 'CASE') depth++;
      if (t.t === 'word' && t.u === 'END') { depth--; if (depth === 0) return { end: j, len: t.e - toks[i].s, multi: (sql.slice(toks[i].s, t.e).match(/\bWHEN\b/gi) || []).length }; }
      if (t.t === ';' || t.t === 'eof') break;
    }
    return { end: -1, len: 0, multi: 0 };
  };

  let statementStart = true;
  let stmtKind = null;

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === 'eof') break;
    const ctx = top();

    if (t.t === 'comment') {
      const own = t.nl > 0 || !out.length;
      const line = t.v.startsWith('--') || t.v.startsWith('#');
      if (own && !lineStart) newline(statementStart ? 0 : lineIndent);
      if (own && t.nl > 1 && out.length && !statementStart) { /* keep paragraph breaks inside statements tight */ }
      emit(line ? t.v.trimEnd() : t.v, !lineStart);
      if (line || own) newline(lineIndent);
      continue;
    }

    if (t.t === ';') {
      trimEnd();
      if (t.batch) { newline(0); out += t.v.trim().toUpperCase() === '/' ? '/' : 'GO'; }
      else out += ';';
      newline(0);
      if (sigAt(i).t !== 'eof') out += '\n';
      stack.length = 1;
      Object.assign(stack[0], { clause: null, between: 0 });
      prev = null;
      statementStart = true;
      stmtKind = null;
      continue;
    }

    const U = t.t === 'word' ? t.u : null;
    const nx = sigAt(i);
    let text = caseText(t, i);

    if (statementStart && U) stmtKind = U;

    // ---- parentheses ----
    if (t.t === '(') {
      const subq = isW(nx, ['SELECT', 'WITH']) || (nx.t === '(' && isW(sigAt(i, 2), ['SELECT', 'WITH']));
      emit('(', needSpace(t));
      prev = t;
      if (subq && ctx.kind !== 'case-inline') {
        stack.push({ kind: 'query', base: lineIndent + IND.length + (ctx.clause === 'SELECT' && ctx.selectAlign ? 0 : 0), outerIndent: lineIndent, clause: null, between: 0 });
        newline(top().base);
      } else {
        stack.push({ kind: 'expr', base: lineIndent, between: 0 });
      }
      statementStart = false;
      continue;
    }
    if (t.t === ')') {
      while (stack.length > 1 && top().kind.startsWith('case')) stack.pop();
      const c = stack.length > 1 ? stack.pop() : top();
      if (c.kind === 'query') { newline(c.outerIndent); emit(')', false); } else emit(')', needSpace(t));
      prev = t;
      continue;
    }

    // ---- CASE ----
    if (U === 'CASE') {
      const span = caseSpan(i);
      const long = span.len > 70 || span.multi > 2;
      emit(text, needSpace(t));
      prev = t;
      stack.push({ kind: long ? 'case' : 'case-inline', base: lineIndent + IND.length, endIndent: lineIndent, between: 0 });
      continue;
    }
    if (U === 'END' && ctx.kind.startsWith('case')) {
      if (ctx.kind === 'case') newline(ctx.endIndent);
      emit(text, !lineStart && needSpace(t));
      stack.pop();
      prev = t;
      continue;
    }
    if ((U === 'WHEN' || U === 'ELSE') && ctx.kind === 'case') {
      newline(ctx.base);
      emit(text, false);
      prev = t;
      continue;
    }

    // ---- clauses (only in query context) ----
    if (ctx.kind === 'query' && U) {
      let clause = null;
      let words = 1;
      const prevU = prev && prev.t === 'word' ? prev.u : null;
      if (U === 'WITH' && (statementStart || prev === null || (prev && prev.t === '('))) clause = 'WITH';
      else if ((U === 'GROUP' || U === 'ORDER' || U === 'PARTITION') && isW(nx, 'BY') && U !== 'PARTITION') { clause = `${U} BY`; words = 2; }
      else if (U === 'CONNECT' && isW(nx, 'BY')) { clause = 'CONNECT BY'; words = 2; }
      else if (U === 'START' && isW(nx, 'WITH')) { clause = 'START WITH'; words = 2; }
      else if (U === 'FROM' && prevU !== 'DELETE' && prevU !== 'DISTINCT') clause = 'FROM';
      else if (U === 'INTO' && (prevU === 'INSERT' || prevU === 'MERGE' || prevU === 'IGNORE' || prevU === 'OVERWRITE' || prevU === 'ALL')) clause = null;
      else if (U === 'SET' && prevU === 'UPDATE') clause = null;
      else if (U === 'USING' && stmtKind !== 'MERGE') clause = null;
      else if (U === 'SET' && stmtKind === 'MERGE') clause = null;
      else if ((U === 'UPDATE' || U === 'DELETE' || U === 'INSERT') && stmtKind === 'MERGE' && !statementStart) clause = null;
      else if (U === 'VALUES' && stmtKind === 'MERGE') clause = null;
      else if (U === 'FETCH' && !isW(nx, ['FIRST', 'NEXT'])) clause = null;
      else if (U === 'OFFSET' && prev && prev.t === ',') clause = null;
      else if (U === 'WHEN' && stmtKind === 'MERGE') clause = 'WHEN';
      else if (U === 'ON' && stmtKind === 'MERGE' && ctx.clause === 'USING') clause = 'ON';
      else if (U === 'INTO' && stmtKind !== 'SELECT' && stmtKind !== 'WITH') clause = null;
      else if (CLAUSES_1.has(U)) clause = U;
      if (U === 'SELECT' && prevU === 'AS' && ctx.clause === 'WITH') clause = 'SELECT';
      if (clause === 'UNION' || clause === 'INTERSECT' || clause === 'EXCEPT' || clause === 'MINUS') {
        if (U === 'EXCEPT' && nx.t === '(' && !isW(sigAt(i, 2), ['SELECT', 'WITH'])) clause = null; // SELECT * EXCEPT (col)
      }
      if (clause === 'SELECT' && prevU === 'INSERT') clause = 'SELECT';
      if (clause) {
        if (!statementStart) newline(ctx.base);
        emit(text, !lineStart);
        prev = t;
        for (let k = 1; k < words; k++) { i++; while (toks[i].t === 'comment') i++; emit(caseText(toks[i], i)); prev = toks[i]; }
        if (clause === 'UNION' || clause === 'INTERSECT' || clause === 'EXCEPT' || clause === 'MINUS') {
          if (isW(sigAt(i), ['ALL', 'DISTINCT'])) { i++; while (toks[i].t === 'comment') i++; emit(caseText(toks[i], i)); prev = toks[i]; }
          ctx.clause = clause;
          if (sigAt(i).t !== '(') newline(ctx.base);
        } else ctx.clause = clause;
        ctx.between = 0;
        statementStart = false;
        continue;
      }
      // joins
      const joinStart = (U === 'JOIN' || U === 'STRAIGHT_JOIN' || (JOIN_LEAD.has(U) && (isW(nx, ['JOIN', 'OUTER', 'APPLY', 'SEMI', 'ANTI']) || (U === 'NATURAL'))) || (U === 'OUTER' && isW(nx, 'APPLY'))) && !(nx.t === '(' && (U === 'LEFT' || U === 'RIGHT'));
      if (joinStart && ['FROM', 'JOIN', 'USING', 'UPDATE', 'DELETE'].includes(ctx.clause || '')) {
        newline(ctx.base);
        emit(text, false);
        prev = t;
        while (isW(sigAt(i), ['JOIN', 'OUTER', 'APPLY', 'SEMI', 'ANTI', 'INNER', 'LEFT', 'RIGHT', 'FULL']) && !(t.u === 'JOIN')) {
          i++;
          while (toks[i].t === 'comment') i++;
          emit(caseText(toks[i], i));
          prev = toks[i];
          if (toks[i].u === 'JOIN' || toks[i].u === 'APPLY') break;
        }
        ctx.clause = 'JOIN';
        ctx.between = 0;
        continue;
      }
    }

    // ---- AND / OR line breaks ----
    if ((U === 'AND' || U === 'OR') && ctx.kind === 'query' && ['WHERE', 'HAVING', 'JOIN', 'QUALIFY', 'ON', 'WHEN', 'CONNECT BY', 'START WITH'].includes(ctx.clause || '')) {
      if (U === 'AND' && ctx.between > 0) {
        ctx.between--;
      } else {
        newline(ctx.base + IND.length);
        emit(text, false);
        prev = t;
        continue;
      }
    }
    if (U === 'BETWEEN') ctx.between++;

    // ---- commas ----
    if (t.t === ',') {
      emit(',', false);
      prev = t;
      if (ctx.kind === 'query') {
        if (ctx.clause === 'SELECT') newline(ctx.base + 7);
        else if (ctx.clause === 'WITH') newline(ctx.base);
        else if (ctx.clause === 'FROM') newline(ctx.base + 5);
        else if (ctx.clause === 'SET') newline(ctx.base + 4);
      }
      continue;
    }

    // ---- unary minus / plus ----
    if (t.t === 'op' && (t.v === '-' || t.v === '+') && (!prev || prev.t === '(' || prev.t === ',' || (prev.t === 'op' && prev.v !== ')' && !prev.outer && prev.v !== ']') || (prev.t === 'word' && KEYWORDS.has(prev.u) && !['NULL', 'TRUE', 'FALSE', 'END', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'CURRENT_TIME'].includes(prev.u)))) {
      emit(t.v, needSpace(t));
      prev = t;
      unaryNext = true;
      continue;
    }

    emit(text, needSpace(t));
    unaryNext = false;
    prev = t;
    statementStart = false;
  }
  trimEnd();
  return out.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
