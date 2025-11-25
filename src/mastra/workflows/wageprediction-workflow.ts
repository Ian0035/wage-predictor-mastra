import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { WageDataSchema } from "../agents/wage-extractor-agent";

// -----------------------------------------
// STEP 1 — CAPTURE USER INPUT
// -----------------------------------------
// Add the input type to capture the existing state (optional)
const captureInput = createStep({
  id: "capture-input",
  inputSchema: z.object({
    text: z.string(),
    // This allows the workflow to receive the previous state on subsequent calls
    currentState: z.any().optional(), 
  }),
  outputSchema: z.object({
    userText: z.string(),
    // The previous state is carried forward
    existingData: z.any(), 
  }),
  execute: async ({ inputData }) => {
    return { 
        userText: inputData.text,
        // If currentState is provided, use it; otherwise, start with an empty object
        existingData: inputData.currentState || {}, 
    };
  },
});

// -----------------------------------------
// STEP 2 — EXTRACT STRUCTURED DATA USING LLM (Updated for Context)
// -----------------------------------------
const extractInfo = createStep({
  id: "extract-info",
  inputSchema: z.object({
    userText: z.string(),
    existingData: z.any(), // Now receives the existing state
  }),
  outputSchema: z.object({
    extraction: z.any(),
  }),
  execute: async ({ inputData, mastra }: any) => {
    const agent = mastra.getAgent("wageExtractorAgent");
    
    // 🛑 CONTEXT PROMPT: Give the agent all the data it knows so far.
    const contextString = JSON.stringify(inputData.existingData, null, 2);
    
    const systemPrompt = `
You are an AI assistant that extracts and normalizes user data for a wage prediction model.
The current known data state is: ${contextString}

The new user input is provided below. You must merge the new information with the known data and re-evaluate all required fields (age, education, gender, etc.).
Return a single, complete JSON object.
`;

    const response = await agent.generate([
      { role: "system", content: systemPrompt },
      { role: "user", content: inputData.userText }, // Only send the new text here
    ]);

    // Assuming the agent returns the text content in `response.text` as per docs
    let parsed;
    const responseText = response.text || JSON.stringify(response);

    try {
      // Clean up markdown code blocks if the LLM adds them
      const cleanJson = responseText.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(cleanJson);
    } catch (err) {
      parsed = { error: "Invalid model output", raw: responseText };
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
  // 🛑 CRITICAL CHANGE: Simplify the output schema to just return a message or the predicted wage.
  outputSchema: z.object({
    message: z.string(), // New field to hold either the question or the result
    predictedWage: z.number().optional(),
    status: z.string(), // Keep status
    // Remove missingFields and nextQuestion here as we are rolling them into 'message'
  }),

  execute: async ({ inputData }) => {
        if (!inputData.readyForPrediction) {
            return {
                status: "need_more_info",
                // 🛑 FIX: Use ?? '' to ensure the message is always a string.
                message: inputData.nextQuestion ?? 'More information required.', 
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
      message: `Your predicted wage is $${data.predictedWage.toFixed(2)} per year.` // 🛑 Return a prediction message
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
  // 🛑 CRITICAL CHANGE: Simplify the final output schema
  outputSchema: z.object({
    status: z.string(),
    message: z.string(), // New field for the conversational response
    predictedWage: z.number().optional(),
  }),
})
  .then(captureInput)
  .then(extractInfo)
  .then(checkMissingData)
  .then(predictWage)
  .commit();
