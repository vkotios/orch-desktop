// F-11: installed Codex 0.156.1 ThreadResumeParams includes excludeTurns.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(
  here,
  "../../../docs/evidence/codex-0.156.1/ThreadResumeParams.excludeTurns.json",
);

describe("Codex thread/resume excludeTurns (installed 0.156.1)", () => {
  it("schema documents boolean excludeTurns on ThreadResumeParams", () => {
    expect(existsSync(schemaPath)).toBe(true);
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    expect(schema.version).toBe("0.156.1");
    expect(schema.excludeTurns?.type).toBe("boolean");
    expect(String(schema.excludeTurns.description || "")).toMatch(/thread\.turns/i);
  });

  it("native-chat resume request sets excludeTurns true", async () => {
    const source = readFileSync(join(here, "../server/native-chat.mjs"), "utf8");
    expect(source).toMatch(/excludeTurns:\s*true/);
  });
});
