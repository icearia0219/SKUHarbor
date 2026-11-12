import { describe, expect, test } from 'vitest';
import {
  checkHostCapabilities,
  resetHostCapabilitiesCache,
} from '../src/agent-capabilities.js';

describe('host capability detection', () => {
  test('detects the Node executable running the service without a POSIX which dependency', async () => {
    resetHostCapabilitiesCache();
    const result = await checkHostCapabilities();
    expect(result.available.map((capability) => capability.binary)).toContain(
      'node',
    );
    expect(result.resolvedPaths.node).toBeTruthy();
    expect(result.resolvedPaths.node).not.toContain('\n');
  });
});
