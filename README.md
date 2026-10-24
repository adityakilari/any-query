# Any Query

**Paste any SQL query and understand it in plain English: what one row of the result means, every join and filter step by step, where each column comes from, and the mistakes that quietly return wrong rows, with fixes.**

Runs entirely in your browser. Your SQL is never uploaded and nothing is saved.

**Try it:** https://adityakilari.github.io/any-query/ · Companion tool: [Any Schema](https://adityakilari.github.io/any-schema/) (explains whole database schemas)

| | |
|---|---|
| **Explain** | A short summary ("Returns the most recent order per customer…"), then a step-by-step walkthrough of every CTE, subquery and join in the order the database runs them. |
| **Flow** | A diagram of tables → CTEs/subqueries → result. Click any box for details. |
| **Columns** | What each returned column means, whether it is calculated, aggregated or a window, and which table columns it is built from (lineage, traced through CTEs). |
| **Review** | 42 checks for wrong results, errors and slow patterns, each with a line number, an explanation and a ready-to-paste fix. |
| **SQL** | The query neatly formatted, plus the original with problem lines marked. |
| **Export** | Markdown (for a PR, ticket or wiki) or JSON. |

**Functions and procedures too.** Paste a PostgreSQL PL/pgSQL function (`CREATE FUNCTION … $$ … $$`, `DO` blocks), an Oracle PL/SQL procedure or block, or a SQL Server T-SQL procedure or script, and you get:
- an outline of what it does (declarations, IF / ELSIF, loops, assignments, RETURN, error handlers);
- every SQL statement inside it explained and reviewed, with your parameters and variables recognised as variables;
- checks that only make sense in procedural code: a variable used but never set (always NULL), SQL inside a loop that repeats the same work on every pass, count-then-insert races, IF conditions that are always true, dynamic SQL built by string concatenation, and errors that are caught and ignored.

Works with **PostgreSQL, Oracle, SQL Server, MySQL/MariaDB, Snowflake, BigQuery and SQLite**. The dialect is detected automatically and you can override it. Explains `SELECT` (CTEs, joins, subqueries, `UNION`, window functions, `QUALIFY`, `CONNECT BY`, `PIVOT`…), `INSERT … SELECT`, `UPDATE` (including `UPDATE … JOIN` and `UPDATE … FROM`), `DELETE`, `MERGE` and `CREATE VIEW / TABLE AS`.

---

## Example

```sql
SELECT c.id, c.email, COUNT(o.id) AS orders, SUM(p.amount) AS paid
FROM customers c
JOIN orders o ON o.customer_id = c.id
LEFT JOIN payments p ON p.order_id = o.id
WHERE p.status = 'captured'
  AND c.id NOT IN (SELECT customer_id FROM reviews WHERE rating = 1)
GROUP BY c.id, c.email;
```

**Any Query says** (with the sample e-commerce schema loaded):

> Returns one row per customer. … It only includes rows where payment status is “captured” and customer ID is not among the customer IDs of reviews where rating is 1.
>
> **HIGH** · The WHERE condition on `p` undoes the LEFT JOIN to `payments`. For orders with no matching payment, the p columns are NULL, so `p.status = 'captured'` is never true for them and they are dropped. **Fix:** `LEFT JOIN payments p ON p.order_id = o.id AND p.status = 'captured'`
>
> **HIGH** · NOT IN (subquery) returns no rows at all if the subquery returns a NULL. **Fix:** `NOT EXISTS (SELECT 1 FROM reviews WHERE reviews.customer_id = c.id AND rating = 1)`

These are not guesses: the test suite runs each of these problems and its suggested fix in a real PostgreSQL engine and checks that the problem happens and the fix works (see `test/database.test.js`).

---

## Use it

### In the browser (no install)

Open https://adityakilari.github.io/any-query/, paste a query (or open a `.sql` file, or drag it in) and press **Explain query** (or Ctrl/⌘ + Enter). Try the nine samples on the right: six queries and three functions/procedures.

**Add your schema (optional, recommended).** Click **Add schema file** and choose your schema. With it, Any Query:

- checks every table and column name (with "did you mean…?" suggestions),
- expands `SELECT *` into real columns,
- uses real primary keys and foreign keys to decide whether a join can repeat rows,
- shows each column's documented meaning, written by Any Schema.

It accepts every format [Any Schema](https://github.com/adityakilari/any-schema) reads: `CREATE TABLE` DDL (pg_dump, mysqldump, SQL Server scripts, Oracle DDL…), a Prisma schema, JSON Schema/OpenAPI, a Salesforce describe file, MongoDB samples, or a column-list export (`information_schema.columns`, Oracle `ALL_TAB_COLUMNS`… as CSV or JSON). The export queries for each database are in the [Any Schema README](https://github.com/adityakilari/any-schema#get-your-schema-file).

**Download a single file.** `dist/any-query.html` (built by `npm run build`) is the whole app in one file. It works offline and from `file://`, which is handy on locked-down machines.

### From Any Schema

In Any Schema's **Relationships → How do two tables connect?** box, the generated join SQL has an **Open in Any Query** button.

### On the command line

```bash
npx github:adityakilari/any-query query.sql                       # Markdown explanation + review
npx github:adityakilari/any-query query.sql --schema schema.sql   # check names against your schema
npx github:adityakilari/any-query query.sql -f json               # machine-readable
npx github:adityakilari/any-query query.sql -f sql                # formatted SQL only
cat query.sql | npx github:adityakilari/any-query -               # from stdin
```

Options: `--schema <file>`, `--dialect postgres|oracle|sqlserver|mysql|snowflake|bigquery|sqlite`, `--format md|json|sql`, `--out <file>`, `--fail-on high|medium|low`.

### In CI (catch mistakes in pull requests)

```yaml
# .github/workflows/sql-review.yml
name: SQL review
on: pull_request
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npx -y github:adityakilari/any-query sql/**/*.sql --schema db/schema.sql --fail-on high
```

With `--fail-on high` the command exits with code 1 and prints `file:line: severity: message [rule]` for each finding.

---

## Review rules

| Rule | Severity | What it catches |
|---|---|---|
| `left-join-undone` | high | A WHERE condition on a LEFT JOINed table removes the rows the LEFT JOIN was meant to keep |
| `not-in-null` | high/medium | `NOT IN (subquery)` returns nothing when the subquery returns a NULL (uses the schema to know if the column is nullable) |
| `not-in-null-literal` | high | `NOT IN (…, NULL)` is never true |
| `equals-null` | high | `= NULL` / `<> NULL` is never true |
| `missing-join-condition` | high | Tables listed with commas and no linking condition (an accidental cross join) |
| `ungrouped-column` | high | A selected column is neither in GROUP BY nor aggregated (knows PostgreSQL/MySQL allow columns that depend on a grouped key) |
| `aggregate-in-where` | high | `WHERE COUNT(*) > 1` (should be HAVING) |
| `window-in-where` | high | Window functions in WHERE |
| `alias-in-where` | high/medium | A SELECT alias used in WHERE |
| `rownum-order` | high | Oracle `ROWNUM <= n` with ORDER BY at the same level (limits before sorting) |
| `update-without-where` | high | UPDATE or DELETE that changes every row |
| `unknown-alias` | high | `x.col` where `x` is not a table or alias in scope |
| `unknown-table`, `unknown-column` | high | Names not in the loaded schema, with suggestions |
| `ambiguous-column` | high | An unqualified column that exists in more than one joined table |
| `between-timestamp` | medium | `ts BETWEEN '2025-01-01' AND '2025-01-31'` misses most of the last day |
| `function-on-column` | medium | `YEAR(col) = 2025`, `TRUNC(col) = …`, `UPPER(col) = …` block index use (with a range rewrite where possible) |
| `limit-without-order` | medium | LIMIT / TOP / FETCH / ROWNUM without ORDER BY |
| `row-number-without-order` | medium | ROW_NUMBER / RANK / LAG… without ORDER BY |
| `distinct-hides-join` | medium | DISTINCT covering duplicates from a one-to-many join |
| `correlated-subquery` | medium | A subquery in SELECT that runs once per row |
| `join-fan-out` | medium/low | Joining on columns that are unique on neither side |
| `unused-cte` | medium | A CTE that nothing reads |
| `nolock` | medium | SQL Server `WITH (NOLOCK)` |
| `division-by-zero` | low | `a / b` where b can be 0 (with a `NULLIF` fix) |
| `having-without-aggregate` | low | A HAVING condition that belongs in WHERE |
| `or-in-join` | low | OR in a join condition |
| `leading-wildcard` | low | `LIKE '%…'` cannot use an index |
| `select-star` | low/medium | `SELECT *` (medium in views and INSERT … SELECT) |
| `union-distinct` | low | UNION where UNION ALL may be intended |
| `implicit-join` | low | Comma joins and Oracle `(+)` syntax |
| `ordinal-reference` | low | `GROUP BY 1`, `ORDER BY 2` |
| `order-in-subquery` | low | ORDER BY inside a CTE or subquery has no effect |
| `no-op-update` | medium | `SET col = '' || col` and similar: the UPDATE changes nothing but still rewrites the rows |

**Functions and procedures**

| Rule | Severity | What it catches |
|---|---|---|
| `unassigned-variable` | high | A variable is read but never assigned, so it is always NULL and conditions using it never match |
| `dynamic-sql-concat` | high | `EXECUTE` / `EXECUTE IMMEDIATE` / `EXEC(…)` with SQL built by joining strings (SQL injection) |
| `loop-invariant-sql` | medium | An UPDATE/DELETE/INSERT inside a loop that uses nothing from the loop, so it repeats the same work on every pass |
| `check-then-insert` | medium | `SELECT COUNT(*) INTO …` followed by an INSERT into the same table: a race that can create duplicates |
| `swallowed-error` | medium | `WHEN OTHERS THEN NULL` / an empty CATCH: errors silently ignored |
| `select-into-many` | low | `SELECT … INTO v` (or `SELECT @v = …`) whose filter can match several rows |
| `always-true-condition` | low | `IF v IS NOT NULL` right after `v := COALESCE(…, 'default')` |
| `unused-variable` | low | Declared variables that are never read |

---

## How it works

Everything is deterministic: there is no AI call and no server. The same query always gets the same explanation.

1. **Tokenizer** (`src/core/tokenize.js`). It handles every dialect's quoting (`"x"`, `` `x` ``, `[x]`, `q'[…]'`, `$$…$$`), comments, `::` casts, Oracle `(+)`, parameters, and `GO` / `/` batch separators.
2. **Tolerant parser** (`src/core/parse.js`). It builds a small syntax tree. When it meets syntax it does not know, it skips to the next clause and adds a note instead of failing.
3. **Scope model** (`src/core/model.js`). It resolves every column to its table (through aliases, CTEs, subqueries and correlated references), and works out which side of each join is the key. This decides whether a join keeps one row per X or repeats rows.
4. **Explainer** (`src/core/explain.js`). It turns the model into sentences, for example:
   - `CURRENT_DATE - INTERVAL '90 days'` → "90 days ago"
   - `ROW_NUMBER() … = 1` → "the most recent order per customer"
   - `SUM(CASE WHEN … THEN 1 ELSE 0 END)` → "the number of orders where …"
   - `DECODE`, `NVL`, `DATEADD` and similar functions are explained in words too.
   Column names are expanded with Any Schema's abbreviation list: `DSCHRG_DTTM` → "discharge datetime".
5. **Review** (`src/core/review.js`), **flow** (`src/core/flow.js`) and **formatter** (`src/core/format.js`). The formatter is token-based, so it only changes whitespace and keyword case. The tests check this against every sample.

The schema readers and the name expansion come from [Any Schema](https://github.com/adityakilari/any-schema). It is a dependency pinned to a commit, so there is one copy of that code.

**Limits.**
- Without a schema, Any Query infers keys from naming (`id`, `customer_id` → `customers.id`). Load a schema for exact answers.
- Functions and procedures are explained as an outline of their statements; package bodies with many procedures, and very unusual procedural syntax, may only be partly read (a note says where reading stopped).
- Explanations describe what the SQL says, not what your data contains.

---

## Develop

```bash
git clone https://github.com/adityakilari/any-query.git
cd any-query
npm install
npm start          # http://localhost:8080 (rebuilds on every reload)
npm test           # 43 tests: parser, explanations, review rules, formatter, CLI, UI, and a real PostgreSQL run
npm run build      # dist/index.html (the site) and dist/any-query.html (single file)
```

| Path | What |
|---|---|
| `src/core/` | Tokenizer, parser, model, explainer, review rules, flow, formatter, exports (no DOM; shared by the app and the CLI) |
| `src/ui/` | Browser app and styles |
| `bin/any-query.js` | Command-line tool |
| `samples/` | Sample queries (+ `samples/schemas/`). Run `npm run generate` after editing |
| `test/` | `node:test` suites. `database.test.js` runs queries in PGlite (PostgreSQL compiled to WebAssembly) |

**Adding a review rule:** add a check in `src/core/review.js`, register it in `RULES`, and add a "fires on / does not fire on" pair to `test/review.test.js`. If it suggests a rewrite, prove the rewrite in `test/database.test.js`.

GitHub Pages deploys from `main` through `.github/workflows/pages.yml`. In the repository settings, set **Pages → Source** to **GitHub Actions**.

## License

MIT
