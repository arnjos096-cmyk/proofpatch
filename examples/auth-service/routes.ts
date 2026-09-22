import { canRefresh, sessionLabel } from './auth.js';
import { retryDelay, isAllowed } from './policy.js';

export function refreshRoute(active: boolean, valid: boolean) {
  return { authenticated: canRefresh(active, valid), nextRetry: retryDelay(1) };
}

export function dashboard(role: 'admin' | 'member') {
  return { label: sessionLabel(role), canEdit: isAllowed(role, false) };
}
