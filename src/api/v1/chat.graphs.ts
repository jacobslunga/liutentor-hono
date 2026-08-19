import { z } from "zod";

const finiteCoordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const displayText = z.string().trim().max(2_000);
const requiredDisplayText = displayText.pipe(z.string().min(1));

const axisSchema = z
  .object({
    min: finiteCoordinate,
    max: finiteCoordinate,
    label: displayText.optional(),
  })
  .strict()
  .refine((axis) => axis.min < axis.max, {
    message: "Axis min must be smaller than max",
  });

const parameterSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,23}$/),
    label: requiredDisplayText,
    min: finiteCoordinate,
    max: finiteCoordinate,
    step: z.number().finite().positive().max(100_000),
    initial: finiteCoordinate,
  })
  .strict()
  .superRefine((parameter, ctx) => {
    if (parameter.min >= parameter.max) {
      ctx.addIssue({
        code: "custom",
        path: ["min"],
        message: "Parameter min must be smaller than max",
      });
    }
    if (parameter.initial < parameter.min || parameter.initial > parameter.max) {
      ctx.addIssue({
        code: "custom",
        path: ["initial"],
        message: "Initial value must be inside the parameter range",
      });
    }
  });

const expressionSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .regex(/^[0-9A-Za-z_+\-*/^().,\s]+$/, "Unsupported expression characters");

const allowedExpressionNames = new Set([
  "x",
  "PI",
  "E",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "sinh",
  "cosh",
  "tanh",
  "sqrt",
  "log",
  "ln",
  "lg",
  "log10",
  "abs",
  "ceil",
  "floor",
  "round",
  "trunc",
  "exp",
  "cbrt",
  "expm1",
  "log1p",
  "sign",
  "log2",
]);

const seriesSchema = z
  .object({
    label: requiredDisplayText,
    expression: expressionSchema,
    style: z.enum(["solid", "dashed"]).default("solid"),
  })
  .strict();

const pointSchema = z
  .object({
    x: finiteCoordinate,
    y: finiteCoordinate,
    label: displayText.optional(),
  })
  .strict();

export const interactiveGraphSchema = z
  .object({
    version: z.literal(1),
    title: requiredDisplayText,
    description: displayText.optional(),
    xAxis: axisSchema,
    yAxis: axisSchema,
    showGrid: z.boolean().default(true),
    parameters: z.array(parameterSchema).max(4).default([]),
    series: z.array(seriesSchema).min(1).max(4),
    points: z.array(pointSchema).max(12).default([]),
  })
  .strict()
  .superRefine((graph, ctx) => {
    const ids = new Set<string>();
    const reserved = new Set(["x", "PI", "E", ...allowedExpressionNames]);
    for (const [index, parameter] of graph.parameters.entries()) {
      if (reserved.has(parameter.id) || ids.has(parameter.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["parameters", index, "id"],
          message:
            "Parameter IDs must be unique and cannot shadow x, PI, E or a function name",
        });
      }
      ids.add(parameter.id);
    }

    const allowedNames = new Set([...allowedExpressionNames, ...ids]);
    graph.series.forEach((series, index) => {
      const identifiers = series.expression.match(
        /(?<![0-9.])[A-Za-z_][A-Za-z0-9_]*/g,
      );
      const unsupported = identifiers?.find((name) => !allowedNames.has(name));
      if (unsupported) {
        ctx.addIssue({
          code: "custom",
          path: ["series", index, "expression"],
          message: `Unsupported expression identifier: ${unsupported}`,
        });
      }
    });
  });

export type InteractiveGraphSpec = z.infer<typeof interactiveGraphSchema>;

export interface InteractiveGraphBlock {
  raw: string;
  spec: InteractiveGraphSpec | null;
  error?: string;
}

const GRAPH_FENCE =
  /^```interactive-graph[^\S\r\n]*\r?\n([\s\S]*?)^[\t ]*```[\t ]*\r?$/gm;

export function extractInteractiveGraphBlocks(content: string): InteractiveGraphBlock[] {
  return [...content.matchAll(GRAPH_FENCE)].map((match) => {
    const raw = match[1]?.trim() ?? "";
    try {
      const parsed = interactiveGraphSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return { raw, spec: parsed.data };
      return { raw, spec: null, error: parsed.error.issues[0]?.message };
    } catch {
      return { raw, spec: null, error: "Invalid JSON" };
    }
  });
}

export const INTERACTIVE_GRAPH_PROMPT = `
## Interaktiva grafer

- När användarens senaste meddelande ber dig rita, plotta eller visa en graf MÅSTE svaret innehålla exakt ett kodblock märkt \`\`\`interactive-graph. Detta gäller även korta uppmaningar som "rita grafen", "plotta den" och "visa grafen".
- Ersätt aldrig en efterfrågad graf med en ASCII-skiss, ett textdiagram eller enbart en beskrivning. Om användaren uttryckligen ber om en statisk skiss kan du däremot följa det önskemålet.
- När ingen graf uttryckligen efterfrågas får du lägga till ett grafblock om det tydligt förbättrar en matematisk eller statistisk förklaring.
- Skriv en kort förklaring i vanlig Markdown och lägg grafblocket efter den relevanta texten. Visa aldrig JSON-formatet som vanlig kod för användaren.
- Grafblocket ska endast innehålla giltig JSON enligt formatet nedan. Inga kommentarer, Markdown, avslutande kommatecken eller körbar JavaScript får förekomma.
- Anpassa titel, beskrivning och etiketter till språket i användarens senaste meddelande.
- Håll titel och etiketter korta. Lägg längre förklaringar i vanlig Markdown utanför grafblocket.
- Använd parametrar när användaren tjänar på att kunna experimentera med koefficienter, medelvärde, standardavvikelse, sannolikhet eller liknande.
- Använd högst fyra parametrar och fyra kurvor. Välj axelintervall så att det viktiga området syns.
- Uttryck får endast använda x, parameter-ID:n, talen PI och E, operatorerna + - * / ^, parenteser och funktionerna sin, cos, tan, asin, acos, atan, sinh, cosh, tanh, sqrt, log, ln, lg, log10, abs, ceil, floor, round, trunc, exp, cbrt, expm1, log1p, sign och log2.
- Parameter-ID får bara innehålla bokstäver (a-z, A-Z), siffror och understreck, måste börja med en bokstav och får inte vara x, PI, E eller ett funktionsnamn som sin eller log. Använd exakt samma ID i expression som i parameterlistan – det är skiftlägeskänsligt.
- Skriv explicit multiplikation: 2*x, inte 2x. Använd kalkylatorsyntax, aldrig LaTeX, i expression.
- För normalfördelningen kan du exempelvis använda expression \"1/(sigma*sqrt(2*PI))*exp(-0.5*((x-mu)/sigma)^2)\" med parametrarna mu och sigma.
- Om ingen graf behövs, svara som vanligt utan ett grafblock.

Format:
\`\`\`interactive-graph
{
  "version": 1,
  "title": "Påverkbar andragradsfunktion",
  "description": "Ändra koefficienterna och undersök hur kurvan flyttas.",
  "xAxis": { "min": -6, "max": 6, "label": "x" },
  "yAxis": { "min": -8, "max": 12, "label": "f(x)" },
  "showGrid": true,
  "parameters": [
    { "id": "a", "label": "a", "min": -3, "max": 3, "step": 0.1, "initial": 1 }
  ],
  "series": [
    { "label": "f(x)", "expression": "a*x^2", "style": "solid" }
  ],
  "points": []
}
\`\`\`
`;
