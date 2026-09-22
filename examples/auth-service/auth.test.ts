import { canRefresh } from './auth.js';
import { refreshRoute } from './routes.js';

// This fixture is mined for test descriptions; ProofPatch does not run this suite.
declare function test(name: string, fn: () => void): void;
test('a disabled account must never receive a refreshed session', () => {
  if (canRefresh(false, true)) throw new Error('Disabled account authenticated');
});
test('the refresh route propagates authentication rejection', () => {
  if (refreshRoute(false, true).authenticated) throw new Error('Unauthorized');
});
