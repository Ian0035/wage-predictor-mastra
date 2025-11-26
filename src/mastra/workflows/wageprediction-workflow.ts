import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

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

const LLMExtractionSchema = z
  .object({
    ...WageDataSchema.shape,
    missingFields: z.array(z.string()),
    nextQuestion: z.string().nullable(),
  })
  .partial()
  .catchall(z.any());

/* ---------------------------------------------------------------------------
 * STEP 1 — CAPTURE USER INPUT & EXISTING CONVERSATION STATE & TRANSLATE IF NEEDED
 * ---------------------------------------------------------------------------
 */
const captureInput = createStep({
  id: "capture-input",
  inputSchema: z.object({
    text: z.string(),
    existingData: z.any().optional(),
  }),
  outputSchema: z.object({
    userText: z.string(),
    language: z.string(),
    existingData: z.any(),
  }),
  execute: async ({ inputData, mastra }) => {
    const agent = mastra.getAgent("translatorAgent");

    const prompt = `
Detect the language of the following text:
"${inputData.text}"

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
      parsed = { language: "en", translated: inputData.text };
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
 * ---------------------------------------------------------------------------
 */
const extractInfo = createStep({
  id: "extract-info",
  inputSchema: z.object({
    userText: z.string(),
    language: z.string(),
    existingData: z.any(),
  }),
  outputSchema: z.object({
    extraction: LLMExtractionSchema,
    language: z.string(),
  }),
  execute: async ({ inputData, mastra }: any) => {
    const agent = mastra.getAgent("wageExtractorAgent");
    const contextString = JSON.stringify(inputData.existingData, null, 2);

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
      const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/);
      let jsonString =
        jsonMatch && jsonMatch[1] ? jsonMatch[1].trim() : responseText.trim();

      const rawParsed = JSON.parse(jsonString);

      parsedData = LLMExtractionSchema.parse(rawParsed);
    } catch (err) {
      console.error("Parse/Validation error:", responseText, err);
      parsedData = {
        error: "JSON_PARSE_OR_VALIDATION_FAILED",
        raw: responseText,
      };
    }

    return { extraction: parsedData, language: inputData.language };
  },
});

/* ---------------------------------------------------------------------------
 * STEP 3 — CHECK FOR MISSING FIELDS & HANDLE PARSE ERRORS
 * ---------------------------------------------------------------------------
 */
const checkMissingData = createStep({
  id: "check-missing-data",
  inputSchema: z.object({
    extraction: LLMExtractionSchema,
    language: z.string(),
  }),
  outputSchema: z.object({
    readyForPrediction: z.boolean(),
    missingFields: z.array(z.string()),
    nextQuestion: z.string().nullable(),
    structuredData: z.any(),
    language: z.string(),
  }),
  execute: async ({ inputData }) => {
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

    const extraction = inputData.extraction as z.infer<
      typeof LLMExtractionSchema
    >;
    const missing = extraction.missingFields || [];

    return {
      readyForPrediction: missing.length === 0,
      missingFields: missing,
      nextQuestion: extraction.nextQuestion ?? null,
      structuredData: extraction,
      language: inputData.language,
    };
  },
});

/* ---------------------------------------------------------------------------
 * STEP 3.5 — STANDARDIZE/CLEAN DATA
 * ---------------------------------------------------------------------------
 */
const standardizeData = createStep({
  id: "standardize-data",
  inputSchema: z.object({
    readyForPrediction: z.boolean(),
    structuredData: z.any(),
    nextQuestion: z.string().nullable(),
    missingFields: z.array(z.string()),
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
    if (!inputData.readyForPrediction) {
      return {
        readyForPrediction: false,
        cleanData: inputData.structuredData,
        nextQuestion: inputData.nextQuestion,
        missingFields: inputData.missingFields,
        language: inputData.language,
      };
    }

    const sd = inputData.structuredData;

    const cleanData = {
      ...sd,
      age: sd.age?.trim() ?? null,
      years_experience: sd.years_experience?.trim() ?? null,
      education: sd.education?.trim() ?? null,
      gender: sd.gender?.trim() ?? null,
      country: sd.country?.trim() ?? null,
      industry: sd.industry?.trim() ?? null,
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
 * ---------------------------------------------------------------------------
 */
const predictWage = createStep({
  id: "predict-wage",
  inputSchema: z.object({
    readyForPrediction: z.boolean(),
    cleanData: z.any(),
    nextQuestion: z.string().nullable(),
    missingFields: z.array(z.string()),
    language: z.string(),
  }),
  outputSchema: z.object({
    status: z.string(),
    message: z.string(),
    predictedWage: z.number().optional(),
    structuredData: z.any().optional(),
    language: z.string(),
  }),
  execute: async ({ inputData, mastra }) => {
    if (!inputData.readyForPrediction) {
      return {
        status: "need_more_info",
        message: inputData.nextQuestion ?? "More information required.",
        structuredData: inputData.cleanData,
        language: inputData.language,
      };
    }

    const sd = inputData.cleanData;

    const payload = {
      age: sd.age,
      years_experience: sd.years_experience,
      education: sd.education,
      gender: sd.gender,
      country: sd.country,
      industry: sd.industry,
    };

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

      let message = `Your predicted wage is $${predictedWage.toFixed(2)} per year.`;

      if (inputData.language && inputData.language.toLowerCase() !== "en") {
        try {
          const agent = mastra.getAgent("translatorAgent");
          const translationPrompt = `
Translate the following message into the language with ISO code "${inputData.language}":
"${message}"

Return ONLY the translated sentence with no extra text.
        `;

          const translationResp = await agent.generate([
            { role: "user", content: translationPrompt },
          ]);

          const translated = translationResp.text.trim();
          if (translated) message = translated;
        } catch (err) {
          console.error("Translation failed, falling back to English message.");
        }
      }

      return {
        status: "success",
        predictedWage,
        message,
        structuredData: sd,
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
 * STEP 5 — LLM EXPLANATION OF THE PREDICTION
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
    if (inputData.status !== "success") {
      return { explanation: "", keyFactors: [], language: inputData.language };
    }

    const agent = mastra.getAgent("wageExtractorAgent");
    const sd = inputData.structuredData || {};

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

Provide the response in the following language that correlates to this language code: ${inputData.language}
`;

    const response = await agent.generate([{ role: "user", content: prompt }]);

    const text = response.text || "";

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
 * ---------------------------------------------------------------------------
 */
export const wagePredictionWorkflow = createWorkflow({
  id: "wage-prediction-workflow",
  inputSchema: z.object({
    text: z.string(),
    existingData: z.any().optional(),
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
  .then(extractInfo)
  .then(checkMissingData)
  .then(standardizeData)
  .then(predictWage)
  .then(explainPrediction)
  .commit();
