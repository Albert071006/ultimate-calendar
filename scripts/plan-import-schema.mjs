import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

// Generate portable docs from the same schema/defaults as the installed importer.
const output = await build({ stdin: { contents: "export { PlanFileSchema, PLAN_FILE_EXAMPLE } from './src/shared/plan-import'; export { z } from 'zod';", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm' });
const { PlanFileSchema, PLAN_FILE_EXAMPLE, z } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'));
const schema = z.toJSONSchema(PlanFileSchema, { io: 'input' });
schema.title = 'Ultimate Calendar Plan v1';
schema.description = 'UTF-8 creation plan, max 1 MiB and 500 total goals/tasks/blocks. The app also validates unique IDs, reference targets, real dates, interval order and current calendar conflicts. See ../plan-file-format.md.';
await mkdir('docs/schemas', { recursive: true });
await writeFile('docs/schemas/calendar-plan-v1.schema.json', JSON.stringify(schema, null, 2) + '\n');
await writeFile('docs/examples/study-plan.calendar-plan.json', JSON.stringify(PLAN_FILE_EXAMPLE, null, 2) + '\n');
PlanFileSchema.parse(PLAN_FILE_EXAMPLE);
