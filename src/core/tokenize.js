// SQL tokenizer shared by the parser and the formatter.
// Token: { t: type, v: raw text, u: upper-case text (words), s: start offset, e: end offset, line, nl: newlines before }
// Types: word, qid (quoted identifier, .name = unquoted), str, num, op, param, comment, '(' ')' ',' ';' '.', eof
// Handles the dialect quirks that matter for reading queries: '' and E'' strings, Oracle q'[..]',
// Postgres $$..$$, "double", `backtick` and [bracket] identifiers, :: casts, (+) outer joins,
// ?, $1, :name and @var parameters, and GO / "/" batch separators (turned into ';').

const MULTI_OPS = ['->>', '#>>', '!~*', '<=>', '::', '<>', '!=', '<=', '>=', '||', '->', '#>', '@>', '<@', '=>', ':=', '**', '~*', '!~', '&&', '<<', '>>', '^=', '+=', '-=', '*=', '/='];

// Words that cannot be an implicit alias and that the formatter upper-cases.
export const KEYWORDS = new Set(`
ADD ALL ALTER AND ANY APPLY ARRAY AS ASC BETWEEN BY CASE CAST CHECK COLLATE COLUMN CONNECT CONSTRAINT CREATE CROSS
CURRENT CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP DEFAULT DELETE DESC DISTINCT DROP ELSE END ESCAPE EXCEPT EXISTS
EXTRACT FALSE FETCH FILTER FIRST FOR FOREIGN FROM FULL GROUP GROUPING HAVING ILIKE IN INNER INSERT INTERSECT INTERVAL
INTO IS JOIN KEY LATERAL LEFT LIKE LIMIT MATCHED MERGE MINUS NATURAL NOT NULL NULLS OFFSET ON OR ORDER OUTER OVER
PARTITION PIVOT PRIMARY QUALIFY RANGE RECURSIVE REFERENCES RETURNING RIGHT ROWS SELECT SET SOME START TABLE TABLESAMPLE
THEN TOP TRUE UNION UNIQUE UNPIVOT UPDATE USING VALUES VIEW WHEN WHERE WINDOW WITH WITHIN ROLLUP CUBE SETS
SIMILAR REGEXP RLIKE STRAIGHT_JOIN SAMPLE PRIOR NOCYCLE SIBLINGS OPTION
`.trim().split(/\s+/));

// Extra words the formatter upper-cases (functions and type names) but which may be identifiers.
export const SOFT_KEYWORDS = new Set(`
COUNT SUM AVG MIN MAX COALESCE NVL NVL2 IFNULL ISNULL NULLIF DECODE IIF IFF ROUND TRUNC FLOOR CEIL CEILING ABS
UPPER LOWER TRIM LTRIM RTRIM SUBSTR SUBSTRING LENGTH LEN CONCAT REPLACE TO_CHAR TO_DATE TO_NUMBER TO_TIMESTAMP
DATE_TRUNC DATE_PART DATEADD DATEDIFF DATEPART DATE_ADD DATE_SUB ADD_MONTHS MONTHS_BETWEEN LAST_DAY NOW GETDATE
SYSDATE SYSTIMESTAMP ROW_NUMBER RANK DENSE_RANK NTILE LAG LEAD FIRST_VALUE LAST_VALUE STRING_AGG LISTAGG GROUP_CONCAT
ARRAY_AGG CONVERT TRY_CAST SAFE_CAST GREATEST LEAST ROWNUM LEVEL DATE TIMESTAMP TIME INT INTEGER BIGINT SMALLINT
VARCHAR VARCHAR2 NVARCHAR CHAR TEXT NUMERIC DECIMAL NUMBER FLOAT REAL DOUBLE PRECISION BOOLEAN DAY MONTH YEAR HOUR
MINUTE SECOND WEEK QUARTER ASOF RESPECT IGNORE EXCLUDE REPLACE OVERLAPS NOLOCK UNNEST GENERATE_SERIES
`.trim().split(/\s+/));

const isWordStart = (c) => /[A-Za-z_À-￿]/.test(c);
const isWordChar = (c) => /[A-Za-z0-9_$#À-￿]/.test(c);

export function tokenize(src) {
  const s = String(src || '').replace(/\r\n?/g, '\n');
  const out = [];
  let i = 0;
  let line = 1;
  let nl = 0;
  const n = s.length;
  const lastSig = () => { for (let k = out.length - 1; k >= 0; k--) if (out[k].t !== 'comment') return out[k]; return null; };
  const push = (t, start, extra = {}) => {
    const v = s.slice(start, i);
    const tok = { t, v, s: start, e: i, line, nl, ...extra };
    if (t === 'word') tok.u = v.toUpperCase();
    out.push(tok);
    for (const ch of v) if (ch === '\n') line++;
    nl = 0;
    return tok;
  };
  // A line holding only GO (SQL Server) or / (Oracle SQL*Plus) separates statements.
  const atLineStart = () => { let k = i - 1; while (k >= 0 && (s[k] === ' ' || s[k] === '\t')) k--; return k < 0 || s[k] === '\n'; };

  while (i < n) {
    const c = s[i];
    const d = s[i + 1];
    if (c === '\n') { nl++; line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\f' || c === '\v' || c === ' ' || c === '﻿') { i++; continue; }
    const start = i;

    if (atLineStart()) {
      const m = /^(GO|go|Go|\/)[ \t]*(?:\d+[ \t]*)?(?=\n|$)/.exec(s.slice(i, i + 12));
      if (m) { i += m[0].length; push(';', start, { batch: true }); continue; }
    }
    // comments
    if (c === '-' && d === '-') { while (i < n && s[i] !== '\n') i++; push('comment', start); continue; }
    if (c === '/' && d === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      const lines = (s.slice(start, i).match(/\n/g) || []).length;
      push('comment', start); line += 0; // line already advanced inside push
      void lines;
      continue;
    }
    if (c === '#' && (d === ' ' || d === '\n') && atLineStart()) { while (i < n && s[i] !== '\n') i++; push('comment', start); continue; }

    // Oracle q'[ ... ]'
    if ((c === 'q' || c === 'Q') && d === "'" && i + 2 < n) {
      const open = s[i + 2];
      const close = { '[': ']', '{': '}', '(': ')', '<': '>' }[open] || open;
      const end = s.indexOf(close + "'", i + 3);
      if (end > 0) { i = end + 2; push('str', start, { value: s.slice(start + 3, end) }); continue; }
    }
    // prefixed strings: E'..' N'..' B'..' X'..' U&'..' r'..' b'..'
    if (/[EeNnBbXxRr]/.test(c) && d === "'" && !isWordChar(s[i - 1] || ' ')) {
      i++;
      const tok = readQuoted("'", c === 'E' || c === 'e');
      push('str', start, { value: tok });
      continue;
    }
    if ((c === 'U' || c === 'u') && d === '&' && s[i + 2] === "'") { i += 2; const v = readQuoted("'"); push('str', start, { value: v }); continue; }
    if (c === "'") { const v = readQuoted("'"); push('str', start, { value: v }); continue; }
    if (c === '"') { const v = readQuoted('"'); push('qid', start, { name: v }); continue; }
    if (c === '`') { const v = readQuoted('`'); push('qid', start, { name: v }); continue; }
    if (c === '[') {
      const prev = lastSig();
      const subscript = prev && ((prev.t === 'word' && !KEYWORDS.has(prev.u) && prev.u !== 'ARRAY') || prev.t === 'qid' || prev.t === ')' || (prev.t === 'op' && prev.v === ']'))
        || (prev && prev.t === 'word' && prev.u === 'ARRAY');
      const m = /^\[([^\]\n]*)\]/.exec(s.slice(i, i + 300));
      if (!subscript && m && !/^\s*\d*\s*(:\s*\d*)?\s*$/.test(m[1])) { i += m[0].length; push('qid', start, { name: m[1] }); continue; }
      i++; push('op', start); continue;
    }
    if (c === ']') { i++; push('op', start); continue; }
    // dollar quoting
    if (c === '$') {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(s.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const end = s.indexOf(tag, i + tag.length);
        i = end < 0 ? n : end + tag.length;
        push('str', start, { value: s.slice(start + tag.length, end < 0 ? n : end), dollar: true });
        continue;
      }
      if (/\d/.test(d || '')) { i++; while (i < n && /\d/.test(s[i])) i++; push('param', start); continue; }
    }
    // numbers
    if (/\d/.test(c) || (c === '.' && /\d/.test(d || ''))) {
      if (c === '0' && (d === 'x' || d === 'X')) { i += 2; while (i < n && /[0-9a-fA-F]/.test(s[i])) i++; push('num', start); continue; }
      while (i < n && /\d/.test(s[i])) i++;
      if (s[i] === '.' && s[i + 1] !== '.') { i++; while (i < n && /\d/.test(s[i])) i++; }
      if ((s[i] === 'e' || s[i] === 'E') && /[\d+-]/.test(s[i + 1] || '')) { i += 2; while (i < n && /\d/.test(s[i])) i++; }
      if (isWordChar(s[i] || ' ') && !/\d/.test(s[i])) {
        // identifiers that start with a digit (MySQL/BigQuery) e.g. 1st_table
        while (i < n && isWordChar(s[i])) i++;
        push('word', start); continue;
      }
      push('num', start); continue;
    }
    // parameters
    if (c === '?') { i++; push('param', start); continue; }
    if (c === '@') {
      i++; if (s[i] === '@') i++;
      while (i < n && isWordChar(s[i])) i++;
      if (i - start > 1) { push('param', start); continue; }
      push('op', start); continue;
    }
    if (c === ':' && d !== ':' && d !== '=') {
      const prev = lastSig();
      const glued = prev && prev.e === i && (prev.t === 'word' || prev.t === 'qid' || prev.t === ')');
      if (!glued && (isWordStart(d || '') || /\d/.test(d || ''))) { i++; while (i < n && isWordChar(s[i])) i++; push('param', start); continue; }
    }
    // words
    if (isWordStart(c)) {
      while (i < n && isWordChar(s[i])) i++;
      push('word', start); continue;
    }
    // Oracle outer join marker (+)
    if (c === '(') {
      const m = /^\(\s*\+\s*\)/.exec(s.slice(i, i + 8));
      if (m) { i += m[0].length; push('op', start, { outer: true }); continue; }
      i++; push('(', start); continue;
    }
    if (c === ')' || c === ',' || c === ';') { i++; push(c, start); continue; }
    if (c === '.') { i++; push('.', start); continue; }
    const three = s.slice(i, i + 3);
    const two = s.slice(i, i + 2);
    const op = MULTI_OPS.find((o) => o === three || o === two);
    if (op) { i += op.length; push('op', start); continue; }
    i++; push('op', start);
  }
  out.push({ t: 'eof', v: '', s: n, e: n, line, nl });
  return out;

  function readQuoted(q, backslash = false) {
    // i points at the opening quote
    i++;
    let v = '';
    while (i < n) {
      const ch = s[i];
      if (backslash && ch === '\\' && i + 1 < n) { const nx = s[i + 1]; v += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', 0: '\0' })[nx] || nx; i += 2; continue; }
      if (ch === q) {
        if (s[i + 1] === q) { v += q; i += 2; continue; }
        i++;
        return v;
      }
      v += ch;
      i++;
    }
    return v; // unterminated: take the rest
  }
}

/** Identifier text of a word or quoted-identifier token. */
export function identName(tok) {
  if (!tok) return '';
  return tok.t === 'qid' ? tok.name : tok.v;
}
