// Optional schema context, loaded with Any Schema's readers (SQL DDL, Prisma, JSON Schema,
// Salesforce, MongoDB, column-list CSV/JSON exports). With a schema, Any Query can check
// table and column names, expand SELECT *, tell which side of a join is the key, and reuse
// Any Schema's plain-English description of each table and column.
import { parseText } from 'any-schema/src/core/parse.js';
import { analyze } from 'any-schema/src/core/analyze.js';

export function loadSchema(text, fileName = 'schema.sql', format = 'auto') {
  const schema = parseText(text, fileName, format);
  if (!schema.tables.length) throw new Error(`No tables were found in ${fileName}. Use a schema file such as CREATE TABLE statements, a Prisma schema or a column-list export.`);
  const analysis = analyze(schema);
  return buildCatalog(schema, analysis, fileName);
}

export function buildCatalog(schema, analysis, fileName = 'schema') {
  const byName = new Map();
  const byQualified = new Map();
  const tables = [];
  for (const t of schema.tables) {
    const key = t.schema ? `${t.schema}.${t.name}` : t.name;
    const at = analysis.tables.find((x) => x.key === key) || analysis.tables.find((x) => x.name === t.name) || null;
    const colDocs = new Map((at ? at.columns : []).map((c) => [c.name.toLowerCase(), c]));
    const entry = {
      name: t.name,
      schema: t.schema || null,
      key,
      kind: t.kind,
      purpose: at ? at.purpose : null,
      roleLabel: at ? at.roleLabel : null,
      primaryKey: t.primaryKey.slice(),
      uniques: t.uniques.map((u) => u.slice()),
      columns: t.columns.map((c) => ({
        name: c.name,
        type: c.rawType,
        category: c.category,
        nullable: c.nullable,
        unique: !!c.unique,
        explain: colDocs.get(c.name.toLowerCase())?.main || null,
      })),
      foreignKeys: [],
    };
    entry.colMap = new Map(entry.columns.map((c) => [c.name.toLowerCase(), c]));
    tables.push(entry);
    if (!byName.has(t.name.toLowerCase())) byName.set(t.name.toLowerCase(), entry);
    byQualified.set(key.toLowerCase(), entry);
  }
  // declared and inferred relationships from Any Schema
  for (const r of analysis.relationships || []) {
    if (!r.from || !r.to || r.external) continue;
    const from = byQualified.get(String(r.from.table || '').toLowerCase()) || byName.get(String(r.from.name || '').toLowerCase());
    const to = byQualified.get(String(r.to.table || '').toLowerCase()) || byName.get(String(r.to.name || '').toLowerCase());
    if (!from || !to) continue;
    from.foreignKeys.push({ columns: r.from.columns.slice(), refTable: to, refColumns: (r.to.columns || []).slice(), source: r.source });
  }
  return {
    fileName,
    format: schema.source.format,
    dialect: schema.source.dialect,
    tables,
    lookup(parts) {
      if (!parts || !parts.length) return null;
      const name = String(parts[parts.length - 1]).toLowerCase();
      if (parts.length >= 2) {
        const q = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`.toLowerCase();
        if (byQualified.has(q)) return byQualified.get(q);
      }
      return byName.get(name) || null;
    },
  };
}
