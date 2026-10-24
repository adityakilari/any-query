// Turns a parsed statement into "blocks": one per SELECT (main query, each CTE, each derived
// table, each subquery, each branch of a UNION). For every block it records its sources
// (tables, CTEs, subqueries) with their join conditions, its output columns, which source
// each column reference belongs to, and which sources are keyed on the join columns - the
// facts the explanation, the review rules and the flow diagram are built from.
import { conjuncts, columnRefs, subqueriesIn, walkExpr, isAggregate } from './parse.js';
import { entityNoun, normKey, singular, words } from 'any-schema/src/core/model.js';

export function buildModel(stmt, catalog = null, options = {}) {
  const m = { stmt, catalog, blocks: [], main: null, target: null };
  const vars = options.variables || null; // procedural variables and parameters (lower-case)
  let seq = 0;
  const resolved = new WeakMap();

  const newBlock = (props) => {
    const b = { id: `b${++seq}`, sources: [], outputs: [], subqueries: [], uses: [], ctes: new Map(), parent: null, ...props };
    m.blocks.push(b);
    return b;
  };

  // ---------- building ----------
  function queryBlock(q, kind, name, parent, ctesVisible) {
    const ctes = new Map(ctesVisible || []);
    const cteBlocks = [];
    if (q.type === 'query' && q.ctes) {
      for (const cte of q.ctes) {
        let placeholder = null;
        if (q.recursive) {
          placeholder = { id: 'pending', kind: 'cte', name: cte.name, outputs: (cte.columns || []).map((c) => ({ name: c })), sources: [], pending: true };
          ctes.set(cte.name.toLowerCase(), placeholder);
        }
        const cb = queryBlock(cte.query, 'cte', cte.name, parent, ctes);
        cb.cte = cte;
        cb.recursive = !!q.recursive && refersTo(cte.query, cte.name);
        if (cte.columns) cb.outputs.forEach((o, i) => { if (cte.columns[i]) o.name = cte.columns[i]; });
        ctes.set(cte.name.toLowerCase(), cb);
        cteBlocks.push(cb);
        if (placeholder) Object.assign(placeholder, { realBlock: cb });
      }
    }
    const body = q.type === 'query' ? q.body : q;
    const block = bodyBlock(body, kind, name, parent, ctes);
    block.cteBlocks = cteBlocks;
    if (q.type === 'query') {
      Object.assign(block, { query: q, orderBy: q.orderBy, limit: q.limit, offset: q.offset, fetch: q.fetch, ties: q.ties });
      // ORDER BY may name output aliases
      for (const o of q.orderBy || []) resolveIn(block.setop ? block.branches[0] : block, o.expr, 'order');
    }
    return block;
  }

  function bodyBlock(body, kind, name, parent, ctes) {
    if (body.type === 'pquery') return queryBlock(body.query, kind, name, parent, ctes);
    if (body.type === 'setop') {
      const block = newBlock({ kind, name, parent, ctes, node: body, setop: { op: body.op, all: body.all } });
      const flat = [];
      const flatten = (n) => {
        if (n.type === 'setop' && n.op === body.op && n.all === body.all) { flatten(n.left); flatten(n.right); } else flat.push(n);
      };
      flatten(body);
      block.branches = flat.map((br, i) => {
        const bb = bodyBlock(br, 'branch', `${name || 'part'} ${i + 1}`, parent, ctes);
        bb.branchOf = block;
        bb.branchIndex = i;
        return bb;
      });
      block.outputs = block.branches[0].outputs.map((o) => ({ ...o }));
      return block;
    }
    if (body.type === 'values') {
      const n = body.rows[0] ? body.rows[0].length : 0;
      return newBlock({ kind, name, parent, ctes, node: body, values: body, outputs: Array.from({ length: n }, (_, i) => ({ name: `column${i + 1}`, expr: body.rows[0][i] })) });
    }
    return selectBlock(body, kind, name, parent, ctes);
  }

  function selectBlock(sel, kind, name, parent, ctes, extra = {}) {
    const b = newBlock({ kind, name, parent, ctes, node: sel, select: sel, ...extra });
    sel.from.forEach((item, i) => addFromItem(b, item, i > 0 ? { kind: 'COMMA', node: item } : null));
    attachCommaJoins(b);
    buildOutputs(b);
    for (const s of b.sources) if (s.join && s.join.on) { resolveIn(b, s.join.on, 'on'); collectSubqueries(b, s.join.on, 'on'); }
    if (sel.where) { resolveIn(b, sel.where, 'where'); collectSubqueries(b, sel.where, 'where'); }
    if (sel.connectBy) { resolveIn(b, sel.connectBy.start, 'where'); resolveIn(b, sel.connectBy.cond, 'where'); }
    if (sel.groupBy && sel.groupBy.items) for (const g of sel.groupBy.items) resolveIn(b, g, 'group');
    if (sel.having) { resolveIn(b, sel.having, 'having'); collectSubqueries(b, sel.having, 'having'); }
    if (sel.qualify) { resolveIn(b, sel.qualify, 'qualify'); collectSubqueries(b, sel.qualify, 'qualify'); }
    for (const o of b.outputs) if (o.expr && !o.star) { resolveIn(b, o.expr, 'select'); collectSubqueries(b, o.expr, 'select'); }
    if (sel.distinctOn) for (const d of sel.distinctOn) resolveIn(b, d, 'select');
    return b;
  }

  function addFromItem(b, item, join) {
    if (!item || item.type === 'raw') { if (item) b.unreadable = true; return; }
    addSource(b, item.source, join);
    for (const j of item.joins) addSource(b, j.source, { kind: j.kind, on: j.on, using: j.using, natural: j.natural, node: j });
  }

  function addSource(b, src, join) {
    if (src.type === 'group') { addFromItem(b, src.item, join); return; }
    const s = { index: b.sources.length, alias: src.alias || null, node: src, join, block: b, used: new Set() };
    if (src.type === 'table') {
      const parts = src.name.parts;
      const last = parts[parts.length - 1];
      s.ref = src.alias || last;
      s.parts = parts;
      s.displayName = parts.join('.');
      const cte = parts.length === 1 ? b.ctes.get(last.toLowerCase()) : null;
      if (cte) {
        s.kind = 'cte';
        s.cteBlock = cte.realBlock || cte;
        s.entity = blockEntity(s.cteBlock) || entityNoun(last);
      } else {
        s.kind = 'table';
        s.table = catalog ? catalog.lookup(parts) : null;
        s.entity = entityNoun(last);
      }
    } else if (src.type === 'derived') {
      s.kind = 'derived';
      s.ref = src.alias || `subquery ${b.sources.length + 1}`;
      s.displayName = src.alias ? src.alias : '(subquery)';
      s.inner = queryBlock(src.query, 'derived', src.alias || null, b, b.ctes);
      if (src.columnAliases) s.inner.outputs.forEach((o, i) => { if (src.columnAliases[i]) o.name = src.columnAliases[i]; });
      s.entity = blockEntity(s.inner) || (src.alias ? entityNoun(src.alias) : 'row');
    } else if (src.type === 'function') {
      s.kind = 'function';
      s.ref = src.alias || src.name.parts[src.name.parts.length - 1];
      s.displayName = `${src.call.rawName || src.call.name}(…)`;
      s.entity = src.alias ? entityNoun(src.alias) : 'value';
      if (src.call) { for (const a of src.call.args) resolveIn(b, a, 'from'); collectSubqueries(b, src.call, 'from'); }
    } else {
      s.kind = 'values';
      s.ref = src.alias || 'values';
      s.displayName = 'VALUES (…)';
      s.entity = 'value row';
    }
    s.columns = sourceColumns(s);
    b.sources.push(s);
  }

  function sourceColumns(s) {
    if (s.node.columnAliases) return s.node.columnAliases.slice();
    if (s.kind === 'table') return s.table ? s.table.columns.map((c) => c.name) : null;
    const inner = s.kind === 'cte' ? s.cteBlock : s.kind === 'derived' ? s.inner : null;
    if (inner) {
      if (inner.pending) return inner.outputs.length ? inner.outputs.map((o) => o.name) : null;
      if (inner.outputs.some((o) => o.star)) return null;
      return inner.outputs.map((o) => o.name);
    }
    return null;
  }

  // Comma joins (FROM a, b WHERE a.x = b.y) and Oracle (+) outer joins: move the linking WHERE
  // conditions onto the joined source so they are explained (and checked) like JOIN ... ON.
  function attachCommaJoins(b) {
    const comma = b.sources.filter((s) => s.join && s.join.kind === 'COMMA');
    if (!comma.length || !b.select.where) { for (const s of comma) { s.join.kind = 'CROSS'; s.join.implicit = true; } return; }
    const parts = conjuncts(b.select.where);
    for (const s of comma) {
      s.join.where = [];
      for (const c of parts) {
        const refs = columnRefs(c);
        if (!refs.length) continue;
        const srcs = new Set(refs.map((r) => (resolve(b, r) || {}).source).filter(Boolean));
        if (!srcs.has(s)) continue;
        const others = [...srcs].filter((x) => x !== s);
        const linksEarlier = others.some((o) => o.index < s.index);
        const outerHere = refs.some((r) => r.oracleOuter && (resolve(b, r) || {}).source === s);
        const outerOther = refs.some((r) => r.oracleOuter && (resolve(b, r) || {}).source !== s);
        if (linksEarlier || ((outerHere || outerOther) && others.length === 0) || (outerHere && others.every((o) => o.index < s.index))) {
          s.join.where.push(c);
          if (outerHere) s.join.oracle = 'LEFT';
          if (outerOther && linksEarlier) s.join.oracle = 'RIGHT';
        }
      }
      const linking = s.join.where.filter((c) => { const srcs = new Set(columnRefs(c).map((r) => (resolve(b, r) || {}).source)); return srcs.size > 1; });
      if (!linking.length) s.join.kind = 'CROSS';
      else s.join.kind = s.join.oracle || 'INNER';
      s.join.implicit = true;
      s.join.on = s.join.where.length ? s.join.where.reduce((a, c) => (a ? { type: 'bin', op: 'AND', left: a, right: c, s: a.s, e: c.e } : c), null) : null;
    }
    b.whereUsedByJoins = new Set(comma.flatMap((s) => s.join.where || []));
  }

  function buildOutputs(b) {
    b.select.columns.forEach((item, i) => {
      if (!item || item.type === 'raw') { b.outputs.push({ name: `column${i + 1}`, expr: item, raw: true, item }); return; }
      const e = item.expr;
      if (e.type === 'star') {
        const qual = e.parts.length > 1 ? e.parts[e.parts.length - 2].toLowerCase() : null;
        const srcs = qual ? b.sources.filter((s) => s.ref.toLowerCase() === qual || (s.parts && s.parts[s.parts.length - 1].toLowerCase() === qual)) : b.sources;
        if (!srcs.length) { b.outputs.push({ name: e.parts.join('.'), star: true, expr: e, item, source: null }); return; }
        for (const s of srcs) {
          if (s.columns && !e.modifiers) {
            for (const c of s.columns) b.outputs.push({ name: c, expr: { type: 'col', parts: [s.ref, c], s: e.s, e: e.e, synthetic: true }, fromStar: true, item });
          } else {
            b.outputs.push({ name: `${s.ref}.*`, star: true, expr: e, item, source: s });
            s.used.add('*');
          }
        }
        return;
      }
      b.outputs.push({ name: item.alias || defaultName(e, i), alias: item.alias || null, expr: e, item, index: i });
    });
  }

  function collectSubqueries(b, expr, clause) {
    for (const node of subqueriesIn(expr)) {
      const sb = queryBlock(node.query, 'subquery', null, b, b.ctes);
      sb.subqueryOf = { node, clause, kind: node.type, not: !!node.not };
      b.subqueries.push({ node, block: sb, clause, kind: node.type, not: !!node.not });
    }
  }

  function resolveIn(b, expr, clause) {
    if (!expr) return;
    walkExpr(expr, (n) => {
      if (n.type === 'col') {
        const r = resolve(b, n, clause);
        b.uses.push({ col: n, res: r, clause });
        if (r && r.source) r.source.used.add(r.column);
      }
      return true;
    });
  }

  function resolve(b, col, clause) {
    if (resolved.has(col)) return resolved.get(col);
    const r = doResolve(b, col, clause);
    resolved.set(col, r);
    return r;
  }

  function doResolve(b, col, clause) {
    const parts = col.parts;
    const colName = parts[parts.length - 1];
    const lc = colName.toLowerCase();
    if (vars && parts.length === 1 && vars.has(lc)) {
      let knownCol = false;
      for (let blk = b; blk; blk = blk.parent) if ((blk.sources || []).some((s) => s.columns && s.columns.some((c) => c.toLowerCase() === lc))) knownCol = true;
      if (!knownCol) return { variable: true, column: colName, name: colName };
    }
    if (parts.length >= 2) {
      const qual = parts[parts.length - 2].toLowerCase();
      for (let blk = b; blk; blk = blk.parent) {
        const s = (blk.sources || []).find((x) => x.ref.toLowerCase() === qual) || (blk.sources || []).find((x) => !x.alias && x.parts && x.parts[x.parts.length - 1].toLowerCase() === qual);
        if (s) return finish({ source: s, owner: blk, column: colName, correlated: blk !== b });
      }
      if (vars && vars.has(parts[0].toLowerCase())) return { variable: true, column: colName, name: parts.join('.') }; // record.field
      return { unknownQualifier: parts[parts.length - 2], column: colName };
    }
    // output alias (ORDER BY / GROUP BY / HAVING may use SELECT aliases)
    const aliasMatch = (blk) => blk.outputs && blk.outputs.find((o) => o.alias && o.alias.toLowerCase() === lc);
    if ((clause === 'order' || clause === 'group' || clause === 'having' || clause === 'qualify') && aliasMatch(b)) {
      const own = (b.sources || []).filter((s) => s.columns && s.columns.some((c) => c.toLowerCase() === lc));
      if (!own.length || clause === 'order') return { outputAlias: aliasMatch(b).alias, output: aliasMatch(b), column: colName };
    }
    for (let blk = b; blk; blk = blk.parent) {
      const srcs = blk.sources || [];
      const known = srcs.filter((s) => s.columns && s.columns.some((c) => c.toLowerCase() === lc));
      if (known.length === 1) return finish({ source: known[0], owner: blk, column: known[0].columns.find((c) => c.toLowerCase() === lc), correlated: blk !== b });
      if (known.length > 1) return { ambiguous: true, candidates: known, column: colName, owner: blk };
      if (blk === b) {
        const unknown = srcs.filter((s) => !s.columns);
        if (srcs.length === 1 && !unknown.length && !b.parent) return finish({ source: srcs[0], owner: blk, column: colName, missing: true });
        if (unknown.length === 1) return finish({ source: unknown[0], owner: blk, column: colName, guessed: srcs.length > 1 });
        if (unknown.length > 1) return { ambiguous: true, candidates: unknown, column: colName, owner: blk, unknownColumns: true };
      }
    }
    // pseudo-columns
    if (/^(rownum|level|rowid|sysdate|current_date|current_timestamp|oid|ctid|_partitiontime)$/i.test(colName)) return { pseudo: true, column: colName };
    if (b.sources && b.sources.length === 1) return finish({ source: b.sources[0], owner: b, column: colName, missing: !!b.sources[0].columns });
    return { notFound: true, column: colName };
  }

  function finish(r) {
    if (r.source && r.source.columns && !r.missing) {
      const hit = r.source.columns.find((c) => c.toLowerCase() === String(r.column).toLowerCase());
      if (hit) r.column = hit;
      else r.missing = true;
    }
    if (r.source && r.source.kind === 'table' && r.source.table) r.catalogColumn = r.source.table.colMap.get(String(r.column).toLowerCase()) || null;
    return r;
  }

  // ---------- statements ----------
  const st = stmt;
  if (st.type === 'query') {
    m.main = queryBlock(st, 'main', null, null, null);
  } else if (st.type === 'create') {
    m.main = queryBlock(st.query, 'main', st.name.parts.join('.'), null, null);
    m.target = { name: st.name.parts.join('.'), kind: st.objectKind };
  } else if (st.type === 'insert') {
    const ctes = new Map();
    if (st.ctes) for (const c of st.ctes) ctes.set(c.name.toLowerCase(), queryBlock(c.query, 'cte', c.name, null, ctes));
    if (st.query) m.main = queryBlock(st.query, 'main', null, null, ctes);
    const t = catalog ? catalog.lookup(st.table.parts) : null;
    m.target = { name: st.table.parts.join('.'), kind: 'table', table: t, entity: entityNoun(st.table.parts[st.table.parts.length - 1]), columns: st.columns };
  } else if (st.type === 'update' || st.type === 'delete' || st.type === 'merge') {
    const ctes = new Map();
    if (st.ctes) for (const c of st.ctes) ctes.set(c.name.toLowerCase(), queryBlock(c.query, 'cte', c.name, null, ctes));
    const from = [];
    let targetSrc = st.target;
    if (st.type === 'merge') {
      from.push({ type: 'from', source: st.target, joins: [{ type: 'join', kind: 'INNER', source: st.using, on: st.on }] });
    } else {
      // T-SQL style: UPDATE alias SET ... FROM table alias JOIN ...  (target named by alias)
      const targetName = st.target.name ? st.target.name.parts.join('.').toLowerCase() : '';
      const viaFrom = st.from && st.from.some((f) => f.source && (f.source.alias || '').toLowerCase() === targetName);
      if (!viaFrom) from.push({ type: 'from', source: st.target, joins: st.targetJoins || [] });
      if (st.from) from.push(...st.from);
    }
    const sel = { type: 'select', columns: [], from, where: st.where || null, s: st.s, e: st.e, groupBy: null, having: null, qualify: null, distinct: false };
    const b = selectBlock(sel, 'dml', null, null, ctes, { dml: st.type });
    m.main = b;
    const tName = targetSrc.name ? targetSrc.name.parts.join('.') : '';
    const tSource = b.sources.find((s) => s.ref.toLowerCase() === (targetSrc.alias || tName.split('.').pop()).toLowerCase()) || b.sources.find((s) => (s.alias || '').toLowerCase() === tName.toLowerCase()) || b.sources[0];
    m.target = { name: tSource ? tSource.displayName : tName, kind: 'table', source: tSource, table: tSource && tSource.table, entity: tSource ? tSource.entity : entityNoun(tName) };
    if (st.type === 'update') for (const a of st.set) { resolveIn(b, a.value, 'set'); collectSubqueries(b, a.value, 'set'); }
    if (st.type === 'merge') for (const w of st.whens) { if (w.cond) resolveIn(b, w.cond, 'merge'); for (const a of w.set || []) resolveIn(b, a.value, 'merge'); for (const r of (w.values ? w.values.rows : [])) for (const v of r) resolveIn(b, v, 'merge'); }
  }

  m.resolve = (b, col) => resolve(b, col);
  m.isKey = isKey;
  m.joinInfo = joinInfo;
  m.groupNoun = groupNoun;
  m.blockEntity = blockEntity;
  return m;

  // ---------- semantics helpers ----------
  function blockEntity(b) {
    if (!b || b.pending) return null;
    if (b.setop) return blockEntity(b.branches[0]);
    if (!b.select) return null;
    if (b.select.groupBy && b.select.groupBy.items && b.select.groupBy.items.length) {
      const nouns = [...new Set(b.select.groupBy.items.map((it) => (groupNoun(b, it) || {}).noun).filter(Boolean))];
      if (nouns.length) return nouns.join(' and ');
    }
    if (b.sources.length) return grainEntity(b);
    return null;
  }

  /** What one row stands for after the joins (before grouping): the "many" side wins. */
  function grainEntity(b) {
    let ent = b.sources[0] ? b.sources[0].entity : null;
    for (const s of b.sources.slice(1)) {
      const j = joinInfo(b, s);
      if (j.card === '1:N' || j.card === 'N:N' || j.card === 'cross') ent = s.entity;
    }
    return ent;
  }

  /** Noun for a GROUP BY / PARTITION BY expression: customer_id -> "customer", c.id -> "customer". */
  function groupNoun(b, e) {
    if (!e) return null;
    if (e.type === 'col') {
      const r = resolve(b, e) || {};
      const col = e.parts[e.parts.length - 1];
      const k = normKey(col);
      if (r.source && (k === 'id' || isKey(r.source, [col]))) return { noun: r.source.entity, entity: true };
      if (/(_id|id)$/i.test(col) && k.length > 2) {
        const w = words(col).replace(/\s*\bid$/, '').trim();
        if (w && /^(external|internal|parent|source|target|foreign|legacy|old|new|ref|reference|remote|local|global|unique|alternate|alt|natural|business|tracking|correlation|session|request|transaction id|row)$/.test(w)) return { noun: `${w} ID`, entity: false };
        if (w) return { noun: w, entity: true };
      }
      return { noun: words(col), entity: false };
    }
    if (e.type === 'func') {
      const unit = dateUnitOf(e);
      if (unit) return { noun: unit, entity: false, date: true };
    }
    if (e.type === 'lit' && e.kind === 'number' && b.outputs[e.value - 1]) {
      const o = b.outputs[e.value - 1];
      return o.expr ? groupNoun(b, o.expr) : { noun: o.name, entity: false };
    }
    return null;
  }

  function isKey(s, cols) {
    if (!s || !cols || !cols.length) return false;
    const set = new Set(cols.map((c) => String(c).toLowerCase()));
    if (s.kind === 'table') {
      const t = s.table;
      if (t) {
        if (t.primaryKey.length && t.primaryKey.every((c) => set.has(c.toLowerCase()))) return true;
        if (t.uniques.some((u) => u.length && u.every((c) => set.has(c.toLowerCase())))) return true;
        if (t.columns.some((c) => c.unique && set.has(c.name.toLowerCase()))) return true;
        if (t.primaryKey.length) return false;
      }
      const name = s.parts[s.parts.length - 1];
      const cands = new Set(['id', `${normKey(singular(name))}id`, `${normKey(name)}id`, `${normKey(entityNoun(name))}id`, `${normKey(name)}key`, `${normKey(singular(name))}key`, `${normKey(singular(name))}no`, `${normKey(singular(name))}code`]);
      return [...set].some((c) => cands.has(normKey(c)));
    }
    const inner = s.kind === 'cte' ? s.cteBlock : s.kind === 'derived' ? s.inner : null;
    if (!inner || inner.pending) return false;
    return blockKeyed(inner, set);
  }

  function blockKeyed(inner, set) {
    if (inner.setop) return inner.setop.op !== 'UNION' || inner.setop.all ? false : inner.outputs.every((o) => set.has(o.name.toLowerCase()));
    if (!inner.select) return false;
    const outName = (expr) => { const o = inner.outputs.find((x) => x.expr === expr || (x.expr && expr && x.expr.s === expr.s && x.expr.e === expr.e)); return o ? o.name.toLowerCase() : (expr.type === 'col' ? expr.parts[expr.parts.length - 1].toLowerCase() : null); };
    const g = inner.select.groupBy;
    if (g && g.items && g.items.length && g.kind === 'plain') {
      const names = g.items.map((it) => (it.type === 'lit' && inner.outputs[it.value - 1] ? inner.outputs[it.value - 1].name.toLowerCase() : outName(it)));
      if (names.every((n) => n && set.has(n))) return true;
      return false;
    }
    if (!g && inner.outputs.length && inner.outputs.every((o) => o.expr && isAggregate(o.expr))) return true; // single row
    if (inner.select.distinct && !inner.select.distinctOn && inner.outputs.every((o) => set.has(o.name.toLowerCase()))) return true;
    if (inner.select.distinctOn && inner.select.distinctOn.every((d) => { const n = outName(d); return n && set.has(n); })) return true;
    // pass-through of a single keyed source
    if (inner.sources.length >= 1) {
      const base = inner.sources[0];
      const mapped = [...set].map((name) => {
        const o = inner.outputs.find((x) => x.name.toLowerCase() === name);
        if (!o || !o.expr || o.expr.type !== 'col') return null;
        const r = resolve(inner, o.expr);
        return r && r.source === base ? r.column : null;
      });
      if (mapped.every(Boolean) && isKey(base, mapped)) {
        const multiplies = inner.sources.slice(1).some((s) => { const j = joinInfo(inner, s); return j.card !== 'N:1' && j.card !== '1:1'; });
        return !multiplies;
      }
    }
    return false;
  }

  /** Join facts for source s within block b. */
  function joinInfo(b, s) {
    if (s.joinCache) return s.joinCache;
    const j = s.join;
    const out = { kind: j ? (j.oracle || j.kind) : null, pairs: [], extra: [], other: null, card: null, implicit: !!(j && j.implicit) };
    if (!j) { out.card = 'base'; s.joinCache = out; return out; }
    if (j.kind === 'CROSS' && !j.on) { out.card = 'cross'; s.joinCache = out; return out; }
    if (/APPLY/.test(j.kind) || (s.node.lateral && !j.on)) { out.card = 'apply'; s.joinCache = out; return out; }
    if (j.using || j.natural) {
      const cols = j.using || (s.columns || []).filter((c) => b.sources.slice(0, s.index).some((o) => o.columns && o.columns.some((x) => x.toLowerCase() === c.toLowerCase())));
      const other = b.sources.slice(0, s.index).reverse().find((o) => !o.columns || cols.every((c) => o.columns.some((x) => x.toLowerCase() === c.toLowerCase()))) || b.sources[0];
      out.other = other;
      out.pairs = cols.map((c) => ({ left: { source: other, column: c }, right: { source: s, column: c } }));
    }
    for (const c of conjuncts(j.on)) {
      if (c.type === 'bin' && c.op === '=' && c.left.type === 'col' && c.right.type === 'col') {
        const a = resolve(b, c.left) || {};
        const r = resolve(b, c.right) || {};
        let mine = null;
        let theirs = null;
        if (a.source === s && r.source && r.source !== s) { mine = a; theirs = r; }
        else if (r.source === s && a.source && a.source !== s) { mine = r; theirs = a; }
        if (mine && (theirs.source.block === b ? theirs.source.index < s.index || j.implicit : true)) {
          out.pairs.push({ left: { source: theirs.source, column: theirs.column }, right: { source: s, column: mine.column }, node: c });
          continue;
        }
      }
      out.extra.push(c);
    }
    if (out.pairs.length) {
      const others = [...new Set(out.pairs.map((p) => p.left.source))];
      out.other = others[0];
      const rightKey = isKey(s, out.pairs.filter((p) => p.left.source === out.other).map((p) => p.right.column)) || rankKeyed(b, s, out);
      const leftKey = isKey(out.other, out.pairs.filter((p) => p.left.source === out.other).map((p) => p.left.column));
      out.card = rightKey && leftKey ? '1:1' : rightKey ? 'N:1' : leftKey ? '1:N' : 'N:N';
      // a declared/inferred FK from the schema settles unknown cases
      if (out.card === 'N:N' && catalog) {
        const fk = fkBetween(out.other, s, out.pairs);
        if (fk) out.card = fk;
      }
    } else {
      out.card = 'other';
    }
    s.joinCache = out;
    return out;
  }

  /** LEFT JOIN latest l ON l.customer_id = c.id AND l.rn = 1, where rn = ROW_NUMBER() OVER (PARTITION BY customer_id ...) */
  function rankKeyed(b, s, out) {
    const inner = s.kind === 'cte' ? s.cteBlock : s.kind === 'derived' ? s.inner : null;
    if (!inner || !inner.outputs) return false;
    const joinCols = new Set(out.pairs.map((p) => String(p.right.column).toLowerCase()));
    return out.extra.some((c) => {
      if (c.type !== 'bin' || c.op !== '=') return false;
      const [ref, lit] = c.left.type === 'col' ? [c.left, c.right] : [c.right, c.left];
      if (ref.type !== 'col' || !lit || lit.type !== 'lit' || Number(lit.value) !== 1) return false;
      const r = resolve(b, ref) || {};
      if (r.source !== s) return false;
      const o = inner.outputs.find((x) => x.name.toLowerCase() === String(r.column).toLowerCase());
      const w = o && o.expr;
      if (!w || w.type !== 'func' || w.name !== 'ROW_NUMBER' || !w.over) return false;
      const parts = w.over.partitionBy.map((p) => {
        const po = inner.outputs.find((x) => x.expr && p.type === 'col' && x.expr.type === 'col' && x.expr.parts.join('.').toLowerCase() === p.parts.join('.').toLowerCase());
        return po ? po.name.toLowerCase() : (p.type === 'col' ? p.parts[p.parts.length - 1].toLowerCase() : null);
      });
      return parts.length > 0 && parts.every((x) => x && joinCols.has(x));
    });
  }

  function fkBetween(left, right, pairs) {
    const lt = left.table;
    const rt = right.table;
    const has = (t, target, cols) => t && t.foreignKeys.some((f) => f.refTable === target && f.columns.length === cols.length && f.columns.every((c) => cols.some((x) => x.toLowerCase() === c.toLowerCase())));
    if (has(lt, rt, pairs.map((p) => p.left.column))) return 'N:1';
    if (has(rt, lt, pairs.map((p) => p.right.column))) return '1:N';
    return null;
  }
}

function refersTo(q, name) {
  let found = false;
  const lc = name.toLowerCase();
  const visit = (n) => {
    if (!n || typeof n !== 'object' || found) return;
    if (n.type === 'table' && n.name && n.name.parts.length === 1 && n.name.parts[0].toLowerCase() === lc) { found = true; return; }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === 'object' && v !== n) visit(v);
    }
  };
  visit(q);
  return found;
}

export function defaultName(e, i) {
  if (!e) return `column${i + 1}`;
  if (e.type === 'col') return e.parts[e.parts.length - 1];
  if (e.type === 'cast' && e.expr.type === 'col') return e.expr.parts[e.expr.parts.length - 1];
  if (e.type === 'func') return e.name.toLowerCase();
  return `column${i + 1}`;
}

/** 'month' for DATE_TRUNC('month', x), TRUNC(x, 'MM'), YEAR(x), EXTRACT(YEAR FROM x), TO_CHAR(x,'YYYY-MM'), x::date ... */
export function dateUnitOf(e) {
  if (!e) return null;
  if (e.type === 'cast' && /^date\s*$/i.test(String(e.to).trim())) return 'day';
  if (e.type !== 'func') return null;
  const name = e.name;
  const a = e.args;
  const unitWord = (v) => {
    const u = String(v || '').toLowerCase().replace(/['"]/g, '');
    if (/^(yy|yyyy|year|years|y|iyyy|%y)$/.test(u)) return 'year';
    if (/^(q|quarter|qq)$/.test(u)) return 'quarter';
    if (/^(mm|mon|month|months|m|mi?)$/.test(u) && u !== 'mi') return 'month';
    if (/^(ww|iw|w|week|weeks|wk|isoweek)$/.test(u)) return 'week';
    if (/^(dd|ddd|d|day|days|j|dy)$/.test(u)) return 'day';
    if (/^(hh|hh24|hour|hours)$/.test(u)) return 'hour';
    if (/^(mi|minute|minutes)$/.test(u)) return 'minute';
    if (/^(y\w*-mm|yyyy-mm|%y-%m|yyyymm|yyyy-mm)$/.test(u) || /^(yyyy-?mm|%y-?%m|yyyy\/mm)$/.test(u)) return 'month';
    if (/^(yyyy-mm-dd|%y-%m-%d|yyyymmdd)$/.test(u)) return 'day';
    return null;
  };
  const litVal = (x) => (x && x.type === 'lit' ? String(x.value) : x && x.type === 'col' ? x.parts[x.parts.length - 1] : null);
  switch (name) {
    case 'DATE_TRUNC': case 'DATETRUNC': case 'TIMESTAMP_TRUNC': case 'DATETIME_TRUNC': return unitWord(litVal(a[0])) || unitWord(litVal(a[1]));
    case 'TRUNC': return a.length === 1 ? (looksDate(a[0]) ? 'day' : null) : unitWord(litVal(a[1]));
    case 'DATE': return 'day';
    case 'YEAR': return 'year';
    case 'MONTH': return 'month';
    case 'DAY': case 'DAYOFMONTH': return 'day';
    case 'QUARTER': return 'quarter';
    case 'WEEK': case 'WEEKOFYEAR': case 'ISOWEEK': return 'week';
    case 'HOUR': return 'hour';
    case 'EXTRACT': case 'DATE_PART': case 'DATEPART': return unitWord(litVal(a[0]));
    case 'TO_CHAR': case 'DATE_FORMAT': case 'FORMAT': case 'STRFTIME': case 'FORMAT_DATE': case 'FORMAT_TIMESTAMP': {
      const fmt = name === 'STRFTIME' || name === 'FORMAT_DATE' || name === 'FORMAT_TIMESTAMP' ? litVal(a[0]) : litVal(a[1]);
      return fmt ? unitWord(fmt.replace(/[^a-z%/-]/gi, '')) || (/mm/i.test(fmt) && /y/i.test(fmt) && !/dd/i.test(fmt) ? 'month' : /dd/i.test(fmt) ? 'day' : /^y+$/i.test(fmt) ? 'year' : null) : null;
    }
    case 'CONVERT': case 'TRY_CONVERT': return a[0] && a[0].type === 'typename' && /^date$/i.test(a[0].name) ? 'day' : null;
    default: return null;
  }
}

export function looksDate(e) {
  if (!e) return false;
  if (e.type === 'col') return /(^|_)(at|on|date|dt|dttm|dtm|time|tmsp|ts|timestamp|day)$|date|time$|At$|On$|Date|Time/i.test(e.parts[e.parts.length - 1]);
  if (e.type === 'func') return /^(NOW|SYSDATE|SYSTIMESTAMP|CURRENT_DATE|CURRENT_TIMESTAMP|GETDATE|GETUTCDATE|SYSDATETIME|LOCALTIMESTAMP|DATE_TRUNC|TRUNC|DATEADD|DATE_ADD|DATE_SUB|ADD_MONTHS|TO_DATE|TO_TIMESTAMP|DATE|CURDATE|LAST_DAY)$/.test(e.name);
  if (e.type === 'lit') return e.kind === 'date' || e.kind === 'timestamp' || (e.kind === 'string' && /^\d{4}-\d{2}-\d{2}/.test(e.value));
  if (e.type === 'bin' && (e.op === '+' || e.op === '-')) return looksDate(e.left);
  if (e.type === 'cast') return /date|time/i.test(e.to);
  return false;
}
