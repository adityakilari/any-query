// Any Query browser app. Two screens: home (paste SQL, optional schema, samples) and the result
// (Explain / Flow / Columns / Review / SQL / Export). Nothing is uploaded and nothing is stored:
// the query lives in memory, and only in the URL if you copy a share link yourself.
import { analyzeSql, VERSION, DIALECTS } from '../core/index.js';
import { loadSchema } from '../core/schema.js';
import { toMarkdown, toJson } from '../core/render.js';
import { tokenize, KEYWORDS, SOFT_KEYWORDS } from '../core/tokenize.js';
import { SAMPLES } from '../generated/samples.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Explanation text: escape, then `x` -> <code>x</code>. */
const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
/** Update the address bar if the page is allowed to (sandboxed previews, e.g. about:srcdoc frames, are not). */
function setUrl(url) {
  try { history.replaceState(null, '', url); } catch { /* address bar is read-only here; the app works without it */ }
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

const state = { sql: '', schema: null, schemaName: null, schemaText: null, result: null, stmt: 0, view: 'explain', sevFilter: 'all', exportFmt: 'md', flowSel: null, sqlMode: 'formatted' };

// ---------------- home ----------------
function initHome() {
  $('#version').textContent = `v${VERSION}`;
  $('#dialect').innerHTML = Object.entries(DIALECTS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  $('#samples').innerHTML = SAMPLES.map((s, i) => `<button class="sample" type="button" data-sample="${i}"><b>${esc(s.title)}</b><span>${s.schemaName ? 'with schema' : ''}</span><small>${esc(s.meta)}</small></button>`).join('');
  $('#explain').addEventListener('click', () => run());
  $('#sql').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); const t = e.target; const p = t.selectionStart; t.setRangeText('  ', p, t.selectionEnd, 'end'); }
  });
  $('#file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    $('#sql').value = await readFile(f);
    e.target.value = '';
    run();
  });
  $('#schema-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) setSchema(await readFile(f), f.name);
  });
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', async (e) => {
    const files = [...(e.dataTransfer && e.dataTransfer.files || [])];
    if (!files.length) return;
    // a CREATE TABLE file dropped next to a query is treated as the schema
    for (const f of files) {
      const text = await readFile(f);
      if (files.length > 1 && /\bcreate\s+table\b/i.test(text) && !/\bselect\b[\s\S]*\bfrom\b/i.test(text.replace(/create\s+table[\s\S]*?;/gi, ''))) setSchema(text, f.name);
      else if (/\.(json|prisma|csv|tsv)$/i.test(f.name)) setSchema(text, f.name);
      else $('#sql').value = text;
    }
    if ($('#sql').value.trim()) run();
  });
  renderSchemaStatus();
}

function readFile(f) {
  if (f.text) return f.text();
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsText(f); });
}

function setSchema(text, name) {
  try {
    state.schema = loadSchema(text, name);
    state.schemaName = name;
    state.schemaText = text;
    status('');
  } catch (err) {
    state.schema = null; state.schemaName = null; state.schemaText = null;
    status(`Could not read the schema ${name}: ${err.message}`, true);
  }
  renderSchemaStatus();
  if (state.result) rerun();
}

function renderSchemaStatus() {
  const el = $('#schema-status');
  if (!state.schema) { el.innerHTML = '<span class="tag">No schema loaded</span>'; return; }
  el.innerHTML = `<span class="chip on">✓ ${esc(state.schemaName)} · ${plural(state.schema.tables.length, 'table')}</span> <button class="linkbtn" type="button" id="schema-clear">Remove</button>`;
  $('#schema-clear').addEventListener('click', () => { state.schema = null; state.schemaName = null; state.schemaText = null; renderSchemaStatus(); if (state.result) rerun(); });
}

function status(msg, err = false) {
  const el = $('#status');
  el.textContent = msg;
  el.classList.toggle('err', err);
}

function run() {
  const sql = $('#sql').value;
  if (!sql.trim()) { status('Paste a SQL query first (or open a sample).', true); $('#sql').focus(); return; }
  state.sql = sql;
  state.stmt = 0;
  analyze();
  if (!state.result) return;
  if (!state.result.statements.length) { status('No SQL statement was found in the text.', true); return; }
  status('');
  showResult();
}

function rerun() { analyze(); if (state.result) renderResult(); }

function analyze() {
  try {
    state.result = analyzeSql(state.sql, { dialect: $('#dialect').value, schema: state.schema });
  } catch (err) {
    console.error(err);
    state.result = null;
    status(`Something went wrong while reading the query: ${err.message}. Please report it on GitHub with the query (or a simplified version).`, true);
  }
}

function showResult() {
  $('#home').hidden = true;
  $('#result').hidden = false;
  const want = (location.hash || '').replace('#', '');
  state.view = ['explain', 'flow', 'columns', 'review', 'sql', 'export'].includes(want) ? want : 'explain';
  renderResult();
  window.scrollTo(0, 0);
  $('#r-title').focus({ preventScroll: true });
  if (location.hash !== `#${state.view}`) setUrl(`#${state.view}`);
}

function showHome() {
  $('#result').hidden = true;
  $('#home').hidden = false;
  setUrl(location.pathname + location.search);
  window.scrollTo(0, 0);
  $('#sql').focus();
}

// ---------------- result ----------------
function stmt() { return state.result.statements[state.stmt] || state.result.statements[0]; }

function renderResult() {
  const r = state.result;
  const st = stmt();
  $('#r-eyebrow').innerHTML = `Any Query · ${esc(r.dialect.label)}${r.dialect.confidence !== 'chosen' && r.dialect.confidence ? ` <span class="tag">(${r.dialect.confidence === 'high' ? 'detected' : 'best guess'})</span>` : ''}${r.schema ? ` · schema: ${esc(r.schema.fileName)}` : ' · no schema'}`;
  $('#r-title').textContent = r.statements.length > 1 ? `${r.statements.length} statements` : st.title === 'Query' ? 'Query explanation' : st.title;
  const all = r.statements.flatMap((s) => s.findings);
  const high = all.filter((f) => f.severity === 'high').length;
  $('#r-stats').innerHTML = [
    [r.stats.tables, 'tables'], [r.stats.steps, r.statements.some((x) => x.type === 'routine') ? 'SQL statements' : 'steps'], [r.stats.lines, 'lines'],
  ].map(([n, l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join('') + `<div class="stat ${high ? 'bad' : ''}"><b>${all.length}</b><span>${high ? `findings · ${high} high` : 'findings'}</span></div>`;
  const nav = $('#stmts');
  nav.hidden = r.statements.length < 2;
  nav.innerHTML = r.statements.map((s, i) => `<button type="button" data-stmt="${i}" aria-pressed="${i === state.stmt}"><small>${i + 1}</small> ${esc(stmtLabel(s))}${s.findings.length ? ` <span class="dot" data-sev="${s.findings[0].severity}"></span>` : ''}</button>`).join('');
  $('#r-lede').innerHTML = st.summary.length ? `<p>${md(st.summary[0])}</p>` : '';
  $('#review-count').textContent = st.findings.length ? ` ${st.findings.length}` : '';
  for (const b of $$('.tabs [data-view]')) b.setAttribute('aria-selected', String(b.dataset.view === state.view));
  for (const v of ['explain', 'flow', 'columns', 'review', 'sql', 'export']) $(`#view-${v}`).hidden = v !== state.view;
  ({ explain: renderExplain, flow: renderFlow, columns: renderColumns, review: renderReview, sql: renderSql, export: renderExport })[state.view]();
}

function stmtLabel(s) {
  if (s.title !== 'Query' || !s.grain) return s.title;
  const t = s.grain.replace(/\s*\(.*\)$/, '');
  return (t.charAt(0).toUpperCase() + t.slice(1)).slice(0, 48);
}

function setView(v) {
  state.view = v;
  setUrl(`#${v}`);
  renderResult();
}

function sqlOf(s, e) { return state.result.sql.slice(s, e); }

function renderExplain() {
  const r = state.result;
  const st = stmt();
  const el = $('#view-explain');
  if (st.skipped || st.failed) {
    el.innerHTML = `<div class="box"><p>${md(st.summary[0])}</p>${st.unreadable || r.notes.length ? `<ul class="tag">${r.notes.map((n) => `<li>${md(n.message)}</li>`).join('')}</ul>` : ''}${st.type === 'ddl' ? '<p><a class="btn ghost small" href="https://adityakilari.github.io/any-schema/" target="_blank" rel="noopener">Open Any Schema</a></p>' : ''}<pre class="code">${highlight(st.sql)}</pre></div>`;
    return;
  }
  if (st.type === 'routine') { el.innerHTML = routineView(st, r); return; }
  const findingsByStep = new Map();
  for (const f of st.findings) if (f.step) findingsByStep.set(f.step, (findingsByStep.get(f.step) || 0) + 1);
  el.innerHTML = `
  <div class="explain">
    <div class="ex-main">
      <section class="box summary">
        <h2>In short</h2>
        <ul class="sum">${st.summary.map((s) => `<li>${md(s)}</li>`).join('')}</ul>
        ${st.findings.length ? `<p class="sum-review" data-sev="${st.findings[0].severity}"><span class="sev">${esc(st.findings[0].severity)}</span> ${st.findings.length === 1 ? '1 thing to check' : `${st.findings.length} things to check`} in the review, starting with: ${md(st.findings[0].title)}. <button class="linkbtn" type="button" data-view="review">Open the review →</button></p>` : ''}
      </section>
      <h2 class="h-steps">Step by step <span class="tag">${st.steps.length > 1 ? 'in the order the database works through it' : ''}</span></h2>
      <ol class="steps-list">
        ${st.steps.map((s) => stepCard(s, findingsByStep.get(`step ${s.n}`))).join('')}
      </ol>
    </div>
    <aside class="ex-side">
      <section class="box">
        <h3>Tables used</h3>
        <ul class="tables">${st.tables.map(tableItem).join('') || '<li class="tag">No tables</li>'}</ul>
        ${!r.schema ? '<p class="tag">Add a schema on the first screen to check these names and see what each table holds.</p>' : ''}
      </section>
      ${r.notes.length ? `<section class="box notes"><h3>Notes</h3><ul>${r.notes.map((n) => `<li>${md(n.message)}</li>`).join('')}</ul></section>` : ''}
    </aside>
  </div>`;
}

function stepCard(s, nFindings) {
  return `<li class="step" id="step-${s.n}">
    <div class="step-h"><span class="num">${s.n}</span><h3>${md(s.title)}</h3>${s.kind === 'cte' ? '<span class="chip">CTE</span>' : s.kind === 'derived' ? '<span class="chip">subquery</span>' : s.kind === 'subquery' ? '<span class="chip">subquery</span>' : ''}${nFindings ? `<button class="chip warn" type="button" data-view="review">${plural(nFindings, 'finding')}</button>` : ''}</div>
    <ul class="lines">${s.lines.map((l) => `<li class="l-${l.k}">${md(l.text)}${l.items ? `<ul>${l.items.map((it) => `<li>${md(it.text)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ul>
    <details class="stepsql"><summary>Show the SQL for this step</summary><pre class="code">${highlight(dedent(sqlOf(s.s, s.e)))}</pre></details>
  </li>`;
}

// ---------------- functions & procedures ----------------
function routineView(st, r) {
  const R = st.routine;
  const lineFindings = new Map();
  for (const f of st.findings) { const k = f.line; if (!lineFindings.has(k) || sevRank(f.severity) < sevRank(lineFindings.get(k).severity)) lineFindings.set(k, f); }
  const params = R.params.length ? `<table class="params"><thead><tr><th>Parameter</th><th>Direction</th><th>Type</th><th>Default</th></tr></thead><tbody>${R.params.map((p) => `<tr><td><code>${esc(p.name)}</code></td><td>${esc(p.mode || 'IN')}</td><td><code>${esc(p.type)}</code></td><td>${p.default ? `<code>${esc(p.default)}</code>` : '<span class="tag">—</span>'}</td></tr>`).join('')}</tbody></table>` : '<p class="tag">No parameters.</p>';
  return `
  <div class="explain">
    <div class="ex-main">
      <section class="box summary">
        <h2>In short</h2>
        <ul class="sum">${st.summary.map((x) => `<li>${md(x)}</li>`).join('')}</ul>
        ${st.findings.length ? `<p class="sum-review" data-sev="${st.findings[0].severity}"><span class="sev">${esc(st.findings[0].severity)}</span> ${st.findings.length === 1 ? '1 thing to check' : `${st.findings.length} things to check`} in the review, starting with: ${md(st.findings[0].title)}. <button class="linkbtn" type="button" data-view="review">Open the review →</button></p>` : ''}
      </section>
      <section class="box">
        <h3>${esc(R.kind[0].toUpperCase() + R.kind.slice(1))}${R.name ? ` <code>${esc(R.name)}</code>` : ''}</h3>
        <p class="tag">${esc([R.language, R.returns ? `returns ${R.returns}` : null, `${R.sqlCount} SQL statement${R.sqlCount === 1 ? '' : 's'}`, R.variables ? `${R.variables} variables` : null].filter(Boolean).join(' · '))}</p>
        ${params}
      </section>
      <h2 class="h-steps">What it does <span class="tag">in the order it runs · click a line number to see the code</span></h2>
      <ol class="outline">${st.outline.map((o) => outlineItem(o, lineFindings)).join('')}</ol>
    </div>
    <aside class="ex-side">
      <section class="box">
        <h3>Tables used</h3>
        <ul class="tables">${st.tables.map(tableItem).join('') || '<li class="tag">No tables</li>'}</ul>
        ${!r.schema ? '<p class="tag">Add a schema on the first screen to check these names and see what each table holds.</p>' : ''}
      </section>
    </aside>
  </div>`;
}

function outlineItem(o, lineFindings) {
  const ln = (line) => (line ? `<button class="ln-btn" type="button" data-goto-line="${line}" title="Show line ${line}">${line}</button>` : '<span class="ln-btn blank"></span>');
  const mark = (line) => { const f = lineFindings.get(line); return f ? ` <button class="chip warn sev-${f.severity}" type="button" data-view="review" title="${esc(f.title.replace(/`/g, ''))}">${esc(f.severity)}</button>` : ''; };
  if (o.branches) {
    return `<li class="o-if">${o.branches.map((b) => `<div class="o-branch"><div class="o-row">${ln(b.line || o.line)}<span class="o-text"><b>${md(b.text)}</b>${mark(b.line || o.line)}</span></div><ol class="outline nested">${b.children.map((c) => outlineItem(c, lineFindings)).join('') || '<li class="o-row tag">(nothing)</li>'}</ol></div>`).join('')}</li>`;
  }
  const items = o.items && o.items.length ? `<details class="o-items" ${o.items.length <= 4 ? 'open' : ''}><summary>${o.items.length} ${o.k === 'decls' ? 'declared' : 'assignments'}</summary><ul>${o.items.map((it) => `<li><span class="ln-mini">${it.line || ''}</span> ${md(it.text)}</li>`).join('')}</ul></details>` : '';
  const sqlDetails = o.sql && !o.sql.skipped ? `<details class="stepsql"><summary>Details${o.sql.findings && o.sql.findings.length ? ` · ${o.sql.findings.length} finding${o.sql.findings.length === 1 ? '' : 's'}` : ''}</summary>
      ${o.sql.steps && o.sql.steps.length ? o.sql.steps.map((s) => `<div class="mini-step"><b>${md(s.title)}</b><ul class="lines">${s.lines.map((l) => `<li>${md(l.text)}${l.items ? `<ul>${l.items.map((it) => `<li>${md(it.text)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ul></div>`).join('') : ''}
      <pre class="code">${highlight(dedent(o.sql.sql))}</pre></details>` : '';
  const kids = o.children ? `<ol class="outline nested">${o.children.map((c) => outlineItem(c, lineFindings)).join('') || '<li class="o-row tag">(nothing)</li>'}</ol>` : '';
  return `<li class="o-${o.k}${o.loop ? ' o-loop' : ''}"><div class="o-row">${ln(o.line)}<span class="o-text">${o.loop || o.k === 'handler' ? `<b>${md(o.text)}</b>` : md(o.text)}${mark(o.line)}${items}${sqlDetails}</span></div>${kids}</li>`;
}

function tableItem(t) {
  if (t.writes) {
    const how = [t.writes.length ? `writes: ${t.writes.join(', ')}` : null, t.reads ? 'reads' : null].filter(Boolean).join(' · ');
    return `<li>
      <div><code class="tname">${esc(t.name)}</code>${t.known === false ? ' <span class="b bad">not in schema</span>' : ''} <span class="tag">· ${esc(how)}</span></div>
      ${t.purpose ? `<p>${md(firstSentence(t.purpose))}</p>` : ''}
      <p class="tag">lines ${t.lines.map((l) => `<button class="linkbtn" type="button" data-goto-line="${l}">${l}</button>`).join(', ')}</p>
      <p class="cols">${t.allColumns ? '<span class="tag">all columns (*)</span> ' : ''}${t.columns.map((c) => `<code>${esc(c)}</code>`).join(' ')}</p>
    </li>`;
  }
  const roles = t.roles.filter((x) => x !== 'from').map((x) => x === 'target' ? 'written to' : `${x.toLowerCase()} join`.replace('inner join', 'join'));
  return `<li>
    <div><code class="tname">${esc(t.name)}</code>${t.aliases.length ? ` <span class="tag">as ${t.aliases.map(esc).join(', ')}</span>` : ''}${t.known === false ? ' <span class="b bad">not in schema</span>' : ''}${roles.length ? ` <span class="tag">· ${esc([...new Set(roles)].join(', '))}</span>` : ''}</div>
    ${t.purpose ? `<p>${md(firstSentence(t.purpose))}</p>` : ''}
    <p class="cols">${t.allColumns ? '<span class="tag">all columns (*)</span> ' : ''}${t.columns.map((c) => `<code>${esc(c)}</code>`).join(' ')}</p>
  </li>`;
}

function firstSentence(s) { const m = /^(.*?\.)(\s|$)/.exec(String(s)); return m ? m[1] : String(s); }
function dedent(s) {
  const lines = String(s).split('\n');
  const first = lines[0];
  const rest = lines.slice(1).filter((l) => l.trim());
  const ind = rest.length ? Math.min(...rest.map((l) => /^ */.exec(l)[0].length)) : 0;
  return [first, ...lines.slice(1).map((l) => l.slice(Math.min(ind, /^ */.exec(l)[0].length)))].join('\n');
}

// ---------------- flow ----------------
function renderFlow() {
  const st = stmt();
  const el = $('#view-flow');
  if (!st.flow || !st.flow.nodes.length) { el.innerHTML = '<div class="box"><p>No data flow to draw for this statement.</p></div>'; return; }
  const { svg } = layoutFlow(st.flow);
  el.innerHTML = `
  <div class="stage">
    <div class="panel">
      <div class="panel-h"><h2>How the data flows</h2>
        <div class="legend"><span><i class="lg-t"></i>table</span><span><i class="lg-c"></i>CTE / subquery (step)</span><span><i class="lg-m"></i>result</span><span><i class="x"></i>filter subquery</span></div>
      </div>
      <div class="diagram" id="flow-diagram">${svg}</div>
      <p class="tag pad">Read left to right: tables feed the steps, steps feed the result. Click a box for details.</p>
    </div>
    <aside class="panel card" id="flow-card">${flowCard(st, state.flowSel)}</aside>
  </div>`;
}

function layoutFlow(flow) {
  const nodes = flow.nodes.map((n) => ({ ...n }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map(nodes.map((n) => [n.id, []]));
  for (const e of flow.edges) if (incoming.has(e.to) && byId.has(e.from)) incoming.get(e.to).push(e.from);
  const layer = new Map();
  const depth = (id, seen = new Set()) => {
    if (layer.has(id)) return layer.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    const ins = incoming.get(id) || [];
    const d = ins.length ? Math.max(...ins.map((x) => depth(x, seen) + 1)) : 0;
    layer.set(id, d);
    return d;
  };
  nodes.forEach((n) => depth(n.id));
  // pull each source table right, next to the first step that reads it, so lines don't cross boxes
  const outgoing = new Map(nodes.map((n) => [n.id, []]));
  for (const e of flow.edges) if (outgoing.has(e.from) && byId.has(e.to)) outgoing.get(e.from).push(e.to);
  for (const n of nodes) {
    if ((incoming.get(n.id) || []).length) continue;
    const outs = outgoing.get(n.id) || [];
    if (outs.length) layer.set(n.id, Math.max(0, Math.min(...outs.map((x) => layer.get(x))) - 1));
  }
  const W = 210;
  const GAP = 90;
  const cols = [];
  for (const n of nodes) {
    n.layer = layer.get(n.id);
    n.w = W;
    n.h = n.kind === 'table' || n.kind === 'function' || n.kind === 'values' ? 44 : 50 + 16 * Math.max(1, (n.ops || []).length) - (n.ops && n.ops.length ? 0 : 16);
    (cols[n.layer] ||= []).push(n);
  }
  // order each column by the average position of its inputs, to reduce crossings
  let maxH = 0;
  cols.forEach((col, li) => {
    if (li > 0) col.sort((a, b) => avgY(a) - avgY(b));
    let y = 20;
    for (const n of col) { n.x = 20 + li * (W + GAP); n.y = y; y += n.h + 22; }
    maxH = Math.max(maxH, y);
  });
  // centre shorter columns vertically
  cols.forEach((col) => { const h = col.reduce((s, n) => s + n.h + 22, 0); const off = (maxH - 20 - h) / 2; if (off > 0) col.forEach((n) => { n.y += off; }); });
  function avgY(n) { const ins = incoming.get(n.id) || []; const ys = ins.map((id) => byId.get(id)).filter((x) => x && x.y != null).map((x) => x.y + x.h / 2); return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0; }
  const width = 40 + cols.length * (W + GAP) - GAP;
  const height = maxH + 10;
  const edges = flow.edges.map((e) => {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) return '';
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + Math.min(b.h / 2, 26);
    const mx = (x1 + x2) / 2;
    const label = e.label ? `<text class="elabel" x="${mx}" y="${(y1 + y2) / 2 - 5}" text-anchor="middle">${esc(e.label)}</text>` : '';
    return `<g class="fedge ${e.style === 'dashed' ? 'dashed' : ''}" data-from="${e.from}" data-to="${e.to}"><path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 6},${y2}" marker-end="url(#arrow)"/>${label}</g>`;
  }).join('');
  const boxes = nodes.map((n) => {
    const kind = n.kind === 'main' ? 'main' : n.kind === 'target' ? 'target' : ['table', 'function', 'values'].includes(n.kind) ? 'table' : 'block';
    const ops = (n.ops || []).map((o, i) => `<text class="op" x="${n.x + 12}" y="${n.y + 46 + i * 16}">${esc(o)}</text>`).join('');
    const label = n.label.length > 26 ? n.label.slice(0, 25) + '…' : n.label;
    const sub = kind === 'table' ? `<text class="sub" x="${n.x + 12}" y="${n.y + 34}">${esc(n.known === false ? 'not in schema' : n.sub || '')}</text>` : n.sub ? `<text class="sub" x="${n.x + n.w - 10}" y="${n.y + 18}" text-anchor="end">${esc(n.sub)}</text>` : '';
    const badge = n.step ? `<text class="badge" x="${n.x + n.w - 10}" y="${n.y + 18}" text-anchor="end">step ${n.step}</text>` : '';
    return `<g class="fnode k-${kind} ${n.known === false ? 'unknown' : ''} ${state.flowSel === n.id ? 'sel' : ''}" data-node="${n.id}" tabindex="0" role="button" aria-label="${esc(n.label)}">
      <rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${kind === 'table' ? 4 : 8}"/>
      <text class="name" x="${n.x + 12}" y="${n.y + (kind === 'table' ? 19 : 22)}">${esc(label)}</text>${sub}${n.sub && n.step ? '' : badge}${ops}
    </g>`;
  }).join('');
  const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Data flow diagram">
    <defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrowhead"/></marker></defs>
    ${edges}${boxes}</svg>`;
  return { svg };
}

function flowCard(st, id) {
  const node = id && st.flow.nodes.find((n) => n.id === id);
  if (!node) return '<div class="empty">Click a table or step in the diagram to see what it contributes.</div>';
  if (node.step) {
    const s = st.steps.find((x) => x.n === node.step);
    if (s) return `<div class="panel-h"><h3>Step ${s.n}: ${md(s.title)}</h3></div><div class="pad"><ul class="lines">${s.lines.map((l) => `<li>${md(l.text)}${l.items ? `<ul>${l.items.map((it) => `<li>${md(it.text)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ul></div>`;
  }
  if (node.kind === 'target') return `<div class="panel-h"><h3><code>${esc(node.label)}</code></h3></div><div class="pad"><p>${esc(node.sub)}: this statement writes to this table.</p></div>`;
  const t = st.tables.find((x) => x.name === node.label);
  if (t) return `<div class="panel-h"><h3><code>${esc(t.name)}</code></h3></div><div class="pad">${t.purpose ? `<p>${md(t.purpose)}</p>` : ''}<p class="tag">Columns used</p><p class="cols">${t.allColumns ? 'all columns (*) ' : ''}${t.columns.map((c) => `<code>${esc(c)}</code>`).join(' ') || '—'}</p>${t.known === false ? '<p class="status err">Not found in the loaded schema.</p>' : ''}</div>`;
  return `<div class="panel-h"><h3>${esc(node.label)}</h3></div>`;
}

// ---------------- columns ----------------
function renderColumns() {
  const st = stmt();
  const el = $('#view-columns');
  if (!st.outputs || !st.outputs.length) {
    el.innerHTML = `<div class="box"><p>${st.type === 'routine' ? `This ${esc(st.routine.kind)} does not end with a query that returns rows (RETURN QUERY / a final SELECT). ${st.routine.returns ? `It returns ${esc(st.routine.returns)}.` : ''} See the Explain tab for what it does.` : st.type === 'update' || st.type === 'delete' || st.type === 'merge' ? 'This statement changes rows instead of returning columns. See the Explain tab for what it changes.' : 'This statement does not return columns.'}</p></div>`;
    return;
  }
  const kinds = { column: 'from a table', calculated: 'calculated', aggregate: 'aggregate', window: 'window', constant: 'fixed value', subquery: 'subquery', all: 'all columns', unknown: '?' };
  el.innerHTML = `
  <div class="page">
    <div class="intro"><h2>Columns returned</h2><p>What each column in the result means, and which table columns it is built from. ${state.result.schema ? 'Descriptions in grey come from the loaded schema.' : 'Load a schema to also see the documented meaning of each source column.'}</p></div>
    <div class="tw"><table class="doc">
      <thead><tr><th>#</th><th>Column</th><th>Meaning</th><th>Kind</th><th>Comes from</th></tr></thead>
      <tbody>${st.outputs.map((o, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td><code>${esc(o.name)}</code></td>
        <td>${md(o.text)}${o.detail ? `<div class="det">${md(o.detail)}</div>` : ''}${o.branches && o.branches.length ? `<div class="det">In the other parts: ${o.branches.map(md).join('; ')}</div>` : ''}<details class="colsql"><summary>SQL</summary><pre class="code">${highlight(o.s != null ? sqlOf(o.s, o.e) : '')}</pre></details></td>
        <td><span class="kind k-${o.kind}">${esc(kinds[o.kind] || o.kind)}</span></td>
        <td class="origins">${o.origins && o.origins.length ? o.origins.map((x) => `<code>${esc(x)}</code>`).join(' ') : '<span class="tag">—</span>'}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  </div>`;
}

// ---------------- review ----------------
function renderReview() {
  const st = stmt();
  const el = $('#view-review');
  const fs = st.findings;
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of fs) counts[f.severity]++;
  const shown = fs.filter((f) => state.sevFilter === 'all' || f.severity === state.sevFilter);
  el.innerHTML = `
  <div class="page">
    <div class="intro"><h2>Review</h2>
      <p>Checks for mistakes that silently return wrong rows, errors some databases raise, and patterns that stop an index from being used. <b>High</b> means the result is probably wrong or the query fails; <b>medium</b> is worth a look; <b>low</b> is style or speed.${state.result.schema ? '' : ' Load a schema to also check table and column names.'}</p>
    </div>
    ${fs.length ? `<div class="sev-filter">${['all', 'high', 'medium', 'low'].map((s) => `<button class="chipbtn" type="button" data-sev-filter="${s}" aria-pressed="${state.sevFilter === s}">${s === 'all' ? `All ${fs.length}` : `${s[0].toUpperCase() + s.slice(1)} ${counts[s]}`}</button>`).join('')}</div>` : ''}
    <div class="findings">${shown.map(findingCard).join('') || `<div class="box ok"><b>No problems found.</b><p class="tag">Checked: join conditions, LEFT JOINs undone by WHERE, NOT IN with NULLs, = NULL, grouping, row limits without ORDER BY, BETWEEN on timestamps, functions on filtered columns, window functions, unused CTEs, division by zero${state.result.schema ? ', and every table and column name against the schema' : ''}.</p></div>`}</div>
  </div>`;
}

function findingCard(f) {
  return `<article class="finding" data-sev="${f.severity}">
    <div class="body">
      <div class="row"><span class="sev">${esc(f.severity)}</span><span class="tag">line ${f.line}${f.step ? ` · ${esc(f.step)}` : ''}</span><button class="linkbtn" type="button" data-goto-line="${f.line}">show in SQL</button></div>
      <h4>${md(f.title)}</h4>
      <pre class="code snip">${highlight(f.snippet.length > 220 ? f.snippet.slice(0, 217) + '…' : f.snippet)}</pre>
      <p>${md(f.detail)}</p>
      ${f.fix ? `<p class="fix"><b>Fix:</b> ${md(f.fix)}</p>` : ''}
      ${f.fixSql ? `<div class="codebox"><pre class="code">${highlight(f.fixSql)}</pre><button class="btn ghost small" type="button" data-copy-text="${esc(f.fixSql)}">Copy</button></div>` : ''}
    </div>
  </article>`;
}

// ---------------- sql ----------------
function renderSql() {
  const r = state.result;
  const el = $('#view-sql');
  const original = state.sqlMode === 'original';
  const text = original ? r.sql : r.formatted;
  // map finding lines (original) -> formatted lines by matching statement order is unreliable, so
  // markers are shown on the original text and the formatted view links to it.
  const marks = new Map();
  if (original) for (const s of r.statements) for (const f of s.findings) { const k = f.line; if (!marks.has(k) || sevRank(f.severity) < sevRank(marks.get(k).severity)) marks.set(k, f); }
  const lines = highlight(text.replace(/\n$/, '')).split('\n');
  el.innerHTML = `
  <div class="page">
    <div class="row sqlbar">
      <div class="tabs small" role="tablist"><button type="button" data-sql-mode="formatted" aria-selected="${!original}">Formatted</button><button type="button" data-sql-mode="original" aria-selected="${original}">Original${marks.size ? ` · ${plural(marks.size, 'marked line')}` : ''}</button></div>
      <button class="btn ghost small" type="button" data-copy-text="${esc(text)}">Copy</button>
      <button class="btn ghost small" type="button" data-download="${original ? 'query.sql' : 'query.formatted.sql'}">Download .sql</button>
      <span class="tag">${original ? 'Lines with review findings are marked; hover the marker for the finding.' : 'Only spacing and keyword case change. Switch to Original to see review markers.'}</span>
    </div>
    <div class="sqlview"><table class="src"><tbody>${lines.map((l, i) => {
      const f = marks.get(i + 1);
      return `<tr id="L${i + 1}" class="${f ? `marked` : ''}" ${f ? `data-sev="${f.severity}"` : ''}><td class="ln">${i + 1}</td><td class="mk">${f ? `<span class="mark" title="${esc(f.severity.toUpperCase() + ': ' + f.title.replace(/`/g, ''))}"></span>` : ''}</td><td class="tx">${l || ' '}</td></tr>`;
    }).join('')}</tbody></table></div>
  </div>`;
}
const sevRank = (s) => ({ high: 0, medium: 1, low: 2 }[s] ?? 3);

function highlight(sql) {
  const toks = tokenize(sql);
  let out = '';
  let pos = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === 'eof') break;
    out += esc(sql.slice(pos, t.s));
    const v = esc(sql.slice(t.s, t.e));
    const next = toks[i + 1];
    if (t.t === 'comment') out += `<span class="c">${v}</span>`;
    else if (t.t === 'str') out += `<span class="s">${v}</span>`;
    else if (t.t === 'num') out += `<span class="n">${v}</span>`;
    else if (t.t === 'param') out += `<span class="p">${v}</span>`;
    else if (t.t === 'word' && (KEYWORDS.has(t.u) || (SOFT_KEYWORDS.has(t.u) && next && next.t === '('))) out += `<span class="k">${v}</span>`;
    else out += v;
    pos = t.e;
  }
  out += esc(sql.slice(pos));
  return out;
}

// ---------------- export ----------------
function renderExport() {
  const r = state.result;
  const text = state.exportFmt === 'json' ? toJson(r) : toMarkdown(r, { title: r.statements.length > 1 ? 'Query explanation' : stmt().title === 'Query' ? 'Query explanation' : stmt().title });
  $('#view-export').innerHTML = `
  <div class="export-grid">
    <div class="export-options">
      <button class="export-option" type="button" data-export="md" aria-pressed="${state.exportFmt === 'md'}"><b>Markdown</b><span>Summary, steps, columns, tables, review and the formatted SQL. Paste into a README, a ticket, a pull request or Confluence.</span></button>
      <button class="export-option" type="button" data-export="json" aria-pressed="${state.exportFmt === 'json'}"><b>JSON</b><span>Everything as data, for scripts and other tools.</span></button>
      <p class="tag">The command-line version gives the same output: <code>npx github:adityakilari/any-query query.sql</code></p>
    </div>
    <div class="export-preview">
      <div class="row"><button class="btn" type="button" data-copy-text="${esc(text)}">Copy</button><button class="btn ghost" type="button" data-download="${state.exportFmt === 'json' ? 'query-explained.json' : 'query-explained.md'}">Download</button></div>
      <pre class="code">${esc(text)}</pre>
    </div>
  </div>`;
}

// ---------------- events ----------------
function copyText(text, btn) {
  const done = () => toast('Copied');
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  else fallbackCopy(text, done);
  void btn;
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch { toast('Copy failed: select the text and copy it manually'); }
  ta.remove();
}
function download(name) {
  const r = state.result;
  const map = {
    'query.sql': [r.sql, 'text/plain'],
    'query.formatted.sql': [r.formatted, 'text/plain'],
    'query-explained.md': [toMarkdown(r, { title: 'Query explanation' }), 'text/markdown'],
    'query-explained.json': [toJson(r), 'application/json'],
  };
  const [text, type] = map[name];
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
let toastTimer;
function toast(msg) {
  let t = $('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1600);
}

function initEvents() {
  $('#edit').addEventListener('click', () => { $('#sql').value = state.sql; showHome(); });
  $('#new').addEventListener('click', () => { $('#sql').value = ''; state.result = null; showHome(); });
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-sample], [data-view], [data-stmt], [data-sev-filter], [data-copy-text], [data-download], [data-export], [data-node], [data-sql-mode], [data-goto-line]');
    if (!t) { if (e.target.closest('#flow-diagram') && state.flowSel) { state.flowSel = null; renderFlow(); } return; }
    if (t.dataset.sample) {
      const s = SAMPLES[Number(t.dataset.sample)];
      $('#sql').value = s.sql;
      $('#dialect').value = 'auto';
      if (s.schemaText) setSchema(s.schemaText, s.schemaName);
      else { state.schema = null; state.schemaName = null; state.schemaText = null; renderSchemaStatus(); }
      run();
      return;
    }
    if (t.dataset.view) { setView(t.dataset.view); window.scrollTo({ top: Math.min(window.scrollY, $('.bar').offsetTop) }); return; }
    if (t.dataset.stmt) { state.stmt = Number(t.dataset.stmt); state.flowSel = null; renderResult(); return; }
    if (t.dataset.sevFilter) { state.sevFilter = t.dataset.sevFilter; renderReview(); return; }
    if (t.dataset.copyText != null) { copyText(t.dataset.copyText, t); return; }
    if (t.dataset.download) { download(t.dataset.download); return; }
    if (t.dataset.export) { state.exportFmt = t.dataset.export; renderExport(); return; }
    if (t.dataset.sqlMode) { state.sqlMode = t.dataset.sqlMode; renderSql(); return; }
    if (t.dataset.gotoLine) {
      state.sqlMode = 'original';
      setView('sql');
      const row = $(`#L${t.dataset.gotoLine}`);
      if (row) { row.scrollIntoView({ block: 'center' }); row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1600); }
      return;
    }
    if (t.dataset.node) { state.flowSel = state.flowSel === t.dataset.node ? null : t.dataset.node; renderFlow(); }
  });
  document.addEventListener('keydown', (e) => {
    const n = e.target.closest && e.target.closest('[data-node]');
    if (n && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); n.click(); }
  });
  window.addEventListener('hashchange', () => {
    const v = location.hash.replace('#', '');
    if (state.result && ['explain', 'flow', 'columns', 'review', 'sql', 'export'].includes(v) && v !== state.view) { state.view = v; renderResult(); }
  });
}

initHome();
initEvents();
// Any Schema's "Open in Any Query" passes the SQL in the URL fragment (#sql=...): it never reaches a server.
const m = /[#&]sql=([^&]+)/.exec(location.hash);
if (m) {
  try {
    $('#sql').value = decodeURIComponent(m[1]);
    setUrl(location.pathname + location.search);
    run();
  } catch { /* ignore a malformed link */ }
}
