import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist/test/fixtures', { recursive: true });
await copyFile('test/fixtures/codex-0.144.5-mixed-tools.json', 'dist/test/fixtures/codex-0.144.5-mixed-tools.json');
