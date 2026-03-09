/**
 * Rebuild the search index from all markdown files in sessions/ and summaries/.
 * Run after git pull or when sessions are added.
 */

import { dirname } from "path";
import { MemorySearch } from "./search.js";

const MEMORY_ROOT = process.env.CLAUDE_MEMORY_ROOT || dirname(new URL(import.meta.url).pathname).replace("/src", "");

const search = new MemorySearch(MEMORY_ROOT);
const count = search.rebuild(MEMORY_ROOT);
search.save();

console.log(`Index rebuilt: ${count} chunks from sessions/ and summaries/`);
