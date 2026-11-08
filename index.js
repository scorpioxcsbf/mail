// Root entry point for Wispbyte.
// Auto-builds the React frontend if web/dist is missing, then starts the server.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const dist = join(dir, 'web', 'dist');

if (!existsSync(dist)) {
  console.log('[startup] web/dist not found — building frontend (this takes ~30s the first time)...');
  execSync('npm run build', { cwd: dir, stdio: 'inherit' });
  console.log('[startup] Frontend built successfully.');
}

await import('./server/index.js');
