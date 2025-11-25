import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

// NOTE: You would typically define a Zod schema matching the LLM output 
// for structured data validation here, but we'll use z.any() for simplicity 
// since the LLM output is dictated by the agent's string instructions.

// -----------------------------------------
// STEP 1 — CAPTURE INPUT & STATE
// -----------------------------------------
const captureInput = createStep({
  id: "capture-input",
  inputSchema: z.object({
    text: z.string(),
    currentState: z.any().optional(), 
  }),
  outputSchema: z.object({
    userText: z.string(),
    existingData: z.any(), 
  }),
  execute: async ({ inputData }) => {
    return { 
      userText: inputData.text,
      existingData: inputData.currentState || {}, 
    };
  },
});

// -----------------------------------------
// STEP 2 — EXTRACT STRUCTURED DATA USING LLM
// -----------------------------------------
const extractInfo = createStep({
  id: "extract-info",
  inputSchema: z.object({
    userText: z.string(),
    existingData: z.any(),
  }),
  outputSchema: z.object({
    extraction: z.any(),
  }),
  execute: async ({ inputData, mastra }: any) => {
    const agent = mastra.getAgent("wageExtractorAgent");
    const contextString = JSON.stringify(inputData.existingData, null, 2);
    
    // The instruction to merge is added here in the user prompt
    const userPrompt = `
CURRENT STATE (Known Data): ${contextString}

NEW USER INPUT: ${inputData.userText}

Using the system instructions provided to you, merge the new input with the CURRENT STATE and return the complete, required JSON object.
`;

    const response = await agent.generate([
      { role: "user", content: userPrompt },
    ]);

    let parsed;
    const responseText = response.text || JSON.stringify(response);

    try {
        // Robust JSON extraction logic (as discussed previously)
        const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/);
        let jsonString = (jsonMatch && jsonMatch[1]) ? jsonMatch[1].trim() : responseText.trim();
        
        parsed = JSON.parse(jsonString);
    } catch (err) {
        console.error('Parse error:', responseText);
        parsed = { error: 'JSON_PARSE_FAILED', raw: responseText };
    }

    return { extraction: parsed };
  },
});

// -----------------------------------------
// STEP 3 — CHECK FOR MISSING FIELDS & ERROR HANDLE
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
    // Handle JSON parsing failures
    if (inputData.extraction.error) {
        return {
            readyForPrediction: false,
            nextQuestion: "Sorry, I had trouble understanding that. Please restate your information.", 
            missingFields: ['data_quality'],
            structuredData: inputData.extraction,
        };
    }

    // Normal missing data check
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
// STEP 4 — CALL THE WAGE PREDICTION API (Axios replaced with fetch)
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
    message: z.string(),
    predictedWage: z.number().optional(),
  }),
  execute: async ({ inputData }) => {
    if (!inputData.readyForPrediction) {
      return {
        status: "need_more_info",
        message: inputData.nextQuestion ?? 'More information required.', 
      };
    }

    const sd = inputData.structuredData;
    // NOTE: Keys must exactly match the external API:
    const payload = {
          age: sd.age,
          // 🛑 FIX: Use the external API's key name ("experienceYears") 
          // while referencing the LLM's data key (sd.years_experience)
          experienceYears: sd.years_experience, 
          education: sd.education,
          gender: sd.gender,
          country: sd.country,
          industry: sd.industry,
        };

    try {
        // Use native fetch instead of axios in Mastra environment
        const response = await fetch(
          "https://plumber-api-2-latest.onrender.com/predict",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            // Timeout is handled here if necessary
          }
        );

        if (!response.ok) {
            // Read the full response details for debugging
            const errorText = await response.text(); 
            console.error(`Prediction API failed with status ${response.status}. Response Body: ${errorText}`);
            console.error('Payload sent:', JSON.stringify(payload));
             throw new Error(`External API Error: ${response.status}`);
        }

        const data = await response.json();

        const predictedWage = Array.isArray(data.predictedWage) ? data.predictedWage[0] : data.predictedWage;

        return {
          status: "success",
          predictedWage: predictedWage,
          message: `Your predicted wage is $${predictedWage.toFixed(2)} per year.`,
        };
    } catch (error: any) {
        // Log the full error to your Mastra console
        console.error('Prediction API Failed:', error.message || error); 
        
        return {
            status: "error",
            // Keep the user-friendly message, but the console will show the real error
            message: "Sorry, the wage prediction service is currently unavailable.", 
        };
    }
  },
});

// -----------------------------------------
// FINAL WORKFLOW
// -----------------------------------------
export const wagePredictionWorkflow = createWorkflow({
  id: "wage-prediction-workflow",
  inputSchema: z.object({
    text: z.string(),
    currentState: z.any().optional(),
  }),
  outputSchema: z.object({
    status: z.string(),
    message: z.string(), 
    predictedWage: z.number().optional(),
    // NOTE: You need to return the structuredData here so the client can send it back 
    // on the next turn via currentState
    structuredData: z.any().optional(), 
}),
})
  .then(captureInput)
  .then(extractInfo)
  .then(checkMissingData)
  .then(predictWage)
  .commit();