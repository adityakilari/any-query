// Entry point shared by the browser app and the CLI.
//   analyzeSql(sql, { dialect: 'auto', schema: catalog | null }) -> result
// The result is plain data (no DOM), so it can be rendered as HTML, Markdown or JSON.
import { parse } from './parse.js';
import { analyzeStatement, lineOf } from './statement.js';
import { analyzeRoutine } from './routine.js';
import { formatSql } from './format.js';
import { detectDialect, DIALECTS } from './dialect.js';

export const VERSION = '1.0.0';
export { DIALECTS };

export function analyzeSql(sql, options = {}) {
  const text = String(sql || '');
  const detected = detectDialect(text);
  const dialect = options.dialect && options.dialect !== 'auto' ? { id: options.dialect, label: DIALECTS[options.dialect] || options.dialect, confidence: 'chosen', signals: [] } : detected;
  const parsed = parse(text, { dialect: dialect.id === 'generic' ? 'auto' : dialect.id });
  const catalog = options.schema || null;
  const statements = [];
  parsed.statements.forEach((st, i) => {
    if (st.type === 'routine') {
      statements.push(analyzeRoutine(st, text, { catalog, dialect: dialect.id, index: i }));
      return;
    }
    if (st.type === 'skipped' || st.type === 'ddl') {
      const base = { index: i, type: st.type, s: st.s, e: st.e, sql: text.slice(st.s, st.e).trim(), line: lineOf(text, st.s) };
      statements.push({ ...base, skipped: true, unreadable: !!st.unreadable, keyword: st.keyword, title: st.keyword, summary: [skippedText(st)], steps: [], outputs: [], tables: [], findings: [], flow: null });
      return;
    }
    statements.push(analyzeStatement(st, text, { catalog, dialect: dialect.id, index: i, keepModel: options.keepModel }));
  });
  const findings = statements.flatMap((s) => s.findings.map((f) => ({ ...f, statement: s.index })));
  return {
    version: VERSION,
    sql: text,
    dialect,
    detectedDialect: detected,
    schema: catalog ? { fileName: catalog.fileName, tables: catalog.tables.length } : null,
    statements,
    notes: parsed.notes,
    formatted: formatSql(text, options.format || {}),
    stats: {
      statements: statements.length,
      tables: new Set(statements.flatMap((s) => (s.tables || []).map((t) => t.name.toLowerCase()))).size,
      steps: statements.reduce((n, s) => n + (s.routine ? s.routine.sqlCount : s.steps ? s.steps.length : 0), 0),
      findings: findings.length,
      high: findings.filter((f) => f.severity === 'high').length,
      medium: findings.filter((f) => f.severity === 'medium').length,
      low: findings.filter((f) => f.severity === 'low').length,
      lines: text.split('\n').length,
    },
  };
}

function skippedText(st) {
  if (st.unreadable) return 'This statement could not be read (see the note below). Check it for a missing part, such as the SELECT after a WITH clause, or unbalanced brackets.';
  if (st.type === 'ddl') return `This is a \`${st.keyword}\` statement: it defines a database object instead of reading data. To get a plain-English guide to tables like this, open the file in Any Schema (https://adityakilari.github.io/any-schema/).`;
  if (['BEGIN', 'DECLARE', 'DO', 'IF', 'WHILE', 'EXEC', 'EXECUTE', 'CALL'].includes(st.keyword)) return `This \`${st.keyword}\` block is procedural code. Any Query explains SQL statements (SELECT, INSERT, UPDATE, DELETE, MERGE, CREATE VIEW); paste the queries inside the block on their own to explain them.`;
  return `\`${st.keyword}\` statements are not explained. Any Query explains SELECT, INSERT, UPDATE, DELETE, MERGE and CREATE VIEW / TABLE AS.`;
}
