import { Mastra } from "@mastra/core/mastra";
import { wageExtractorAgent } from "./agents/wage-extractor-agent";
import { translatorAgent } from "./agents/translator-agent";
import { wagePredictionWorkflow } from "./workflows/wageprediction-workflow";

export const mastra = new Mastra({
  workflows: { wagePredictionWorkflow },
  // Register the agent instance
  agents: { wageExtractorAgent, translatorAgent }, 
});