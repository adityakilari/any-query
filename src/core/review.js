// Review rules: mistakes that silently return wrong rows, errors some databases raise, and
// patterns that stop the database from using an index. Each finding says what was found, why
// it matters, and (where possible) gives a rewrite built from the query's own text.
//
// Finding: { rule, severity: 'high'|'medium'|'low', title, detail, fix, fixSql, s, e, line, step }
import { conjuncts, columnRefs, hasAggregate, hasWindow, walkExpr, isAggregate } from './parse.js';
import { Speaker } from './explain.js';
import { looksDate } from './model.js';

export const RULES = {
  'unknown-alias': 'Column uses a table alias that is not defined',
  'unknown-table': 'Table not found in the loaded schema',
  'unknown-column': 'Column not found in the loaded schema',
  'ambiguous-column': 'Column name exists in more than one table',
  'missing-join-condition': 'Tables combined without a join condition',
  'left-join-undone': 'WHERE filter turns a LEFT JOIN into an inner join',
  'not-in-null': 'NOT IN with a subquery returns nothing if the subquery returns a NULL',
  'not-in-null-literal': 'NOT IN list contains NULL',
  'equals-null': '= NULL is never true',
  'ungrouped-column': 'Selected column is neither grouped nor aggregated',
  'aggregate-in-where': 'Aggregate used in WHERE',
  'window-in-where': 'Window function used in WHERE',
  'alias-in-where': 'SELECT alias used in WHERE',
  'rownum-order': 'ROWNUM is applied before ORDER BY',
  'limit-without-order': 'Row limit without ORDER BY',
  'row-number-without-order': 'Ranking without ORDER BY',
  'between-timestamp': 'BETWEEN with a date on a timestamp column misses the last day',
  'function-on-column': 'Function on a filtered column can prevent index use',
  'join-fan-out': 'Join on columns that are not unique on either side',
  'distinct-hides-join': 'DISTINCT may be hiding duplicates from a join',
  'correlated-subquery': 'Subquery runs once per row',
  'unused-cte': 'CTE is never used',
  'update-without-where': 'UPDATE or DELETE without WHERE',
  'nolock': 'NOLOCK can return uncommitted or duplicate rows',
  'division-by-zero': 'Division can fail when the divisor is 0',
  'having-without-aggregate': 'HAVING condition belongs in WHERE',
  'or-in-join': 'OR in a join condition',
  'leading-wildcard': "LIKE pattern starts with '%'",
  'select-star': 'SELECT *',
  'union-distinct': 'UNION removes duplicates (sorts the rows)',
  'implicit-join': 'Comma-separated tables in FROM (old join syntax)',
  'ordinal-reference': 'GROUP BY / ORDER BY by column position',
  'order-in-subquery': 'ORDER BY inside a subquery or CTE has no effect',
  'no-op-update': 'UPDATE sets a column to its own value',
  'unassigned-variable': 'Variable used but never given a value (functions and procedures)',
  'unused-variable': 'Variables never read (functions and procedures)',
  'loop-invariant-sql': 'SQL in a loop that does the same work on every pass',
  'check-then-insert': 'Count-then-insert can create duplicates',
  'select-into-many': 'SELECT … INTO can match several rows',
  'always-true-condition': 'IF condition that is always true or false',
  'dynamic-sql-concat': 'Dynamic SQL built by joining strings (SQL injection)',
  'swallowed-error': 'Errors caught and ignored',
};

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

export function reviewStatement(st, m, ctx) {
  const sql = ctx.sql;
  const dialect = ctx.dialect || 'generic';
  const catalog = ctx.catalog;
  const sp = new Speaker(m);
  sp.fullSql = sql;
  sp.steps(); // numbers the steps so findings can say where they are
  const out = [];
  const text = (n) => (n && n.s != null ? sql.slice(n.s, n.e) : '');
  const add = (rule, severity, node, title, detail, fix = null, fixSql = null, b = null) => {
    const s = node && node.s != null ? node.s : st.s;
    const e = node && node.e != null ? node.e : st.e;
    const key = `${rule}:${s}:${e}`;
    if (out.some((f) => f.key === key)) return;
    out.push({ key, rule, severity, title, detail, fix, fixSql, s, e, line: lineOf(sql, s), step: b ? (sp.stepName(b) || sp.stepName(parentStep(b, sp))) : null, snippet: oneLine(sql.slice(s, e)) });
  };
  const dateLit = (v) => (['sqlserver', 'mysql', 'sqlite'].includes(dialect) ? `'${v}'` : `DATE '${v}'`);
  const plusOneDay = (x) => {
    switch (dialect) {
      case 'oracle': return `${x} + 1`;
      case 'sqlserver': return `DATEADD(day, 1, ${x})`;
      case 'mysql': return `${x} + INTERVAL 1 DAY`;
      case 'snowflake': return `DATEADD(day, 1, ${x})`;
      case 'bigquery': return `DATE_ADD(${x}, INTERVAL 1 DAY)`;
      case 'sqlite': return `date(${x}, '+1 day')`;
      default: return `${x} + INTERVAL '1 day'`;
    }
  };

  for (const b of m.blocks) {
    if (b.pending) continue;
    const sel = b.select;
    // ---------- names ----------
    for (const u of b.uses) {
      const r = u.res || {};
      if (r.unknownQualifier) {
        add('unknown-alias', 'high', u.col, `${code(u.col.parts.join('.'))} uses ${code(r.unknownQualifier)}, which is not a table or alias in this query`,
          `The database will reject the query. The tables available here are ${listCodes(scopeRefs(b))}.`,
          'Check the spelling, or add the missing table to FROM.', null, b);
      } else if (catalog && r.source && r.source.kind === 'table' && r.source.table && r.missing) {
        const near = closest(r.column, r.source.table.columns.map((c) => c.name));
        add('unknown-column', 'high', u.col, `${code(r.source.displayName)} has no column ${code(r.column)}`,
          `The loaded schema (${catalog.fileName}) does not list this column, so the database will most likely reject the query.`,
          near ? `Did you mean ${code(near)}?` : `Its columns are ${listCodes(r.source.table.columns.map((c) => c.name).slice(0, 12))}${r.source.table.columns.length > 12 ? ' …' : ''}.`, null, b);
      } else if (r.ambiguous && !r.unknownColumns) {
        add('ambiguous-column', 'high', u.col, `${code(u.col.parts.join('.'))} exists in ${listCodes(r.candidates.map((c) => c.ref))}`,
          'Without a table prefix the database cannot tell which one you mean and will reject the query (or, in some tools, pick one silently).',
          `Prefix it with the table alias, for example ${code(`${r.candidates[0].ref}.${r.column}`)}.`, null, b);
      } else if (r.notFound && catalog && b.sources.every((s) => s.columns)) {
        const alias = (b.outputs || []).find((o) => o.alias && o.alias.toLowerCase() === String(r.column).toLowerCase());
        if (!(alias && u.clause === 'where')) add('unknown-column', 'high', u.col, `No table in this query has a column ${code(r.column)}`, `None of ${listCodes(b.sources.map((s) => s.displayName))} has this column in the loaded schema.`, null, null, b);
      }
    }
    for (const s of b.sources) {
      if (catalog && s.kind === 'table' && !s.table && !isSystemTable(s.parts)) {
        const near = closest(s.parts[s.parts.length - 1], catalog.tables.map((t) => t.name));
        add('unknown-table', 'high', s.node, `${code(s.displayName)} is not in the loaded schema`,
          `The schema file ${catalog.fileName} has ${catalog.tables.length} tables and this is not one of them. If the schema is complete, the name is probably misspelled.`,
          near ? `Did you mean ${code(near)}?` : null, null, b);
      }
      if (s.node.hints && /nolock|readuncommitted/i.test(s.node.hints)) {
        add('nolock', 'medium', s.node, `${code(s.displayName)} is read WITH (NOLOCK)`,
          'NOLOCK reads data other transactions have not committed yet. Rows can be missed, read twice, or later rolled back, so totals can be wrong.',
          'Remove the hint. If blocking is the problem, consider READ COMMITTED SNAPSHOT isolation instead.', null, b);
      }
    }
    if (!sel) continue;

    // ---------- joins ----------
    for (const s of b.sources.slice(1)) {
      const j = m.joinInfo(b, s);
      const jn = s.join && s.join.node ? s.join.node : s.node;
      if (j.card === 'cross' && s.join && s.join.implicit) {
        const sug = suggestJoin(b, s, catalog, m);
        add('missing-join-condition', 'high', s.node, `${code(s.displayName)} is listed in FROM with no condition linking it to the other tables`,
          `Every row of ${code(s.displayName)} is combined with every row already selected, so the result has (rows so far) × (rows in ${s.displayName}) rows. This is almost always a forgotten join condition.`,
          sug ? `Link it explicitly, for example: ${code(sug)}` : `Add the condition that links ${code(s.displayName)} to the other tables, or write CROSS JOIN if every combination is really wanted.`, sug, b);
      }
      if (s.join && s.join.on && conjuncts(s.join.on).some((c) => c.type === 'lit' && c.kind === 'bool' && c.value) || (s.join && s.join.on && s.join.on.type === 'bin' && s.join.on.op === '=' && s.join.on.left.type === 'lit' && s.join.on.right.type === 'lit')) {
        add('missing-join-condition', 'medium', s.join.on, `The join to ${code(s.displayName)} is ON a condition that is always true`, 'This behaves like a CROSS JOIN: every row is combined with every row.', 'Join on the related columns instead, or write CROSS JOIN to make the intent clear.', null, b);
      }
      if (s.join && s.join.on && !s.join.implicit) {
        for (const c of conjuncts(s.join.on)) if (c.type === 'bin' && c.op === 'OR' && columnRefs(c).length) {
          add('or-in-join', 'low', c, 'The join condition uses OR', 'Joins with OR usually cannot use an index on either column and are often much slower. They also make it easy to match more rows than intended.', 'If the two branches are really different matches, consider two joins (or UNION ALL of two queries) instead.', null, b);
        }
      }
      if (j.card === 'N:N' && j.pairs.length && s.kind === 'table' && j.other && j.other.kind === 'table') {
        const strong = !!catalog && s.table && j.other.table;
        add('join-fan-out', strong ? 'medium' : 'low', jn, `The join to ${code(s.displayName)} is on columns that are not unique on either side`,
          `${listCodes(j.pairs.map((p) => `${p.left.source.ref}.${p.left.column} = ${s.ref}.${p.right.column}`))}: neither side looks like a key${strong ? ' in the loaded schema' : ''}, so one row can match many and multiply the results (sums and counts are then too high).`,
          'Join through the key of one side, or aggregate one side first so it has one row per join value.', null, b);
      }
      // LEFT JOIN undone by WHERE
      if (s.join && (s.join.kind === 'LEFT') && !s.join.implicit && sel.where) {
        for (const c of conjuncts(sel.where)) {
          if (b.whereUsedByJoins && b.whereUsedByJoins.has(c)) continue;
          const refs = columnRefs(c);
          if (!refs.some((r) => (m.resolve(b, r) || {}).source === s)) continue;
          if (nullTolerant(c, s, b, m)) continue;
          const onText = text(s.join.on);
          const fixed = `LEFT JOIN ${text(s.node)} ON ${onText ? `${onText} AND ` : ''}${text(c)}`;
          add('left-join-undone', 'high', c, `The WHERE condition on ${code(s.ref)} undoes the LEFT JOIN to ${code(s.displayName)}`,
            `For ${sp.plural(m.joinInfo(b, s).other ? m.joinInfo(b, s).other.entity : 'row')} with no matching ${s.entity}, the ${s.ref} columns are NULL, so ${code(text(c))} is never true for them and they are dropped. The LEFT JOIN now behaves like an inner join.`,
            `If unmatched rows should be kept, move the condition into the join: ${code(fixed)}. If they should be dropped, use an inner JOIN to say so.`, fixed, b);
        }
      }
    }
    if (!b.dml && b.sources.some((s) => s.join && s.join.implicit && s.join.kind !== 'CROSS')) {
      const ora = b.sources.some((s) => s.join && s.join.oracle);
      const first = b.sources.find((s) => s.join && s.join.implicit);
      add('implicit-join', 'low', first.node, ora ? 'Outer joins use the old Oracle (+) syntax' : 'Tables are joined with commas in FROM and conditions in WHERE',
        ora ? 'The (+) notation is Oracle-only, cannot express some joins (FULL, OR conditions), and is easy to break by forgetting one (+).' : 'This works, but it mixes join conditions with filters, which makes a missing condition (a cross join) easy to miss.',
        `Write each table as ${code(ora ? 'LEFT JOIN table ON …' : 'JOIN table ON …')} with its condition next to it.`, null, b);
    }

    // ---------- WHERE ----------
    const whereConds = conjuncts(sel.where);
    if (sel.where) {
      walkExpr(sel.where, (n) => {
        if (n.type === 'func' && n.over) { add('window-in-where', 'high', n, `${code(text(n))} is a window function inside WHERE`, 'Window functions are calculated after WHERE, so databases reject this.', 'Calculate it in a subquery or CTE and filter on it outside (or use QUALIFY in Snowflake, BigQuery and Databricks).', null, b); return false; }
        if (isAggregate(n)) { add('aggregate-in-where', 'high', n, `${code(text(n))} is an aggregate inside WHERE`, 'WHERE filters rows before they are grouped, so aggregates are not available there and databases reject this.', 'Move the condition to HAVING (after GROUP BY).', null, b); return false; }
        return true;
      });
      for (const u of b.uses.filter((x) => x.clause === 'where' && x.col.parts.length === 1)) {
        const r = u.res || {};
        const alias = (sel.columns || []).find((it) => it && it.alias && it.alias.toLowerCase() === u.col.parts[0].toLowerCase());
        if (!alias || (alias.expr.type === 'col' && alias.expr.parts[alias.expr.parts.length - 1].toLowerCase() === u.col.parts[0].toLowerCase())) continue;
        if (r.source && r.catalogColumn) continue; // a real column with that name exists
        add('alias-in-where', catalog || r.notFound ? 'high' : 'medium', u.col, `${code(u.col.parts[0])} looks like the SELECT alias for ${code(text(alias.expr))}`,
          'Aliases defined in SELECT are not visible in WHERE in most databases (WHERE runs first), so this is an error or refers to a different column.',
          `Repeat the expression (${code(text(alias.expr))}) in WHERE, or wrap the query in a subquery and filter on the alias outside.`, null, b);
      }
    }
    const allConds = [...whereConds, ...b.sources.flatMap((s) => (s.join && s.join.on && !s.join.implicit ? conjuncts(s.join.on) : []))];
    for (const c of allConds) {
      walkExpr(c, (n) => {
        if (n.type === 'bin' && (n.op === '=' || n.op === '<>') && ((n.right.type === 'lit' && n.right.kind === 'null') || (n.left.type === 'lit' && n.left.kind === 'null'))) {
          const col = n.right.type === 'lit' ? n.left : n.right;
          const fixed = `${text(col)} IS ${n.op === '<>' ? 'NOT ' : ''}NULL`;
          add('equals-null', 'high', n, `${code(text(n))} is never true`, 'Comparing anything with NULL using = or <> gives NULL (unknown), not true, so no row ever matches.', `Use ${code(fixed)}.`, fixed, b);
        }
        if (n.type === 'in' && n.not && n.list && n.list.some((x) => x.type === 'lit' && x.kind === 'null')) {
          add('not-in-null-literal', 'high', n, 'The NOT IN list contains NULL, so the condition is never true', '`x NOT IN (1, NULL)` means `x <> 1 AND x <> NULL`, and the second part is never true.', 'Remove NULL from the list and add a separate IS NOT NULL check if needed.', null, b);
        }
        if (n.type === 'in' && n.not && n.query) {
          const sb = m.blocks.find((x) => x.query === n.query || x.node === n.query.body);
          const nullable = subqueryNullable(sb, m);
          if (nullable !== false) {
            const rw = notExistsRewrite(n, sb, m, text);
            add('not-in-null', nullable === true ? 'high' : 'medium', n, 'NOT IN (subquery) returns no rows at all if the subquery returns a NULL',
              `If ${sb && sb.outputs[0] ? code(text(sb.outputs[0].expr)) : 'the subquery column'} is NULL in even one row, ${code('x NOT IN (…)')} is unknown for every x and the filter removes everything.${nullable === true ? ' The loaded schema says this column allows NULLs.' : ''}`,
              rw ? `Use NOT EXISTS, which handles NULLs as expected: ${code(rw)}` : 'Use NOT EXISTS with a correlated condition instead.', rw, b);
          }
        }
        if (n.type === 'between' && !n.not && looksTimestamp(n.left, m, b) && isDateOnly(n.high)) {
          const hiText = text(n.high);
          const next = nextDayLiteral(n.high);
          const fixed = `${text(n.left)} >= ${text(n.low)} AND ${text(n.left)} < ${next || plusOneDay(hiText)}`;
          add('between-timestamp', 'medium', n, `${code(text(n))} misses most of the last day`,
            `${code(text(n.left))} looks like a date-and-time column, and ${code(hiText)} means midnight at the start of that day. Anything later that day is left out.`,
            `Use a half-open range: ${code(fixed)}.`, fixed, b);
        }
        if (n.type === 'like' && !n.list && n.right && n.right.type === 'lit' && n.right.kind === 'string' && /^%/.test(n.right.value) && n.left.type === 'col') {
          add('leading-wildcard', 'low', n, `${code(text(n))} starts with a wildcard`, "A pattern starting with '%' cannot use a normal index, so the database reads every row. That is fine for small tables.", 'For large tables, consider full-text search or a trigram index (PostgreSQL pg_trgm) if this filter is frequent.', null, b);
        }
        return n.type !== 'subquery' && n.type !== 'exists';
      });
    }
    for (const c of allConds) {
      const f = sargability(c, b, m, text, dateLit, plusOneDay);
      if (f) add('function-on-column', 'medium', c, f.title, f.detail, f.fix, f.fixSql, b);
    }
    // ROWNUM
    const rownum = whereConds.find((c) => columnRefs(c).length === 0 && /\bROWNUM\b/i.test(text(c)));
    if (rownum && b.orderBy && b.orderBy.length) {
      const n = /\d+/.exec(text(rownum));
      add('rownum-order', 'high', rownum, `${code(text(rownum))} is applied before ORDER BY`, 'Oracle numbers rows as they are read, before sorting, so this returns an arbitrary set of rows which are then sorted. It does not return the top rows by the sort order.',
        `On Oracle 12c and later, remove the ROWNUM condition and add ${code(`FETCH FIRST ${n ? n[0] : 'n'} ROWS ONLY`)} after ORDER BY. On older versions, sort in a subquery and apply ROWNUM outside it.`, null, b);
    } else if (rownum && b.kind === 'main') {
      add('limit-without-order', 'medium', rownum, `${code(text(rownum))} limits the rows without any ORDER BY`, 'Which rows come back is up to the database and can change between runs.', 'Add an ORDER BY (and use FETCH FIRST n ROWS ONLY on Oracle 12c+) if specific rows are wanted.', null, b);
    }
    // limit without order
    const lim = b.limit || (sel.top && sel.top.n);
    if (lim && !(b.orderBy && b.orderBy.length) && b.kind !== 'subquery') {
      const node = sel.top || b.limit;
      add('limit-without-order', 'medium', node, `${code(sel.top ? text(sel.top) : `LIMIT ${text(b.limit)}`)} without ORDER BY`, 'Without a sort order the database may return any rows that match, and the result can change from one run to the next.', 'Add ORDER BY with the columns that decide which rows you want.', null, b);
    }

    // ---------- grouping ----------
    const grouped = sel.groupBy && sel.groupBy.items && sel.groupBy.items.length;
    const aggOutputs = b.outputs.filter((o) => o.expr && !o.star && hasAggregate(o.expr));
    if (grouped || aggOutputs.length) {
      const groupItems = grouped ? sel.groupBy.items : [];
      const norm = (n) => text(n).replace(/\s+/g, '').toLowerCase();
      const groupTexts = new Set(groupItems.map(norm));
      const groupCols = groupItems.flatMap((g) => (g.type === 'col' ? [m.resolve(b, g) || {}] : []));
      const ordinals = new Set(groupItems.filter((g) => g.type === 'lit' && g.kind === 'number').map((g) => Number(g.value) - 1));
      const aliasGroups = new Set(groupItems.filter((g) => g.type === 'col' && g.parts.length === 1).map((g) => g.parts[0].toLowerCase()));
      b.outputs.forEach((o, i) => {
        if (!o.expr || o.star || o.raw || hasWindow(o.expr)) return;
        if (groupTexts.has(norm(o.expr)) || ordinals.has(i) || (o.alias && aliasGroups.has(o.alias.toLowerCase()))) return;
        const loose = columnRefs(o.expr, { skipAggregates: true }).filter((c) => {
          const r = m.resolve(b, c) || {};
          if (r.correlated) return false;
          if (groupTexts.has(norm(c))) return false;
          if (groupCols.some((g) => g.source && g.source === r.source && String(g.column).toLowerCase() === String(r.column).toLowerCase())) return false;
          // functionally dependent on a grouped key (allowed by PostgreSQL and MySQL)
          if (r.source && !['oracle', 'sqlserver'].includes(dialect)) {
            const keyed = groupCols.filter((g) => g.source === r.source).map((g) => g.column);
            if (keyed.length && m.isKey(r.source, keyed)) return false;
          }
          return true;
        });
        if (!loose.length || o.expr.type === 'lit') return;
        const names = [...new Set(loose.map((c) => text(c)))];
        add('ungrouped-column', 'high', o.item || o.expr, `${code(o.name)} uses ${listCodes(names)}, which ${names.length === 1 ? 'is' : 'are'} not in GROUP BY and not inside an aggregate`,
          grouped ? 'Each group can contain many different values here, so the database rejects the query (MySQL without ONLY_FULL_GROUP_BY silently picks one of them).' : 'The query also has aggregates, which collapse all rows into one; the database cannot say which single value to show here.',
          grouped ? `Add ${listCodes(names)} to GROUP BY, or wrap ${names.length === 1 ? 'it' : 'them'} in an aggregate such as ${code(`MAX(${names[0]})`)}.` : `Add GROUP BY ${names.join(', ')}, or wrap ${names.length === 1 ? 'it' : 'them'} in an aggregate.`, null, b);
      });
    }
    if (sel.having) {
      for (const c of conjuncts(sel.having)) {
        if (!hasAggregate(c) && columnRefs(c).length && !columnRefs(c).some((x) => (m.resolve(b, x) || {}).outputAlias)) {
          add('having-without-aggregate', 'low', c, `${code(text(c))} in HAVING does not use an aggregate`, 'It filters individual rows, so it can go in WHERE, where it runs before grouping and lets the database skip rows early.', `Move ${code(text(c))} to the WHERE clause.`, null, b);
        }
      }
    }
    for (const g of [...(grouped ? sel.groupBy.items : []), ...((b.orderBy || []).map((o) => o.expr))]) {
      if (g.type === 'lit' && g.kind === 'number' && Number.isInteger(g.value)) {
        const o = b.outputs[g.value - 1];
        add('ordinal-reference', 'low', g, `${code(String(g.value))} refers to the ${ordinal(g.value)} selected column${o ? ` (${code(o.name)})` : ''}`, 'Numbers in GROUP BY / ORDER BY break silently when someone reorders or adds columns in SELECT.', o ? `Use the column itself: ${code(o.name)}.` : null, null, b);
      }
    }

    // ---------- windows ----------
    for (const o of b.outputs) {
      if (!o.expr || o.star) continue;
      walkExpr(o.expr, (n) => {
        if (n.type === 'func' && n.over && ['ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE', 'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE', 'NTH_VALUE', 'PERCENT_RANK', 'CUME_DIST'].includes(n.name)) {
          const over = sp.overSpec(n, b);
          if (!over.orderBy || !over.orderBy.length) add('row-number-without-order', 'medium', n, `${code(n.name + '()')} has no ORDER BY in its OVER clause`, 'The numbering (or previous/next row) is then arbitrary and can change between runs.', 'Add ORDER BY inside OVER (…) with the columns that decide the order.', null, b);
        }
        return true;
      });
    }

    // ---------- DISTINCT / UNION / subqueries ----------
    if (sel.distinct && !sel.distinctOn) {
      const fan = b.sources.slice(1).filter((s) => { const j = m.joinInfo(b, s); return j.card === '1:N' || j.card === 'N:N'; });
      if (fan.length) add('distinct-hides-join', 'medium', sel, `DISTINCT is combined with a join that repeats rows (${listCodes(fan.map((s) => s.displayName))})`, `The join to ${listCodes(fan.map((s) => s.displayName))} creates one row per ${fan[0].entity}; DISTINCT then removes the repeats. That works but is slow, and it hides the fact that the join is only used as a filter.`, `If the join only checks that a ${fan[0].entity} exists, use ${code('WHERE EXISTS (SELECT 1 FROM …)')} instead and drop DISTINCT.`, null, b);
    }
    for (const q of b.subqueries) {
      if (q.clause !== 'select' || q.kind !== 'subquery') continue;
      const corr = sp.correlation(q.block);
      if (corr.links.length) add('correlated-subquery', 'medium', q.node, 'A subquery in SELECT runs once for every row', `${code(oneLine(text(q.node)).slice(0, 80))} refers to the outer row, so the database may run it once per result row. On large results this is slow.`, 'Join a grouped subquery (one row per key) instead, or use a window function.', null, b);
    }
    if ((b.kind === 'cte' || b.kind === 'derived') && b.orderBy && b.orderBy.length && !b.limit && !(sel.top) && !b.fetch) {
      add('order-in-subquery', 'low', b.orderBy[0], `ORDER BY inside ${b.kind === 'cte' ? code(b.name) : 'a subquery'} does not order the final result`, 'The outer query is free to return rows in any order, and SQL Server rejects ORDER BY in subqueries without TOP.', 'Move the ORDER BY to the outermost query.', null, b);
    }
    // division
    for (const o of b.outputs) {
      if (!o.expr || o.star) continue;
      walkExpr(o.expr, (n) => {
        if (n.type === 'bin' && n.op === '/' && !neverZero(n.right, b, m) && (n.right.type === 'col' || isAggregate(n.right) || (n.right.type === 'func' && !['NULLIF', 'NULLIFZERO', 'GREATEST', 'COALESCE'].includes(n.right.name)) || (n.right.paren && n.right.type === 'bin'))) {
          const fixed = `${text(n.left)} / NULLIF(${text(n.right)}, 0)`;
          if (dialect !== 'mysql') add('division-by-zero', 'low', n, `${code(text(n))} fails if ${code(text(n.right))} is 0`, `${dialect === 'generic' ? 'Most databases raise' : 'This database raises'} a division-by-zero error and the whole query fails (MySQL returns NULL instead).`, `Use ${code(fixed)} to get NULL instead of an error.`, fixed, b);
        }
        return true;
      });
    }
    // SELECT *
    if (b === m.main || (b.kind === 'branch' && b.branchOf === m.main)) {
      for (const o of b.outputs.filter((x) => x.star || x.fromStar)) {
        const item = o.item;
        if (!item || out.some((f) => f.rule === 'select-star' && f.s === item.s)) continue;
        const cols = b.outputs.filter((x) => x.item === item && x.fromStar).map((x) => x.name);
        const isView = m.stmt.type === 'create' || m.stmt.type === 'insert';
        add('select-star', isView ? 'medium' : 'low', item, `${code(text(item))} selects every column`, isView ? `In ${m.stmt.type === 'insert' ? 'an INSERT … SELECT' : 'a view'}, a column added to the table later changes (or breaks) the result.` : 'The result changes whenever the table changes, and it reads columns you may not need (slower, and may expose personal data).', cols.length ? `List the columns you need, for example: ${code(cols.slice(0, 8).join(', ') + (cols.length > 8 ? ', …' : ''))}.` : 'List the columns you need.', cols.length ? cols.join(', ') : null, b);
      }
    }
  }

  // set operations
  for (const b of m.blocks.filter((x) => x.setop && x.setop.op === 'UNION' && !x.setop.all)) {
    add('union-distinct', 'low', b.node.opTok || b.node, 'UNION removes duplicate rows', 'To find duplicates the database sorts or hashes the whole result. If the parts cannot overlap, or duplicates are fine, UNION ALL gives the same rows faster.', 'Use UNION ALL unless removing duplicates is intended.', null, b);
  }
  // unused CTEs
  const usedCtes = new Set(m.blocks.flatMap((b) => (b.sources || []).filter((s) => s.kind === 'cte').map((s) => s.cteBlock)));
  for (const c of m.blocks.filter((b) => b.kind === 'cte')) {
    if (!usedCtes.has(c)) add('unused-cte', 'medium', c.cte ? { s: c.cte.s, e: c.cte.nameTok ? c.cte.nameTok.e : c.cte.e } : c.node, `The CTE ${code(c.name)} is defined but never used`, 'It does no harm in most databases, but it is dead code (or a sign that the wrong CTE is referenced somewhere).', `Remove ${code(c.name)}, or check that the query reads from the CTE you intended.`, null, c);
  }
  // UPDATE that sets a column to its own value
  if (st.type === 'update') {
    for (const a of st.set) {
      if (a.columns.length !== 1) continue;
      const colName = a.columns[0].parts[a.columns[0].parts.length - 1].toLowerCase();
      const sameCol = (x) => x && x.type === 'col' && x.parts[x.parts.length - 1].toLowerCase() === colName;
      const empty = (x) => x && x.type === 'lit' && x.kind === 'string' && x.value === '';
      const v = a.value;
      const noop = sameCol(v) || (v.type === 'bin' && v.op === '||' && ((empty(v.left) && sameCol(v.right)) || (sameCol(v.left) && empty(v.right)))) || (v.type === 'func' && v.name === 'CONCAT' && v.args.filter((x) => !empty(x)).length === 1 && v.args.some(sameCol));
      if (noop) add('no-op-update', 'medium', a, `${code(text(a))} sets ${code(colName)} to the value it already has`,
        'The UPDATE changes nothing in these rows, but it still rewrites them, takes locks and fires triggers. Often a prefix or other text was removed from the expression at some point.',
        'Remove the statement, or restore the text that was meant to be added (for example a URL prefix).', null, m.main);
    }
  }
  // DML without WHERE
  if ((st.type === 'update' || st.type === 'delete') && !st.where) {
    add('update-without-where', 'high', st, `This ${st.type.toUpperCase()} has no WHERE clause`, `Every row in ${code(m.target.name)} will be ${st.type === 'update' ? 'changed' : 'deleted'}.`, 'Add a WHERE clause. If changing every row is intended, run it inside a transaction and check the row count before committing.', null, m.main);
  }
  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.s - b.s).map(({ key, ...f }) => f);
}

// ---------- helpers ----------
function code(s) { return `\`${String(s).replace(/`/g, "'")}\``; }
function listCodes(a) { const x = a.map(code); return x.length <= 1 ? x[0] || '' : `${x.slice(0, -1).join(', ')} and ${x[x.length - 1]}`; }
function oneLine(s) { return String(s).replace(/\s+/g, ' ').trim(); }
function lineOf(text, offset) { let n = 1; for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') n++; return n; }
function ordinal(n) { return ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'][n - 1] || `${n}th`; }
function parentStep(b, sp) { for (let x = b.parent; x; x = x.parent) if (sp.stepName(x)) return x; return null; }
function scopeRefs(b) { const out = []; for (let x = b; x; x = x.parent) out.push(...(x.sources || []).map((s) => s.ref)); return out; }
function isSystemTable(parts) { return /^(dual|information_schema|pg_catalog|sys|all_\w+|user_\w+|dba_\w+)$/i.test(parts[0]) || /^dual$/i.test(parts[parts.length - 1]) || /^(pg_|sqlite_)/i.test(parts[parts.length - 1]); }

function closest(name, options) {
  const n = String(name).toLowerCase();
  let best = null;
  let bestD = Infinity;
  for (const o of options) {
    const d = lev(n, o.toLowerCase());
    if (d < bestD) { bestD = d; best = o; }
  }
  return best && bestD <= Math.max(2, Math.floor(n.length / 4)) ? best : null;
}
function lev(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return dp[b.length];
}

/** Is a WHERE conjunct still true when the LEFT JOINed source's columns are NULL? */
function nullTolerant(c, s, b, m) {
  if (c.type === 'isnull' && !c.not) return true;
  if (c.type === 'bin' && c.op === 'OR') return [c.left, c.right].some((x) => nullTolerant(x, s, b, m) || !columnRefs(x).some((r) => (m.resolve(b, r) || {}).source === s));
  if (c.type === 'func' && ['COALESCE', 'NVL', 'IFNULL', 'ISNULL'].includes(c.name)) return true;
  if (c.type === 'bin' && ['=', '<>', '<', '>', '<=', '>='].includes(c.op) && [c.left, c.right].some((x) => x.type === 'func' && ['COALESCE', 'NVL', 'IFNULL', 'ISNULL', 'ZEROIFNULL'].includes(x.name))) return true;
  if (c.type === 'bin' && (c.op === 'IS NOT DISTINCT FROM' || c.op === 'IS DISTINCT FROM')) return true;
  if (c.type === 'istruth') return c.not;
  return false;
}

function subqueryNullable(sb, m) {
  if (!sb || !sb.outputs || !sb.outputs[0] || !sb.outputs[0].expr) return null;
  const e = sb.outputs[0].expr;
  if (e.type !== 'col') return null;
  const r = m.resolve(sb, e) || {};
  if (r.catalogColumn) return r.catalogColumn.nullable ? true : false;
  if (r.source && m.isKey(r.source, [r.column])) return false; // primary keys are never NULL
  // filtered with IS NOT NULL in the subquery?
  const where = sb.select ? conjuncts(sb.select.where) : [];
  if (where.some((c) => c.type === 'isnull' && c.not && c.expr.type === 'col' && c.expr.parts[c.expr.parts.length - 1].toLowerCase() === e.parts[e.parts.length - 1].toLowerCase())) return false;
  return null;
}

function notExistsRewrite(n, sb, m, text) {
  if (!sb || !sb.select || !sb.select.from.length || !sb.outputs[0] || !sb.outputs[0].expr) return null;
  const sel = sb.select;
  if (sel.groupBy || sb.setop) return null;
  const fromText = text({ s: sel.from[0].s, e: sel.from[sel.from.length - 1].e });
  let inner = text(sb.outputs[0].expr);
  if (sb.outputs[0].expr.type === 'col' && sb.outputs[0].expr.parts.length === 1 && sb.sources[0]) inner = `${sb.sources[0].ref}.${inner}`;
  const where = sel.where ? ` AND ${text(sel.where)}` : '';
  return oneLine(`NOT EXISTS (SELECT 1 FROM ${fromText} WHERE ${inner} = ${text(n.left)}${where})`);
}

function suggestJoin(b, s, catalog, m) {
  const earlier = b.sources.slice(0, s.index);
  for (const o of earlier) {
    if (catalog && s.table && o.table) {
      const fk = s.table.foreignKeys.find((f) => f.refTable === o.table) || o.table.foreignKeys.find((f) => f.refTable === s.table);
      if (fk) {
        const fromS = s.table.foreignKeys.includes(fk);
        const [a, bb] = fromS ? [s, o] : [o, s];
        return `JOIN ${s.displayName}${s.alias ? ` ${s.alias}` : ''} ON ${fk.columns.map((c, i) => `${a.ref}.${c} = ${bb.ref}.${fk.refColumns[i] || 'id'}`).join(' AND ')}`;
      }
    }
    // naming: s has <o entity>_id, or o has <s entity>_id
    const sEnt = (s.entity || '').replace(/\s+/g, '_');
    const oEnt = (o.entity || '').replace(/\s+/g, '_');
    if (s.columns && s.columns.some((c) => c.toLowerCase() === `${oEnt}_id`)) return `JOIN ${s.displayName}${s.alias ? ` ${s.alias}` : ''} ON ${s.ref}.${oEnt}_id = ${o.ref}.id`;
    if (o.columns && o.columns.some((c) => c.toLowerCase() === `${sEnt}_id`)) return `JOIN ${s.displayName}${s.alias ? ` ${s.alias}` : ''} ON ${o.ref}.${sEnt}_id = ${s.ref}.id`;
  }
  void m;
  return null;
}

function looksTimestamp(e, m, b) {
  if (e.type !== 'col') return false;
  const r = m.resolve(b, e) || {};
  if (r.catalogColumn) return r.catalogColumn.category === 'datetime';
  const name = e.parts[e.parts.length - 1];
  return /(_at|_on|time|tmsp|timestamp|dttm|dtm|_ts)$|At$|Time$|DateTime$/i.test(name);
}

/** A COUNT from a grouped CTE/subquery is at least 1, so dividing by it is safe. */
function neverZero(e, b, m) {
  if (e.type === 'func' && (e.name === 'COUNT' || e.name === 'COUNT_BIG') && b.select && b.select.groupBy && (!e.args.length || e.args[0].type === 'star' || e.args[0].type === 'lit')) return true;
  if (e.type !== 'col') return false;
  const r = m.resolve(b, e) || {};
  const inner = r.source && (r.source.kind === 'cte' ? r.source.cteBlock : r.source.kind === 'derived' ? r.source.inner : null);
  if (!inner || !inner.select || !inner.outputs) return false;
  const o = inner.outputs.find((x) => x.name.toLowerCase() === String(r.column).toLowerCase());
  return !!(o && o.expr && o.expr.type === 'func' && ['COUNT', 'COUNT_BIG'].includes(o.expr.name) && !o.expr.distinct && (!o.expr.args.length || o.expr.args[0].type === 'star' || o.expr.args[0].type === 'lit') && inner.select.groupBy);
}

/** '2025-12-31' -> '2026-01-01' (same quoting / DATE prefix as the original). */
function nextDayLiteral(e) {
  if (!e || e.type !== 'lit' || !(e.kind === 'string' || e.kind === 'date')) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(e.value).trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  const iso = d.toISOString().slice(0, 10);
  return e.kind === 'date' ? `DATE '${iso}'` : `'${iso}'`;
}

function isDateOnly(e) {
  if (!e) return false;
  if (e.type === 'lit' && e.kind === 'date') return true;
  if (e.type === 'lit' && e.kind === 'string') return /^\d{4}-\d{2}-\d{2}$/.test(e.value.trim()) || /^\d{1,2}[-/][A-Za-z]{3}[-/]\d{2,4}$/.test(e.value.trim());
  if (e.type === 'func' && ['TO_DATE', 'DATE'].includes(e.name) && e.args[0] && e.args[0].type === 'lit') return !/\d{1,2}:\d{2}/.test(String(e.args[0].value));
  return false;
}

const WRAPPERS = new Set(['UPPER', 'LOWER', 'TRUNC', 'DATE', 'YEAR', 'MONTH', 'DAY', 'TO_CHAR', 'DATE_TRUNC', 'DATE_FORMAT', 'SUBSTR', 'SUBSTRING', 'LEFT', 'RIGHT', 'COALESCE', 'NVL', 'ISNULL', 'IFNULL', 'TRIM', 'LTRIM', 'RTRIM', 'EXTRACT', 'DATEPART', 'DATE_PART', 'CONVERT', 'TO_NUMBER', 'TO_DATE', 'ABS', 'ROUND', 'FLOOR', 'CAST', 'STRFTIME', 'FORMAT', 'LEN', 'LENGTH', 'CONCAT', 'REPLACE']);

function sargability(c, b, m, text, dateLit, plusOneDay) {
  if (c.type !== 'bin' || !['=', '<', '>', '<=', '>=', '<>'].includes(c.op)) {
    if (c.type === 'between' || c.type === 'in' || c.type === 'like') return wrappedSide(c.left) ? describe(c.left, c, null) : null;
    return null;
  }
  let side = null;
  let other = null;
  if (wrappedSide(c.left)) { side = c.left; other = c.right; } else if (wrappedSide(c.right)) { side = c.right; other = c.left; }
  if (!side) return null;
  const col = wrappedCol(side);
  const r = m.resolve(b, col) || {};
  if (!r.source || r.source.kind !== 'table' || r.correlated) return null;
  // other side must not depend on the same table (join conditions between 2 tables still count)
  if (columnRefs(other).some((x) => (m.resolve(b, x) || {}).source === r.source)) return null;
  return describe(side, c, other);

  function describe(sideExpr, whole, otherExpr) {
    const colE = wrappedCol(sideExpr);
    const colText = text(colE);
    const fn = sideExpr.type === 'cast' ? 'CAST' : sideExpr.name;
    let fix = 'Compare the plain column with a value calculated from the other side, so an index on the column can be used.';
    let fixSql = null;
    const unit = sideExpr.type === 'func' && ['YEAR', 'EXTRACT', 'DATEPART', 'DATE_PART'].includes(sideExpr.name) ? (sideExpr.name === 'YEAR' ? 'year' : String(sideExpr.args[0] && (sideExpr.args[0].value || (sideExpr.args[0].parts || [])[0]) || '').toLowerCase()) : null;
    if (whole.type === 'bin' && whole.op === '=' && unit === 'year' && otherExpr && otherExpr.type === 'lit' && /^\d{4}$/.test(String(otherExpr.value))) {
      const y = Number(otherExpr.value);
      fixSql = `${colText} >= ${dateLit(`${y}-01-01`)} AND ${colText} < ${dateLit(`${y + 1}-01-01`)}`;
      fix = `Use a range on the column instead: ${code(fixSql)}.`;
    } else if (whole.type === 'bin' && whole.op === '=' && otherExpr && isDayTrunc(sideExpr)) {
      const v = text(otherExpr);
      const minus = /^(.*\S)\s*-\s*(\d+)$/.exec(v);
      const lit = nextDayLiteral(otherExpr);
      const upper = lit || (minus && /\bSYSDATE\b|\bCURRENT_DATE\b/i.test(minus[1]) && plusOneDay('x') === 'x + 1' ? (Number(minus[2]) === 1 ? minus[1] : `${minus[1]} - ${Number(minus[2]) - 1}`) : plusOneDay(v));
      fixSql = `${colText} >= ${v} AND ${colText} < ${upper}`;
      fix = `Use a range on the column instead: ${code(fixSql)}.`;
    } else if (['UPPER', 'LOWER'].includes(fn)) {
      fix = `Create an index on ${code(`${fn}(${colText})`)} (PostgreSQL, Oracle) or rely on a case-insensitive collation (SQL Server and MySQL usually compare case-insensitively already).`;
    } else if (['COALESCE', 'NVL', 'ISNULL', 'IFNULL'].includes(fn) && otherExpr) {
      fixSql = `(${colText} = ${text(otherExpr)} OR (${colText} IS NULL AND ${text(sideExpr.args[1])} = ${text(otherExpr)}))`;
      fix = whole.op === '=' ? `Spell out the NULL case: ${code(fixSql)}.` : fix;
      if (whole.op !== '=') fixSql = null;
    }
    return {
      title: `${code(text(sideExpr))} wraps ${code(colText)} in ${fn === 'CAST' ? 'a cast' : `${fn}()`}`,
      detail: `An index on ${code(colText)} cannot be used when the column is inside a function, so the database may read every row to evaluate this filter.`,
      fix,
      fixSql,
    };
  }
}

function wrappedSide(e) {
  if (!e) return false;
  if (e.type === 'cast') return e.expr.type === 'col';
  if (e.type !== 'func' || !WRAPPERS.has(e.name) || e.over) return false;
  const cols = e.args.filter((a) => a.type === 'col');
  return cols.length === 1 && e.args.every((a) => a.type === 'col' || a.type === 'lit' || a.type === 'typename');
}
function wrappedCol(e) { return e.type === 'cast' ? e.expr : e.args.find((a) => a.type === 'col'); }
function isDayTrunc(e) {
  if (e.type === 'cast') return /^date\s*$/i.test(String(e.to).trim());
  if (e.name === 'TRUNC' && e.args.length === 1) return looksDate(e.args[0]);
  if (e.name === 'DATE' && e.args.length === 1) return true;
  if (e.name === 'DATE_TRUNC' && e.args[0] && /day/i.test(String(e.args[0].value))) return true;
  if ((e.name === 'CONVERT' || e.name === 'TRY_CONVERT') && e.args[0] && e.args[0].type === 'typename' && /^date$/i.test(e.args[0].name)) return true;
  return false;
}
