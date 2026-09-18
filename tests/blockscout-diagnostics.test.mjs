import test from 'node:test';
import assert from 'node:assert/strict';
import { bsFetch } from '../src/chain/blockscout.ts';

test('Blockscout HTML 403 is logged as HTTP failure without leaking query credentials', async () => {
  const oldFetch = globalThis.fetch;
  const oldError = console.error;
  const lines = [];
  globalThis.fetch = async () => ({ status: 403, ok: false, headers: { get: () => 'text/html' }, json: async () => { throw new SyntaxError('HTML'); } });
  console.error = line => lines.push(String(line));
  try {
    const result = await bsFetch('/api/v2/addresses/0xabc/nft?apikey=secret', 100, 1);
    assert.equal(result, null);
    assert.match(lines.join('\n'), /Blockscout HTTP 403/);
    assert.doesNotMatch(lines.join('\n'), /secret|apikey=/);
  } finally {
    globalThis.fetch = oldFetch;
    console.error = oldError;
  }
});
