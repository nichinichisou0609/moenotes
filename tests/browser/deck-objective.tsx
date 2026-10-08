import { useState } from "react";
import { createRoot } from "react-dom/client";
import DeckObjective from "../../src/components/deck/DeckObjective";
import DeckGoalConditions from "../../src/components/deck/DeckGoalConditions";
import { computesSelectedObjective, defaultDeckGoalInput, effectiveAggregation, goalGap, parseCapabilities, recommendationRequest,
  type DeckEvent, type DeckGoalInput, type DeckSolverCapabilities } from "../../src/lib/deck/goals";
import { parseDeckAnswer } from "../../src/lib/deck/answer";
import { DeckWorkerClient } from "../../src/lib/deck/worker-client";
import type { DeckSolverRuntime } from "../../src/lib/deck/runtime-source";

interface Bootstrap { runtime: DeckSolverRuntime; accountJson: string; event: DeckEvent; input: Partial<DeckGoalInput> }
declare global { interface Window { deckBootstrap: Bootstrap; deckTest: {
  input: DeckGoalInput; effective: DeckGoalInput; request: string; canRun: boolean; capabilities: DeckSolverCapabilities | null;
  setEngine: (state: "ready" | "loading" | "unsupported") => void;
  run: () => Promise<ReturnType<typeof parseDeckAnswer>>;
} } }
const bootstrap = window.deckBootstrap;
const worker = new DeckWorkerClient();
const ready = await worker.prepare(bootstrap.runtime);
if (ready.status !== "ready") throw new Error(`Worker initialization: ${JSON.stringify(ready)}`);
const capabilities = parseCapabilities(ready.capabilitiesJson);
let revision = 0;
function TestSurface() {
  const [input, setInput] = useState<DeckGoalInput>({ ...defaultDeckGoalInput("free"), ...bootstrap.input });
  const [engine, setEngine] = useState<"ready" | "loading" | "unsupported">("ready");
  const selectedCapabilities = engine === "loading" ? null : engine === "unsupported" && capabilities
    ? { ...capabilities, aggregations: { ...capabilities.aggregations, maximum: {} } } : capabilities;
  const effective = { ...input, aggregation: effectiveAggregation(input) };
  const request = recommendationRequest(effective, { event: bootstrap.event, now: Date.parse("2030-01-05T00:00:00Z"),
    constraints: { includeMembers: ["1"], excludeMembers: ["6"], excludeSnaps: ["1"] } });
  const canRun = engine === "ready" && computesSelectedObjective(selectedCapabilities, effective) && !goalGap(effective, bootstrap.event);
  window.deckTest = { input, effective, request, canRun, capabilities: selectedCapabilities, setEngine,
    run: async () => {
      if (!canRun) throw new Error("Search is blocked for the selected objective");
      const inputRevision = ++revision;
      const result = await worker.run({ runtime: bootstrap.runtime, accountJson: bootstrap.accountJson, requestJson: request,
        jobId: `browser:${inputRevision}`, inputRevision, progressIntervalMs: 0 });
      if (result.status !== "complete") throw new Error(JSON.stringify(result));
      return parseDeckAnswer(result.resultJson);
    } };
  return <main>
    <label>Test scene<select aria-label="Test scene" value={input.goal} onChange={e => setInput(previous => ({ ...previous, goal: e.target.value as DeckGoalInput["goal"] }))}>
      {["free", "challenge", "battle", "mission", "arena"].map(goal => <option key={goal}>{goal}</option>)}
    </select></label>
    <DeckObjective locale="en-US" input={effective} capabilities={selectedCapabilities} onChange={aggregation => setInput(previous => ({ ...previous, aggregation }))} />
    <DeckGoalConditions locale="en-US" input={effective} event={bootstrap.event} capabilities={selectedCapabilities} onChange={patch => setInput(previous => ({ ...previous, ...patch }))} />
    <button type="button" disabled={!canRun} onClick={() => void window.deckTest.run()}>Search</button>
  </main>;
}
createRoot(document.getElementById("root")!).render(<TestSurface />);
