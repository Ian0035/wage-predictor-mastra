import { Mastra } from "@mastra/core/mastra";
import { wagePredictionWorkflow } from "./workflows/wageprediction-workflow";

export const mastra = new Mastra({
  workflows: { wagePredictionWorkflow },
  agents: {
    llm: {
      provider: "groq",
      model: "llama3-70b-8192", // or your preferred model
    } as any,
  },
});
