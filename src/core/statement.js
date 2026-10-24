// Analyses one parsed statement (explain + review + flow). Used for top-level statements and
// for the SQL statements embedded in functions and procedures.
import { buildModel } from './model.js';
import { explainStatement } from './explain.js';
import { reviewStatement } from './review.js';
import { buildFlow } from './flow.js';

export function lineOf(text, offset) {
  let n = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

/**
 * st: parsed statement whose offsets index into `text`.
 * ctx: { catalog, dialect, variables: Set<lowercase name> | null, index, keepModel }
 */
export function analyzeStatement(st, text, ctx) {
  const base = { index: ctx.index || 0, type: st.type, s: st.s, e: st.e, sql: text.slice(st.s, st.e).trim(), line: lineOf(text, st.s) };
  let model;
  try {
    model = buildModel(st, ctx.catalog || null, { variables: ctx.variables || null });
  } catch (err) {
    return { ...base, failed: true, title: 'Query', summary: [`Any Query could not analyse this statement (${err.message}). The formatted SQL is still available.`], steps: [], outputs: [], tables: [], findings: [], flow: null };
  }
  const ex = explainStatement(st, model, base.index, text);
  const findings = reviewStatement(st, model, { sql: text, dialect: ctx.dialect, catalog: ctx.catalog || null });
  const flow = buildFlow(model, ex);
  const out = { ...base, ...ex, findings, flow };
  if (ctx.keepModel) Object.defineProperty(out, 'model', { value: model, enumerable: false });
  return out;
}

/**
 * Re-bases offsets of a result computed on a snippet (`snippetStart` = where the snippet begins
 * in the full text, `delta` = extra shift for text that was prepended to the snippet).
 */
export function shiftResult(r, snippetStart, delta, fullText) {
  const sh = (x) => (x == null ? x : Math.max(snippetStart, x + snippetStart - delta));
  const line = (x) => lineOf(fullText, x);
  r.s = sh(r.s); r.e = sh(r.e); r.line = line(r.s);
  for (const f of r.findings || []) { f.s = sh(f.s); f.e = sh(f.e); f.line = line(f.s); }
  for (const s of r.steps || []) { s.s = sh(s.s); s.e = sh(s.e); for (const l of s.lines || []) for (const it of l.items || []) { if (it.s != null) { it.s = sh(it.s); it.e = sh(it.e); } } }
  for (const o of r.outputs || []) { if (o.s != null) { o.s = sh(o.s); o.e = sh(o.e); } }
  return r;
}
