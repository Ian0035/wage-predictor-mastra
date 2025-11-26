import { Agent } from "@mastra/core/agent";

export const translatorAgent = new Agent({
  name: "translator-agent",
  model: "groq/llama-3.1-8b-instant", 
  
  instructions: `
    You are an expert AI language assistant focused strictly on translation and language detection. 
    Your tasks are:
    1. Detect the ISO-639 language code of the user's input.
    2. If the language is not English ('en'), translate the text to English.
    3. If asked to translate a final message, provide ONLY the translated text.

    Always respond strictly with the requested format (e.g., JSON for detection, plain text for final translation).
  `,
});