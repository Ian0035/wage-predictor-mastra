import { Agent } from "@mastra/core/agent";
import { z } from "zod";

// -----------------------------------------
// Define the expected output structure
// -----------------------------------------
export const WageDataSchema = z.object({
  age: z.number().optional().describe("The person's age."),
  years_experience: z.number().optional().describe("Total years of professional experience."),
  education: z.enum(["High School", "Bachelors", "Masters", "PhD", "Other"]).optional(),
  country: z.string().optional().describe("The country of residence."),
  industry: z.string().optional().describe("The industry they work in."),
  missingFields: z.array(z.string()).describe("A list of fields from the schema that were not found in the text."),
});

// -----------------------------------------
// Create the Agent Instance
// -----------------------------------------
export const wageExtractorAgent = new Agent({
  name: "wage-extractor-agent",
  // Instructions define its personality and task
  instructions: [
    { role: "system", content: "You are an expert data extraction agent for salary prediction models. Your sole purpose is to parse user text and extract the required structured data." },
    { role: "system", content: "Always use the provided JSON schema to format your output. If information is missing, add the field name to the 'missingFields' array." },
  ],
  // Use a capable model (like Groq, assuming the provider is configured via env)
  model: "groq/llama-3.3-70b-versatile", 
});