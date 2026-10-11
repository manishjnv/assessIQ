// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { lintMigrations } from "../lint-migrations.js";

/** Write fixtures to a temp dir (module/migrations/name) and read them back as lint input. */
function run(spec: Record<string, string>): string[] {
  const root = mkdtempSync(join(tmpdir(), "lint-mig-"));
  const files = Object.entries(spec).map(([name, content]) => {
    const p = join(root, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    return { path: p, content: readFileSync(p, "utf8") };
  });
  return lintMigrations(files, files.map((f) => f.path));
}

describe("lintMigrations", () => {
  it("passes a clean tree (comments, strings, CTEs and legacy names ignored)", () => {
    expect(
      run({
        "a/migrations/0001_tenants.sql": "CREATE TABLE tenants (id uuid PRIMARY KEY);",
        "a/migrations/0002_users.sql":
          "-- FROM later_table\nCREATE TABLE users (t uuid REFERENCES tenants(id));\nSELECT 'FROM later_table';\nWITH later_table AS (SELECT 1) SELECT * FROM later_table;",
        "b/migrations/010_oauth_identities.sql": "ALTER TABLE users ADD COLUMN x int;",
        "b/migrations/0003_later_table.sql": "CREATE TABLE later_table (id int);",
      }),
    ).toEqual([]);
  });

  it("flags a duplicate basename (R1)", () => {
    const v = run({
      "a/migrations/0001_x.sql": "SELECT 1;",
      "b/migrations/0001_x.sql": "SELECT 1;",
    });
    expect(v.filter((m) => m.includes("R1"))).toHaveLength(1);
  });

  it("flags a bad prefix (R2) and a bad name (R4)", () => {
    const v = run({
      "a/migrations/099_nope.sql": "SELECT 1;",
      "a/migrations/0002_Bad-Name.sql": "SELECT 1;",
    });
    expect(v.some((m) => m.includes("R2") && m.includes("099_nope.sql"))).toBe(true);
    expect(v.some((m) => m.includes("R4") && m.includes("0002_Bad-Name.sql"))).toBe(true);
  });

  it("flags a forward reference (R3)", () => {
    const v = run({
      "a/migrations/0001_child.sql": "CREATE TABLE child (p uuid REFERENCES parent(id));",
      "a/migrations/0002_parent.sql": "CREATE TABLE IF NOT EXISTS parent (id uuid PRIMARY KEY);",
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/R3 forward reference to "parent"/);
  });
});
