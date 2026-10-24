// Guesses the SQL dialect from tell-tale syntax. Used for wording and dialect-specific advice;
// the parser itself accepts all of them.
export const DIALECTS = {
  auto: 'Auto-detect',
  postgres: 'PostgreSQL',
  oracle: 'Oracle',
  sqlserver: 'SQL Server',
  mysql: 'MySQL / MariaDB',
  snowflake: 'Snowflake',
  bigquery: 'BigQuery',
  sqlite: 'SQLite',
  generic: 'Standard SQL',
};

const SIGNALS = [
  ['sqlserver', /\bselect\s+top\s*\(?\s*\d/i, 3, 'SELECT TOP'],
  ['sqlserver', /\[[A-Za-z_][\w ]*\]\s*\./, 2, '[bracketed] names'],
  ['sqlserver', /\b(getdate|getutcdate|sysdatetime|isnull|datepart|dateadd|datediff|len|charindex|newid|iif)\s*\(/i, 1.5, 'T-SQL functions'],
  ['sqlserver', /\bwith\s*\(\s*nolock\s*\)/i, 4, 'WITH (NOLOCK)'],
  ['sqlserver', /\b(cross|outer)\s+apply\b/i, 3, 'APPLY'],
  ['sqlserver', /^\s*go\s*$/im, 3, 'GO'],
  ['sqlserver', /@\w+/, 1, '@variables'],
  ['sqlserver', /\bdbo\./i, 2, 'dbo schema'],
  ['oracle', /\brownum\b/i, 4, 'ROWNUM'],
  ['oracle', /\(\s*\+\s*\)/, 4, '(+) outer joins'],
  ['oracle', /\b(nvl|nvl2|decode|to_char|to_date|add_months|months_between|listagg|instr|sys_context)\s*\(/i, 2, 'Oracle functions'],
  ['oracle', /\bsysdate\b|\bsystimestamp\b/i, 3, 'SYSDATE'],
  ['oracle', /\bfrom\s+dual\b/i, 4, 'FROM DUAL'],
  ['oracle', /\bconnect\s+by\b/i, 4, 'CONNECT BY'],
  ['oracle', /\bq'[[{(<!]/i, 3, "q'[..]' strings"],
  ['oracle', /\bminus\b/i, 2, 'MINUS'],
  ['postgres', /::\s*[a-z]/i, 3, ':: casts'],
  ['postgres', /\bilike\b/i, 2, 'ILIKE'],
  ['postgres', /\bdistinct\s+on\s*\(/i, 4, 'DISTINCT ON'],
  ['postgres', /->>|#>>|@>|<@/, 2, 'JSON operators'],
  ['postgres', /\$\d+/, 2, '$1 parameters'],
  ['postgres', /\b(generate_series|date_trunc|string_agg|array_agg|jsonb_\w+|now)\s*\(/i, 1.5, 'PostgreSQL functions'],
  ['postgres', /\breturning\b/i, 2, 'RETURNING'],
  ['postgres', /\binterval\s+'\d+\s+\w+'/i, 1.5, "INTERVAL '30 days'"],
  ['postgres', /\$\$/, 2, '$$ quoting'],
  ['mysql', /`[^`]+`/, 3, '`backtick` names'],
  ['mysql', /\blimit\s+\d+\s*,\s*\d+/i, 4, 'LIMIT offset, n'],
  ['mysql', /\b(ifnull|date_format|group_concat|str_to_date|curdate|date_sub|date_add|unix_timestamp)\s*\(/i, 2, 'MySQL functions'],
  ['mysql', /\binterval\s+-?\d+\s+(day|month|year|hour|minute|week)\b/i, 2, 'INTERVAL 30 DAY'],
  ['mysql', /\bstraight_join\b|\bon\s+duplicate\s+key\b/i, 4, 'MySQL syntax'],
  ['snowflake', /\bqualify\b/i, 2.5, 'QUALIFY'],
  ['snowflake', /\b(iff|zeroifnull|nullifzero|try_to_\w+|array_construct|object_construct|flatten|parse_json|div0)\s*\(/i, 3, 'Snowflake functions'],
  ['snowflake', /\bexclude\s*\(/i, 2, '* EXCLUDE'],
  ['snowflake', /\w:\w+(::|\b)/, 1, 'path:access'],
  ['bigquery', /`[\w-]+\.[\w-]+\.[\w-]+`/, 5, '`project.dataset.table`'],
  ['bigquery', /\b(safe_cast|safe_divide|date_diff|timestamp_diff|format_date|parse_date|countif|array_length|generate_date_array|struct)\s*\(/i, 3, 'BigQuery functions'],
  ['bigquery', /\bexcept\s*\(\s*\w/i, 1.5, '* EXCEPT (...)'],
  ['bigquery', /\bunnest\s*\(/i, 1, 'UNNEST'],
  ['sqlite', /\b(strftime|julianday|datetime)\s*\(\s*'/i, 3, 'SQLite date functions'],
  ['sqlite', /\bglob\b/i, 2, 'GLOB'],
];

export function detectDialect(sql) {
  const text = String(sql || '').replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').replace(/'(?:[^']|'')*'/g, "''");
  const raw = String(sql || '');
  const scores = {};
  const hits = {};
  for (const [d, re, w, label] of SIGNALS) {
    const src = /q'|\$\$|interval|'/.test(re.source) ? raw : text;
    if (re.test(src)) { scores[d] = (scores[d] || 0) + w; (hits[d] ||= []).push(label); }
  }
  // INTERVAL '30 days' is common to Postgres and Snowflake; :: too
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { id: 'generic', label: DIALECTS.generic, confidence: 'low', signals: [] };
  const [best, score] = ranked[0];
  const second = ranked[1] ? ranked[1][1] : 0;
  const confidence = score >= 4 && score - second >= 2 ? 'high' : score >= 2 ? 'medium' : 'low';
  return { id: best, label: DIALECTS[best], confidence, signals: hits[best] };
}
