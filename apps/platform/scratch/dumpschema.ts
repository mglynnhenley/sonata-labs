import { WORLD_DRAFT_SCHEMA, TWIN_SEEDS_SCHEMA, asSchema } from "../../../packages/world/src/schema";
console.log(JSON.stringify({ draft: asSchema(WORLD_DRAFT_SCHEMA), seeds: asSchema(TWIN_SEEDS_SCHEMA) }));
