/**
 * Rebuild the vector search index from all markdown files.
 * Downloads embedding model on first run (~80MB).
 */

import { dirname } from "path";
import { VectorSearch } from "./vector-search.js";

const MEMORY_ROOT = process.env.CLAUDE_MEMORY_ROOT || dirname(new URL(import.meta.url).pathname).replace("/src", "");

const vs = new VectorSearch(MEMORY_ROOT);
const count = await vs.rebuild(MEMORY_ROOT);
vs.save();

console.log(`Vector index rebuilt: ${count} chunks embedded.`);
