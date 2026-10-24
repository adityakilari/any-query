// Data-flow graph for the diagram: tables -> CTEs / subqueries -> result (-> target table).
// Layout is done by the UI; this only says what feeds what.
import { conjuncts, hasAggregate, hasWindow } from './parse.js';

export function buildFlow(m, ex) {
  if (!m.main) return null;
  const sp = ex && ex.steps ? null : null;
  void sp;
  const stepOf = new Map((ex.steps || []).map((s) => [s.block, s.n]));
  const nodes = [];
  const edges = [];
  const blockNode = new Map();
  const tableNode = new Map();

  const tableId = (s) => {
    const key = s.displayName.toLowerCase();
    if (!tableNode.has(key)) {
      const id = `t${tableNode.size + 1}`;
      tableNode.set(key, id);
      nodes.push({ id, kind: s.kind === 'table' ? 'table' : s.kind, label: s.displayName, sub: s.table && s.table.roleLabel ? s.table.roleLabel : s.kind === 'function' ? 'table function' : s.kind === 'values' ? 'fixed values' : 'table', known: s.table ? true : m.catalog && s.kind === 'table' ? false : null });
    }
    return tableNode.get(key);
  };

  const shown = (b) => stepOf.has(b) || b === m.main;
  const nodeFor = (b) => {
    if (blockNode.has(b)) return blockNode.get(b);
    const id = `b${blockNode.size + 1}`;
    blockNode.set(b, id);
    const n = stepOf.get(b);
    const label = b === m.main ? (m.stmt.type === 'query' ? 'Result' : m.stmt.type === 'insert' ? 'Rows to insert' : m.stmt.type === 'create' ? m.target.name : `${m.stmt.type.toUpperCase()}`) : b.kind === 'cte' ? b.name : b.kind === 'derived' ? (b.name || 'subquery') : b.kind === 'branch' ? `part ${b.branchIndex + 1}` : 'subquery';
    nodes.push({ id, kind: b === m.main ? 'main' : b.kind, label, step: n || null, ops: ops(b, m), sub: b.setop ? `${b.setop.op}${b.setop.all ? ' ALL' : ''}` : null });
    return id;
  };

  const edge = (from, to, label, style = 'solid') => { if (!edges.some((e) => e.from === from && e.to === to && e.label === label)) edges.push({ from, to, label, style }); };

  const visit = (b, intoId = null, viaLabel = null, viaStyle = 'solid') => {
    if (!b || b.pending) return;
    let me = intoId;
    if (shown(b)) {
      me = nodeFor(b);
      if (intoId && intoId !== me) edge(me, intoId, viaLabel, viaStyle);
    }
    if (b.setop) {
      for (const br of b.branches) visit(br, me, b.setop.op + (b.setop.all ? ' ALL' : ''));
      return;
    }
    const inline = !shown(b) && viaLabel;
    for (const s of b.sources || []) {
      let label = s.join ? (s.join.kind === 'CROSS' ? (s.join.implicit ? 'CROSS (comma)' : 'CROSS JOIN') : `${s.join.kind === 'INNER' ? '' : s.join.kind + ' '}JOIN`.trim()) : 'FROM';
      let style = 'solid';
      if (inline) { label = viaLabel; style = viaStyle; }
      if (s.kind === 'cte') visit(s.cteBlock, me, label, style);
      else if (s.kind === 'derived') visit(s.inner, me, label, style);
      else edge(tableId(s), me, label, style);
    }
    for (const q of b.subqueries || []) {
      const lbl = q.kind === 'exists' ? (q.not ? 'NOT EXISTS' : 'EXISTS') : q.kind === 'in' ? (q.not ? 'NOT IN' : 'IN') : q.kind === 'quant' ? 'ANY/ALL' : 'subquery';
      visit(q.block, me, lbl, 'dashed');
    }
  };
  for (const c of m.blocks.filter((x) => x.kind === 'cte' && !x.parent)) if (!blockNode.has(c)) { /* statement-level CTEs are visited through their users */ }
  visit(m.main);
  // statement-level CTEs that nothing reads still appear (flagged by review)
  for (const c of m.blocks.filter((x) => x.kind === 'cte' && !blockNode.has(x) && stepOf.has(x))) visit(c, null);

  if (m.target && m.stmt.type !== 'query') {
    const id = 'target';
    const verb = { insert: 'INSERT INTO', update: 'UPDATE', delete: 'DELETE FROM', merge: 'MERGE INTO', create: `CREATE ${String(m.target.kind).toUpperCase()}` }[m.stmt.type];
    if (m.stmt.type === 'create') {
      const main = nodes.find((n) => n.kind === 'main');
      if (main) { main.label = m.target.name; main.sub = m.target.kind; }
    } else {
      nodes.push({ id, kind: 'target', label: m.target.name, sub: verb });
      edge(blockNode.get(m.main) || nodes[nodes.length - 2].id, id, verb);
    }
  }
  return { nodes, edges };
}

function ops(b, m) {
  const out = [];
  if (b.setop) return out;
  if (b.values) return ['fixed values'];
  const sel = b.select;
  if (!sel) return out;
  const joins = b.sources.length - 1;
  if (joins > 0) out.push(`${joins} join${joins === 1 ? '' : 's'}`);
  const filters = conjuncts(sel.where).filter((c) => !(b.whereUsedByJoins && b.whereUsedByJoins.has(c)));
  if (filters.length) out.push(`filter (${filters.length})`);
  if (sel.groupBy && sel.groupBy.items && sel.groupBy.items.length) {
    const nouns = sel.groupBy.items.map((g) => { const n = m.groupNoun(b, g); return n ? n.noun : 'expression'; });
    out.push(`group by ${[...new Set(nouns)].join(', ')}`);
  } else if (b.outputs.some((o) => o.expr && hasAggregate(o.expr))) out.push('summarise');
  if (sel.having) out.push('having');
  if (b.outputs.some((o) => o.expr && hasWindow(o.expr))) out.push('window');
  if (sel.qualify) out.push('qualify');
  if (sel.distinct) out.push('distinct');
  if (b.orderBy && b.orderBy.length) out.push('sort');
  const lim = b.limit || (sel.top && sel.top.n);
  if (lim) out.push(`limit ${lim.type === 'lit' ? lim.value : ''}`.trim());
  if (b.dml) out.push(b.dml);
  return out;
}
