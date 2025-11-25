import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

/**
 * NOTE:
 * A Zod schema could be built to perfectly validate the structured LLM output,
 * but because the agent’s output is determined by system instructions,
 * we use z.any() in this workflow.
 *
 * The purpose of the workflow is to:
 *  1. Capture user input + prior conversation state
 *  2. Use an LLM to extract normalized structured fields
 *  3. Validate which fields are missing
 *  4. Call an external wage prediction API
 *  5. Optionally ask the LLM to explain the output
 */


/* ---------------------------------------------------------------------------
 * STEP 1 — CAPTURE USER INPUT & EXISTING CONVERSATION STATE
 * ---------------------------------------------------------------------------
 * This step simply forwards:
 *   - user text
 *   - previously collected structured data
 *
 * The workflow expects the client to always send `currentState`,
 * which represents partial structured data from earlier turns.
 */
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
      // If no currentState exists, initialize with empty object
      existingData: inputData.currentState || {},
    };
  },
});


/* ---------------------------------------------------------------------------
 * STEP 2 — USE LLM (wageExtractorAgent) TO EXTRACT + MERGE STRUCTURED DATA
 * ---------------------------------------------------------------------------
 * The LLM receives:
 *    - full current known structured data (context)
 *    - new user free text
 *
 * The agent is instructed to:
 *   - merge new info with known state
 *   - return a complete JSON object
 *
 * We then attempt to parse the JSON using a robust extractor.
 */
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

    // Construct user prompt for the LLM
    const userPrompt = `
CURRENT STATE (Known Data): ${contextString}

NEW USER INPUT: ${inputData.userText}

Using the system instructions provided to you, merge the new input with the CURRENT STATE and return the complete, required JSON object.
`;

    // Run the agent
    const response = await agent.generate([
      { role: "user", content: userPrompt },
    ]);

    let parsed;
    const responseText = response.text || JSON.stringify(response);

    try {
      /**
       * Attempt to safely extract JSON.
       * The model may wrap JSON inside ```json fences.
       */
      const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/);
      let jsonString =
        jsonMatch && jsonMatch[1] ? jsonMatch[1].trim() : responseText.trim();

      parsed = JSON.parse(jsonString);
    } catch (err) {
      // JSON parsing failed — return fallback diagnostic data
      console.error("Parse error:", responseText);
      parsed = { error: "JSON_PARSE_FAILED", raw: responseText };
    }

    return { extraction: parsed };
  },
});


/* ---------------------------------------------------------------------------
 * STEP 3 — CHECK FOR MISSING FIELDS & HANDLE PARSE ERRORS
 * ---------------------------------------------------------------------------
 * This step:
 *   - identifies fields still missing (as reported by the LLM)
 *   - determines whether we can proceed to prediction or need more info
 *   - returns a next question for the user if incomplete
 *
 * It also handles JSON parse failures from the previous step.
 */
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
    // Handle earlier LLM JSON parse failure
    if (inputData.extraction.error) {
      return {
        readyForPrediction: false,
        nextQuestion:
          "Sorry, I had trouble understanding that. Please restate your information.",
        missingFields: ["data_quality"],
        structuredData: inputData.extraction,
      };
    }

    // Normal path — the LLM should include missingFields in its output
    const missing = inputData.extraction.missingFields || [];

    return {
      readyForPrediction: missing.length === 0,
      missingFields: missing,
      nextQuestion: inputData.extraction.nextQuestion ?? null,
      structuredData: inputData.extraction,
    };
  },
});


/* ---------------------------------------------------------------------------
 * STEP 4 — CALL EXTERNAL WAGE PREDICTION API
 * ---------------------------------------------------------------------------
 * If all required fields are available, we build a payload and call the
 * wage prediction API. Errors are caught and returned as user-friendly messages.
 */
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
    // If fields are missing, return a question back to the user
    if (!inputData.readyForPrediction) {
      return {
        status: "need_more_info",
        message: inputData.nextQuestion ?? "More information required.",
      };
    }

    const sd = inputData.structuredData;

    /**
     * NOTE: Payload must match the API exactly.
     * If the LLM uses different labels internally, map them here.
     */
    const payload = {
      age: sd.age,
      years_experience: sd.years_experience, // Ensure key matches API
      education: sd.education,
      gender: sd.gender,
      country: sd.country,
      industry: sd.industry,
    };

    try {
      // Use fetch to call the external API
      const response = await fetch(
        "https://plumber-api-2-latest.onrender.com/predict",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );

      if (!response.ok) {
        // Log full context for debugging
        const errorText = await response.text();
        console.error(
          `Prediction API failed with status ${response.status}. Response Body: ${errorText}`
        );
        console.error("Payload sent:", JSON.stringify(payload));
        throw new Error(`External API Error: ${response.status}`);
      }

      const data = await response.json();

      // API may return an array — handle both cases
      const predictedWage = Array.isArray(data.predictedWage)
        ? data.predictedWage[0]
        : data.predictedWage;

      return {
        status: "success",
        predictedWage,
        message: `Your predicted wage is $${predictedWage.toFixed(2)} per year.`,
      };
    } catch (error: any) {
      // Log error internally, return friendly response
      console.error("Prediction API Failed:", error.message || error);

      return {
        status: "error",
        message: "Sorry, the wage prediction service is currently unavailable.",
      };
    }
  },
});


/* ---------------------------------------------------------------------------
 * STEP 5 — OPTIONAL LLM EXPLANATION OF THE PREDICTION
 * ---------------------------------------------------------------------------
 * This step uses the LLM to:
 *   • summarize why the wage makes sense
 *   • identify factors that influenced the prediction
 *
 * Only runs if Step 4 returned success.
 */
const explainPrediction = createStep({
  id: "explain-prediction",
  inputSchema: z.object({
    status: z.string(),
    message: z.string(),
    predictedWage: z.number().optional(),
    structuredData: z.any().optional(),
  }),
  outputSchema: z.object({
    explanation: z.string(),
    keyFactors: z.array(z.string()),
  }),
  execute: async ({ inputData, mastra }) => {
    // If wage was not predicted, skip explanation
    if (inputData.status !== "success") {
      return { explanation: "", keyFactors: [] };
    }

    const agent = mastra.getAgent("wageExtractorAgent");

    const sd = inputData.structuredData || {};

    // Build explanation prompt
    const prompt = `
Given this profile:
- Age: ${sd.age ?? "N/A"}
- Experience: ${sd.years_experience ?? "N/A"}
- Education: ${sd.education ?? "N/A"}
- Industry: ${sd.industry ?? "N/A"}
- Country: ${sd.country ?? "N/A"}
- Gender: ${sd.gender ?? "N/A"}

Predicted Annual Wage: $${inputData.predictedWage ?? "N/A"}

Explain in 2-3 sentences why this prediction makes sense. Then list the top 3 factors that most influenced this wage.

Format your response as:
EXPLANATION: [your explanation]
FACTORS:
1. [factor 1]
2. [factor 2]
3. [factor 3]
`;

    const response = await agent.generate([
      { role: "user", content: prompt },
    ]);

    const text = response.text || "";

    // Extract explanation + three factors
    const explanationMatch = text.match(/EXPLANATION:\s*(.+?)(?=FACTORS:|$)/s);
    const factorsMatch = text.match(/FACTORS:\s*([\s\S]+)/);

    const explanation = explanationMatch ? explanationMatch[1].trim() : text;

    const keyFactors = (factorsMatch?.[1] || "")
      .split("\n")
      .filter((line) => line.trim().match(/^\d+\./))
      .map((line) => line.replace(/^\d+\.\s*/, "").trim())
      .slice(0, 3);

    return {
      explanation,
      keyFactors:
        keyFactors.length > 0
          ? keyFactors
          : [
              "Industry standards and demand",
              "Years of experience",
              "Educational background",
            ],
    };
  },
});


/* ---------------------------------------------------------------------------
 * FINAL WORKFLOW — Orchestrates All Steps
 * ---------------------------------------------------------------------------
 * This workflow:
 *   1. Captures input + state
 *   2. Extracts structured data using LLM
 *   3. Checks missing fields
 *   4. Predicts wage (if complete)
 *   5. Explains prediction (if successful)
 *
 * The output includes structuredData so the client can send it back
 * on the next turn — enabling multi-turn interaction.
 */
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
    structuredData: z.any().optional(),  // Required for multi-turn state passing
    explanation: z.string().optional(),
    keyFactors: z.array(z.string()).optional(),
  }),
})
  .then(captureInput)
  .then(extractInfo)
  .then(checkMissingData)
  .then(predictWage)
  .then(explainPrediction)
  .commit();
