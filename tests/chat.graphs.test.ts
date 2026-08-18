import { describe, expect, it } from "bun:test";
import {
  extractInteractiveGraphBlocks,
  interactiveGraphSchema,
} from "../src/api/v1/chat.graphs";

const validGraph = {
  version: 1,
  title: "Normalfördelning",
  xAxis: { min: -5, max: 5, label: "x" },
  yAxis: { min: 0, max: 0.8, label: "Täthet" },
  showGrid: true,
  parameters: [
    { id: "mu", label: "Medelvärde", min: -2, max: 2, step: 0.1, initial: 0 },
    {
      id: "sigma",
      label: "Standardavvikelse",
      min: 0.2,
      max: 3,
      step: 0.1,
      initial: 1,
    },
  ],
  series: [
    {
      label: "Täthetsfunktion",
      expression: "1/(sigma*sqrt(2*PI))*exp(-0.5*((x-mu)/sigma)^2)",
      style: "solid",
    },
  ],
  points: [],
};

describe("interactive graph artifacts", () => {
  it("accepts a bounded parameterized graph", () => {
    expect(interactiveGraphSchema.safeParse(validGraph).success).toBe(true);
  });

  it("rejects unsafe expressions and invalid parameter ranges", () => {
    const parsed = interactiveGraphSchema.safeParse({
      ...validGraph,
      parameters: [{ ...validGraph.parameters[0], min: 3, max: 1 }],
      series: [{ ...validGraph.series[0], expression: "window.alert(1); x" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects identifiers outside the supported expression language", () => {
    const parsed = interactiveGraphSchema.safeParse({
      ...validGraph,
      series: [{ ...validGraph.series[0], expression: "secret*x" }],
    });

    expect(parsed.success).toBe(false);
  });

  it("does not reject a valid graph because of verbose display text", () => {
    const parsed = interactiveGraphSchema.safeParse({
      ...validGraph,
      series: [{ ...validGraph.series[0], label: "A".repeat(200) }],
    });

    expect(parsed.success).toBe(true);
  });

  it("extracts valid blocks and reports malformed blocks", () => {
    const content = [
      "Text före.",
      "```interactive-graph",
      JSON.stringify(validGraph),
      "```",
      "```interactive-graph",
      "{not json}",
      "```",
    ].join("\n");

    const blocks = extractInteractiveGraphBlocks(content);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.spec?.title).toBe("Normalfördelning");
    expect(blocks[1]).toMatchObject({ spec: null, error: "Invalid JSON" });
  });
});
