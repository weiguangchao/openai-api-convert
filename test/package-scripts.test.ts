import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('release smoke is the default test command and Compatibility Fixtures remain separately runnable', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };

  assert.equal(packageJson.scripts.test, 'npm run build && node dist/scripts/release-smoke.js');
  assert.equal(packageJson.scripts['test:unit'], 'npm run build && node --test dist/test/**/*.test.js');
  assert.equal(packageJson.scripts.dev, 'tsx watch --include src/**/*.ts src/index.ts start --config config.dev.yaml');
  assert.equal(
    packageJson.scripts['test:codex-mixed-tools'],
    "npm run build && node --test --test-name-pattern='Codex mixed-tools' dist/test/bridge.test.js",
  );
});
