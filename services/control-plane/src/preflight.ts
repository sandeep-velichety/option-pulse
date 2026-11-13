/**
 * Imported FIRST by index.ts. ES modules evaluate imports in order, and db.ts /
 * anthropic-client.ts throw at load time when their variable is missing — before any of
 * main()'s logging. This runs ahead of them and says exactly what is missing and where to set it.
 *
 * Reads only presence of variables; never prints values.
 */
const service = process.env['RENDER_SERVICE_NAME'] ?? 'this service';
const missing: string[] = [];
if (!process.env['DATABASE_URL']) missing.push('DATABASE_URL');
if (!process.env['ANTHROPIC_API_KEY']) missing.push('ANTHROPIC_API_KEY');

if (missing.length > 0) {
  console.error(
    `[control-plane][boot] DIAGNOSIS: missing required environment variable(s): ${missing.join(', ')}.\n` +
      `  Set them on "${service}" in Render → ${service} → Environment, then redeploy/re-run.\n` +
      `  Render services do NOT share environment variables, and Blueprint secrets (sync: false)\n` +
      `  start empty — entering them on another service (e.g. control-plane) does not apply here.`,
  );
  process.exit(1);
}
