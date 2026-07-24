import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createQuestionToolDefinition } from "../src/questions/tool.js";

async function productionToolAllowlist(): Promise<string[]> {
  const path = fileURLToPath(new URL("../src/backend/pi-runtime-backend.ts", import.meta.url));
  const source = ts.createSourceFile(
    path,
    await readFile(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let allowlist: string[] | undefined;

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "createAgentSessionFromServices"
    ) {
      const options = node.arguments[0];
      if (options && ts.isObjectLiteralExpression(options)) {
        const tools = options.properties.find(
          (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) &&
            ((ts.isIdentifier(property.name) && property.name.text === "tools") ||
              (ts.isStringLiteral(property.name) && property.name.text === "tools")),
        );
        if (tools && ts.isArrayLiteralExpression(tools.initializer)) {
          allowlist = tools.initializer.elements
            .filter((element): element is ts.StringLiteral => ts.isStringLiteral(element))
            .map((element) => element.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  if (!allowlist) throw new Error("Production createAgentSessionFromServices tools allowlist was not found");
  return allowlist;
}

describe("M5 real Pi Question registry", () => {
  it("keeps the production Question definition active after Pi applies its tools allowlist", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-m5-question-registry-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    await Promise.all([mkdir(cwd), mkdir(agentDir)]);
    const services = await createAgentSessionServices({ cwd, agentDir });
    const question = createQuestionToolDefinition({ request: async (questions) => questions });
    const tools = await productionToolAllowlist();
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      customTools: [question] as unknown as ToolDefinition[],
      tools,
    });

    try {
      expect(session.getActiveToolNames()).toContain("question");
      expect(session.getToolDefinition("question")).toMatchObject({ name: "question", label: "Question" });
      expect(session.getAllTools().filter((tool) => tool.name === "question")).toHaveLength(1);
    } finally {
      session.dispose();
    }
  });
});
