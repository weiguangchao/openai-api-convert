import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('release smoke is the default test command and Compatibility Fixtures remain separately runnable', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };

  assert.equal(packageJson.scripts.test, 'node --experimental-strip-types scripts/release-smoke.ts');
  assert.equal(packageJson.scripts['test:unit'], 'node --test --experimental-strip-types test/**/*.test.ts');
});
