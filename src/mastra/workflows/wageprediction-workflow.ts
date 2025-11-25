import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

// -----------------------------------------
// STEP 1 — CAPTURE USER INPUT
// -----------------------------------------
const captureInput = createStep({
  id: "capture-input",
  inputSchema: z.object({
    text: z.string(),
  }),
  outputSchema: z.object({
    userText: z.string(),
  }),
  execute: async ({ inputData }) => {
    return { userText: inputData.text };
  },
});

// -----------------------------------------
// STEP 2 — EXTRACT STRUCTURED DATA USING LLM
// -----------------------------------------
const extractInfo = createStep({
  id: "extract-info",
  inputSchema: z.object({
    userText: z.string(),
  }),
  outputSchema: z.object({
    extraction: z.any(), // we accept raw JSON from model
  }),
  execute: async ({ inputData, agents }: any) => {
    const systemPrompt = `
You are an AI assistant that extracts and normalizes user data for a wage prediction model.
Return a JSON object with age, years_experience, education, gender, country, industry,
missingFields (array), and nextQuestion (string).
Always return strictly valid JSON.
`;

    // Use Mastra's default LLM agent (you can configure in mastra.config.ts)
    const response = await agents.llm.chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: inputData.userText },
    ]);

    let parsed;

    try {
      parsed = JSON.parse(response.message);
    } catch (err) {
      parsed = { error: "Invalid model output", raw: response.message };
    }

    return { extraction: parsed };
  },
});

// -----------------------------------------
// STEP 3 — CHECK FOR MISSING FIELDS
// -----------------------------------------
const checkMissingData = createStep({
  id: "check-missing-data",
  inputSchema: z.object({
    extraction: z.any(),
  }),
  outputSchema: z.object({
    readyForPrediction: z.boolean(),
    missingFields: z.array(z.string()),
    nextQuestion: z.string().nullable(),
    structuredData: z.any(),
  }),
  execute: async ({ inputData }) => {
    const missing = inputData.extraction.missingFields || [];

    return {
      readyForPrediction: missing.length === 0,
      missingFields: missing,
      nextQuestion: inputData.extraction.nextQuestion ?? null,
      structuredData: inputData.extraction,
    };
  },
});

// -----------------------------------------
// STEP 4 — CALL THE WAGE PREDICTION API
// -----------------------------------------
const predictWage = createStep({
  id: "predict-wage",
  inputSchema: z.object({
    readyForPrediction: z.boolean(),
    structuredData: z.any(),
    nextQuestion: z.string().nullable(),
    missingFields: z.array(z.string()),
  }),
  outputSchema: z.object({
    status: z.string(),
    predictedWage: z.number().optional(),
    nextQuestion: z.string().optional(),
    missingFields: z.array(z.string()).optional(),
  }),
  execute: async ({ inputData }) => {
    if (!inputData.readyForPrediction) {
      return {
        status: "need_more_info",
        missingFields: inputData.missingFields,
        nextQuestion: inputData.nextQuestion ?? undefined,
      };
    }

    const sd = inputData.structuredData;

    const payload = {
      age: sd.age,
      experienceYears: sd.years_experience,
      education: sd.education,
      gender: sd.gender,
      country: sd.country,
      industry: sd.industry,
    };

    const response = await fetch(
      "https://plumber-api-2-latest.onrender.com/predict",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

    const data = await response.json();

    return {
      status: "success",
      predictedWage: data.predictedWage,
    };
  },
});

// -----------------------------------------
// FINAL WORKFLOW
// -----------------------------------------
export const wagePredictionWorkflow = createWorkflow({
  id: "wage-prediction-workflow",
  inputSchema: z.object({
    text: z.string(),
  }),
  outputSchema: z.object({
    status: z.string(),
    predictedWage: z.number().optional(),
    nextQuestion: z.string().optional(),
    missingFields: z.array(z.string()).optional(),
  }),
})
  .then(captureInput)
  .then(extractInfo)
  .then(checkMissingData)
  .then(predictWage)
  .commit();
