# Testing Any Query

## 1. Automated tests (2 minutes)

```bash
npm install
npm test
```

You should see `# pass 43` and `# fail 0`. The suites are:

| File | What it proves |
|---|---|
| `test/parse.test.js` | Quoting, comments, `GO` / `/` separators, every statement type, dialect syntax (TOP, `(+)`, `::`, QUALIFY, backticks…), recovery from bad SQL, dialect detection |
| `test/explain.test.js` | Grain ("one row per …"), join wording, relative dates ("yesterday", "90 days ago"), conditions, aggregates and windows, lineage through CTEs, schema descriptions, INSERT/UPDATE/DELETE |
| `test/routine.test.js` | PL/pgSQL functions, Oracle PL/SQL procedures and blocks, T-SQL procedures and scripts: outline, parameters, variables, and the procedural checks |
| `test/review.test.js` | Each of the query rules fires on a bad query **and stays quiet on the corrected one**; schema checks; no false alarms on the clean samples |
| `test/format.test.js` | Formatting changes only whitespace and keyword case (token-for-token), and formatting twice gives the same result |
| `test/database.test.js` | Runs SQL in a real PostgreSQL (PGlite): formatted SQL returns identical rows; NOT IN / LEFT JOIN / BETWEEN / = NULL problems really happen and the suggested fixes really work; the sample PL/pgSQL function runs and shows the bug the review reports |
| `test/cli.test.js` | Markdown/JSON/SQL output and `--fail-on` exit codes |
| `test/ui.test.js` | Loads the built page, opens samples, clicks every tab, the statement picker and the `#sql=` link |

## 2. Manual checks in the browser

Run `npm start` and open http://localhost:8080 (or open `dist/any-query.html` after `npm run build`, or the live site).

| # | Do this | You should see |
|---|---|---|
| 1 | Click the **Top customers** sample | The result page opens. The headline reads "Returns one row per address (so each customer can appear several times)". There are 3 step cards: `shipped_orders`, `latest_order`, The final result. |
| 2 | In step 3, read the join lines | "Only the most recent order per customer is matched", and "so from here on there is one row per address" |
| 3 | Click **Show the SQL for this step** | Only that CTE's SQL, highlighted |
| 4 | **Flow** tab, then click `orders` | `orders` feeds both CTEs, which feed **Result**. The side panel lists the columns used. |
| 5 | **Columns** tab | `revenue` → "The sum of order total", comes from `orders.total`. The grey text is the schema's description of each column. |
| 6 | **Review** tab | "No problems found" plus the list of what was checked |
| 7 | Click **New query**, then **A query with mistakes**, then **Review** | 8 findings (4 high, 2 medium, 2 low). Each has a line number, an explanation, a **Fix**, and a **Copy** button where a rewrite exists. |
| 8 | Click **High** in the filter row | Only the 4 high findings are shown |
| 9 | Click **show in SQL** on a finding | The SQL tab opens on **Original** and scrolls to that line. Lines with findings have coloured markers; hover a marker to see its finding. |
| 10 | **SQL → Formatted**, then **Copy** / **Download .sql** | Clean SQL is copied or downloaded |
| 11 | **Export → Markdown / JSON → Copy / Download** | A full write-up you can paste into a PR or wiki |
| 12 | **Yesterday's admissions** (Oracle) | "encounter admit datetime is yesterday"; the `(+)` join is explained as an outer join; the review flags `ROWNUM <= 100` running before ORDER BY |
| 13 | **Sales pipeline** (SQL Server) | OUTER APPLY gets its own step; NOLOCK is flagged; "user is active" (not "IsActive = 1") |
| 14 | **Monthly revenue trend** (Snowflake) | 2 statements, with a picker under the title. The first is "one row per month" with LAG and running-total explanations; the second is "the first order per customer" (QUALIFY). |
| 15 | **Archive and clean up** (MySQL) | 3 statements: INSERT … SELECT, UPDATE … JOIN, DELETE |
| 16 | Schema check: **New query**, paste `SELECT emial FROM customers`, click **Add schema file**, pick `samples/schemas/ecommerce-postgres.sql`, then **Explain** | Review: "`customers` has no column `emial`. Did you mean `email`?" |
| 17 | Remove the schema, then explain `SELECT * FROM orders o, customers c` | High finding: tables listed with no join condition |
| 18 | Paste something broken, e.g. `SELECT a FROM t WHERE (b = 1` | No crash. You get a note that part of the query could not be read, and everything else is still explained. |
| 19 | Paste a `CREATE TABLE …` | It says this is DDL and points to Any Schema |
| 20 | Drag a `.sql` file onto the box; also try **Open a .sql file** | It loads and explains immediately |
| 21 | Ctrl/⌘ + Enter in the editor | Same as clicking **Explain query** |
| 22 | Open `<site>/#sql=SELECT%201` | It opens straight on the result page (this is how Any Schema's **Open in Any Query** button works) |
| 23 | Switch your OS to dark mode; narrow the window to phone width | Dark theme; no sideways scrolling |
| 24 | Privacy: open DevTools → Network, then click **Explain** | No network requests (only the fonts when the page first loads) |
| 25 | **Import documents (function)** sample | Title "Function docs.import_documents"; a parameters table; "What it does" shows the loop with nested IFs and each SQL statement in plain English (click **Details** under one); Review shows 1 high (`v_parent_id` is never set), plus no-op UPDATE, loop-repeating UPDATE and count-then-insert |
| 26 | **Give a raise (procedure)** sample | Oracle outline with the cursor loop, "Stops with an error: …", and the EXCEPTION handler; Review flags the concatenated EXECUTE IMMEDIATE and `WHEN OTHERS THEN NULL` |
| 27 | **Close stale deals (procedure)** sample | T-SQL outline: IF @DryRun, TRY/CATCH, `@Cutoff` = "`@Days` days ago"; Review flags the dynamic SQL |
| 28 | Paste one of your own functions or procedures | Click a line number in the outline to jump to that line in the SQL tab |

## 3. Command line

```bash
node bin/any-query.js samples/top-customers-postgres.sql                    # Markdown on screen
node bin/any-query.js samples/inpatients-oracle.sql -f sql                  # formatted SQL
node bin/any-query.js samples/pipeline-sqlserver.sql -f json > out.json     # JSON
node bin/any-query.js samples/needs-review-postgres.sql \
  --schema samples/schemas/ecommerce-postgres.sql --fail-on high; echo "exit=$?"   # prints 4 findings, exit=1
node bin/any-query.js samples/top-customers-postgres.sql --fail-on high; echo "exit=$?"  # exit=0
cat samples/housekeeping-mysql.sql | node bin/any-query.js -               # from stdin
```

## 4. Your own queries

Paste real queries from work, ideally with your schema export: the same file you use in Any Schema works here. If an explanation reads wrong, or a finding is a false alarm, open an issue with the query (or a cut-down version) and what you expected. Each fix gets a test, so it stays fixed.
