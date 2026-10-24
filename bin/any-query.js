#!/usr/bin/env node
// any-query: explain and review SQL from the command line.
//
//   any-query query.sql                      Markdown explanation + review on stdout
//   any-query query.sql --schema schema.sql  check names against a schema (any format Any Schema reads)
//   any-query query.sql --format json        machine-readable result
//   any-query query.sql --format sql         formatted SQL only
//   cat query.sql | any-query -              read from stdin
//   any-query queries/*.sql --fail-on high   exit 1 when a finding of that severity (or worse) exists (for CI)
import fs from 'node:fs';
import path from 'node:path';
import { analyzeSql, VERSION, DIALECTS } from '../src/core/index.js';
import { loadSchema } from '../src/core/schema.js';
import { toMarkdown, toJson } from '../src/core/render.js';

const args = process.argv.slice(2);
const opts = { format: 'md', schema: null, dialect: 'auto', failOn: null, out: null, files: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') { help(); process.exit(0); }
  else if (a === '-v' || a === '--version') { console.log(VERSION); process.exit(0); }
  else if (a === '--schema' || a === '-s') opts.schema = args[++i];
  else if (a === '--format' || a === '-f') opts.format = args[++i];
  else if (a === '--dialect' || a === '-d') opts.dialect = args[++i];
  else if (a === '--fail-on') opts.failOn = args[++i];
  else if (a === '--out' || a === '-o') opts.out = args[++i];
  else if (a.startsWith('--')) { console.error(`Unknown option ${a}. Run any-query --help.`); process.exit(2); }
  else opts.files.push(a);
}
if (!opts.files.length) { help(); process.exit(2); }
if (!['md', 'markdown', 'json', 'sql'].includes(opts.format)) { console.error(`--format must be md, json or sql (got ${opts.format}).`); process.exit(2); }
if (opts.dialect !== 'auto' && !DIALECTS[opts.dialect]) { console.error(`--dialect must be one of: ${Object.keys(DIALECTS).join(', ')}.`); process.exit(2); }
const RANK = { high: 0, medium: 1, low: 2 };
if (opts.failOn && !(opts.failOn in RANK)) { console.error('--fail-on must be high, medium or low.'); process.exit(2); }

let schema = null;
if (opts.schema) {
  try { schema = loadSchema(fs.readFileSync(opts.schema, 'utf8'), path.basename(opts.schema)); }
  catch (err) { console.error(`Could not read the schema ${opts.schema}: ${err.message}`); process.exit(2); }
}

let failed = false;
const outputs = [];
for (const file of opts.files) {
  const sql = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
  const result = analyzeSql(sql, { dialect: opts.dialect, schema });
  const name = file === '-' ? 'stdin' : path.basename(file);
  if (opts.format === 'json') outputs.push(opts.files.length > 1 ? `{"file": ${JSON.stringify(name)}, "result": ${toJson(result)}}` : toJson(result));
  else if (opts.format === 'sql') outputs.push(result.formatted);
  else outputs.push(toMarkdown(result, { title: name }));
  if (opts.failOn) {
    const bad = result.statements.flatMap((s) => s.findings).filter((f) => RANK[f.severity] <= RANK[opts.failOn]);
    if (bad.length) {
      failed = true;
      for (const f of bad) console.error(`${name}:${f.line}: ${f.severity}: ${strip(f.title)} [${f.rule}]`);
    }
  }
}
const text = opts.format === 'json' && opts.files.length > 1 ? `[\n${outputs.join(',\n')}\n]\n` : outputs.join('\n\n---\n\n');
if (opts.out) fs.writeFileSync(opts.out, text);
else process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
process.exit(failed ? 1 : 0);

function strip(s) { return String(s).replace(/`/g, ''); }

function help() {
  console.log(`any-query ${VERSION}: explain and review SQL queries in plain English

Usage:
  any-query <file.sql ...> [options]
  cat query.sql | any-query - [options]

Options:
  -s, --schema <file>    schema to check names against (SQL DDL, Prisma, JSON Schema,
                         Salesforce describe, column-list CSV/JSON export, ...)
  -d, --dialect <name>   ${Object.keys(DIALECTS).join(', ')} (default: auto)
  -f, --format <fmt>     md (default), json or sql (formatted SQL only)
  -o, --out <file>       write to a file instead of stdout
      --fail-on <level>  exit with code 1 if any finding is at least high, medium or low
  -h, --help             show this help
  -v, --version          show the version

Everything runs locally; nothing is sent anywhere.`);
}
