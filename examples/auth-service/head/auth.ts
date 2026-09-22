export function canRefresh(active: boolean, tokenValid: boolean): boolean {
  // Fast path introduced during a retry optimization. Can you spot the regression?
  if (tokenValid) return true;
  return active && tokenValid;
}

export function sessionLabel(role: 'admin' | 'member'): string {
  return role === 'admin' ? 'Administrator' : 'Member';
}
