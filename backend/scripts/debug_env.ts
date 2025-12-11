import dotenv from "dotenv";
import path from "path";

// Try default load
const result = dotenv.config();

console.log("Dotenv parsed result error:", result.error);
console.log("Dotenv parsed keys:", result.parsed ? Object.keys(result.parsed) : "None");

console.log("Current working directory:", process.cwd());
console.log("SF_USERNAME:", process.env.SF_USERNAME ? "PRESENT" : "MISSING");
console.log("SF_PASSWORD:", process.env.SF_PASSWORD ? "PRESENT" : "MISSING");
console.log("SF_TOKEN:", process.env.SF_TOKEN ? "PRESENT" : "MISSING");
