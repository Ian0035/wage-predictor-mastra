import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

// NOTE: We define a Zod schema for the expected LLM output for reliability.

/**
 * Core fields the prediction API needs. Nullable as the LLM might not find them.
 */
const WageDataSchema = z.object({
    age: z.string().nullable(),
    years_experience: z.string().nullable(),
    education: z.string().nullable(),
    gender: z.string().nullable(),
    country: z.string().nullable(),
    industry: z.string().nullable(),
});

/**
 * The full structure expected from the LLM (includes core data + control fields).
 * We make it partial with catchall for maximum parsing resilience.
 */
const LLMExtractionSchema = z.object({
    ...WageDataSchema.shape,
    missingFields: z.array(z.string()),
    nextQuestion: z.string().nullable(),
}).partial().catchall(z.any()); // Partial + Catchall for max resilience during parsing


/* ---------------------------------------------------------------------------
 * STEP 1 — CAPTURE USER INPUT & EXISTING CONVERSATION STATE
 * (No changes here, remains the same)
 * ---------------------------------------------------------------------------
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
            existingData: inputData.currentState || {},
        };
    },
});


const translateInput = createStep({
  id: "translate-input",
  inputSchema: z.object({
    userText: z.string(),
    existingData: z.any(),
  }),
  outputSchema: z.object({
    userText: z.string(),      // translated to English
    language: z.string(),      // detected language of original input
    existingData: z.any(),
  }),

  execute: async ({ inputData, mastra }) => {
    const agent = mastra.getAgent("wageExtractorAgent");

    const prompt = `
Detect the language of the following text:
"${inputData.userText}"

Return JSON exactly like:
{
  "language": "<ISO-639 language code>",
  "translated": "<English translation OR original text if already English>"
}
    `;

    const resp = await agent.generate([{ role: "user", content: prompt }]);

    let parsed;
    try {
      const jsonMatch = resp.text.match(/```json\s*([\s\S]*?)```/);
      const txt = jsonMatch ? jsonMatch[1].trim() : resp.text.trim();
      parsed = JSON.parse(txt);
    } catch {
      parsed = { language: "en", translated: inputData.userText };
    }

    return {
      userText: parsed.translated,
      language: parsed.language,
      existingData: inputData.existingData,
    };
  },
});
/* ---------------------------------------------------------------------------
 * STEP 2 — USE LLM (wageExtractorAgent) TO EXTRACT + MERGE STRUCTURED DATA
 * NOTE: Updated to use Zod parsing for robust output handling.
 * ---------------------------------------------------------------------------
 */
const extractInfo = createStep({
    id: "extract-info",
    inputSchema: z.object({
        userText: z.string(),
        language: z.string(),
        existingData: z.any(),
    }),
    // Use the defined schema for the output
    outputSchema: z.object({
        extraction: LLMExtractionSchema,
        language: z.string(),
    }),
    execute: async ({ inputData, mastra }: any) => {
        const agent = mastra.getAgent("wageExtractorAgent");
        const contextString = JSON.stringify(inputData.existingData, null, 2);

        // ... (Prompt construction remains the same) ...
        const userPrompt = `
CURRENT STATE (Known Data): ${contextString}

NEW USER INPUT: ${inputData.userText}

Using the system instructions provided to you, merge the new input with the CURRENT STATE and return the complete, required JSON object.
`;

        const response = await agent.generate([
            { role: "user", content: userPrompt },
        ]);

        let parsedData: any = { error: "JSON_PARSE_FAILED", raw: response.text };
        const responseText = response.text || JSON.stringify(response);

        try {
            // Safely extract JSON from ```json fences
            const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/);
            let jsonString =
                jsonMatch && jsonMatch[1] ? jsonMatch[1].trim() : responseText.trim();

            const rawParsed = JSON.parse(jsonString);
            
            // --- NEW: Use Zod to validate and normalize the parsed JSON ---
            // If validation fails, the catch block handles the error
            parsedData = LLMExtractionSchema.parse(rawParsed);

        } catch (err) {
            console.error("Parse/Validation error:", responseText, err);
            // On failure, return a diagnostic object that checkMissingData can handle
            parsedData = { error: "JSON_PARSE_OR_VALIDATION_FAILED", raw: responseText };
        }

        return { extraction: parsedData, language: inputData.language};
    },
});


/* ---------------------------------------------------------------------------
 * STEP 3 — CHECK FOR MISSING FIELDS & HANDLE PARSE ERRORS
 * NOTE: Updated to expect the structure from LLMExtractionSchema.
 * ---------------------------------------------------------------------------
 */
const checkMissingData = createStep({
    id: "check-missing-data",
    inputSchema: z.object({
        extraction: LLMExtractionSchema, // Must match Step 2's output type
        language: z.string(),
    }),
    outputSchema: z.object({
        readyForPrediction: z.boolean(),
        missingFields: z.array(z.string()),
        nextQuestion: z.string().nullable(),
        structuredData: z.any(), // Still any for flexibility, but it follows the schema
        language: z.string(),
    }),
    execute: async ({ inputData }) => {
        // Handle earlier LLM JSON parse/validation failure
        if (inputData.extraction.error) {
            return {
                readyForPrediction: false,
                nextQuestion:
                    "Sorry, I had trouble understanding that. Please restate your information clearly.",
                missingFields: ["data_quality"],
                structuredData: inputData.extraction,
                language: inputData.language,
            };
        }

        // Normal path — use the data validated by Zod
        const extraction = inputData.extraction as z.infer<typeof LLMExtractionSchema>;
        const missing = extraction.missingFields || [];

        return {
            readyForPrediction: missing.length === 0,
            missingFields: missing,
            nextQuestion: extraction.nextQuestion ?? null,
            structuredData: extraction, // Pass the clean, validated extraction object
            language: inputData.language,
        };
    },
});


/* ---------------------------------------------------------------------------
 * STEP 3.5 — STANDARDIZE/CLEAN DATA (NEW STEP)
 * ---------------------------------------------------------------------------
 * This step cleans and standardizes the data before the API call,
 * demonstrating better pipeline hygiene and preparation for external systems.
 */
const standardizeData = createStep({
    id: "standardize-data",
    inputSchema: z.object({
        readyForPrediction: z.boolean(),
        structuredData: z.any(),
        nextQuestion: z.string().nullable(), // Pass through
        missingFields: z.array(z.string()), // Pass through
        language: z.string(),
    }),
    outputSchema: z.object({
        readyForPrediction: z.boolean(),
        cleanData: z.any(),
        nextQuestion: z.string().nullable(),
        missingFields: z.array(z.string()),
        language: z.string(),
    }),
    execute: async ({ inputData }) => {
        // If not ready, just pass everything through without cleaning
        if (!inputData.readyForPrediction) {
            return {
                readyForPrediction: false,
                cleanData: inputData.structuredData, // Passes partial data
                nextQuestion: inputData.nextQuestion,
                missingFields: inputData.missingFields,
                language: inputData.language,
            };
        }

        const sd = inputData.structuredData;

        // Example Standardization: Ensure key fields are trimmed/cased correctly
        const cleanData = {
            ...sd,
            // If the API expects specific casing for industry:
            industry: sd.industry?.trim(),
            country: sd.country?.trim(),
            // If the API uses different value names for 'education' than the LLM prompt:
            education: sd.education === "Some college/university study without earning a bachelor’s degree" 
                ? "Some College" 
                : sd.education,
        };

        return { 
            readyForPrediction: true, 
            cleanData,
            nextQuestion: inputData.nextQuestion,
            missingFields: inputData.missingFields,
            language: inputData.language,
        };
    },
});


/* ---------------------------------------------------------------------------
 * STEP 4 — CALL EXTERNAL WAGE PREDICTION API
 * NOTE: Updated to use 'cleanData' from the new Step 3.5.
 * ---------------------------------------------------------------------------
 */
const predictWage = createStep({
    id: "predict-wage",
    inputSchema: z.object({
        readyForPrediction: z.boolean(),
        cleanData: z.any(), // <-- Now uses the cleaned data
        nextQuestion: z.string().nullable(),
        missingFields: z.array(z.string()),
        language: z.string(),
    }),
    outputSchema: z.object({
        status: z.string(),
        message: z.string(),
        predictedWage: z.number().optional(),
        structuredData: z.any().optional(), // Now passes cleanData as structuredData
        language: z.string(),
    }),
    execute: async ({ inputData }) => {
        // If fields are missing (from Step 3.5), return a question back to the user
        if (!inputData.readyForPrediction) {
            return {
                status: "need_more_info",
                message: inputData.nextQuestion ?? "More information required.",
                structuredData: inputData.cleanData,  // Pass through partial/clean data
                language: inputData.language,
            };
        }

        const sd = inputData.cleanData; // Use clean data

        const payload = {
            age: sd.age,
            years_experience: sd.years_experience,
            education: sd.education,
            gender: sd.gender,
            country: sd.country,
            industry: sd.industry
        };

        // ... (Rest of the fetch/API logic remains the same) ...
        try {
            const response = await fetch(

              "https://plumber-api-2-latest.onrender.com/predict",

              {

                method: "POST",

                headers: { "Content-Type": "application/json" },

                body: JSON.stringify(payload),

              }

            );
            console.log("Payload sent to Prediction API:", JSON.stringify(payload));

            // ... (Error handling and JSON parsing remains the same) ...
            if (!response.ok) {
                const errorText = await response.text();
                console.error(
                    `Prediction API failed with status ${response.status}. Response Body: ${errorText}`
                );
                console.error("Payload sent:", JSON.stringify(payload));
                throw new Error(`External API Error: ${response.status}`);
            }

            const data = await response.json();

            const predictedWage = Array.isArray(data.predictedWage)
                ? data.predictedWage[0]
                : data.predictedWage;

            return {
                status: "success",
                predictedWage,
                message: `Your predicted wage is $${predictedWage.toFixed(2)} per year.`,
                structuredData: sd, // Pass clean data for the explanation step
                language: inputData.language,
            };
        } catch (error: any) {
            console.error("Prediction API Failed:", error.message || error);

            return {
                status: "error",
                message: "Sorry, the wage prediction service is currently unavailable.",
                structuredData: sd,
                language: inputData.language,
            };
        }
    },
});

/* ---------------------------------------------------------------------------
 * STEP 5 — OPTIONAL LLM EXPLANATION OF THE PREDICTION
 * (No changes needed, as it handles the 'status' being non-success)
 * ---------------------------------------------------------------------------
 */
const explainPrediction = createStep({
    id: "explain-prediction",
    inputSchema: z.object({
        status: z.string(),
        message: z.string(),
        predictedWage: z.number().optional(),
        structuredData: z.any().optional(),
        language: z.string(),
    }),
    outputSchema: z.object({
        explanation: z.string(),
        keyFactors: z.array(z.string()),
    }),
    execute: async ({ inputData, mastra }) => {
        // If wage was not predicted, skip explanation
        if (inputData.status !== "success") {
            return { explanation: "", keyFactors: [], language: inputData.language };
        }

        const agent = mastra.getAgent("wageExtractorAgent");
        const sd = inputData.structuredData || {};

        // ... (Rest of the explanation logic remains the same) ...
        const prompt = `
Given this profile:
- Age: ${sd.age ?? "N/A"}
- Experience: ${sd.years_experience ?? "N/A"}
- Education: ${sd.education ?? "N/A"}
- Industry: ${sd.industry ?? "N/A"}
- Country: ${sd.country ?? "N/A"}
- Gender: ${sd.gender ?? "N/A"}

Predicted Annual Wage: $${inputData.predictedWage ?? "N/A"}

Explain in 2-3 sentences why this prediction makes sense. Then list the top 3 factors that most influenced this wage in ${inputData.language}.

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
            language: inputData.language,
        };
    },
});



/* ---------------------------------------------------------------------------
 * FINAL WORKFLOW — Orchestrates All Steps
 * NOTE: Added standardizeData step.
 * ---------------------------------------------------------------------------
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
        structuredData: z.any().optional(),
        explanation: z.string().optional(),
        keyFactors: z.array(z.string()).optional(),
        language: z.string(),
    }),
})
    .then(captureInput)
    .then(translateInput)
    .then(extractInfo)
    .then(checkMissingData)
    .then(standardizeData) // <-- NEW STEP HERE
    .then(predictWage)
    .then(explainPrediction)
    .commit();