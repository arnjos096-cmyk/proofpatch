export function canRefresh(active: boolean, tokenValid: boolean): boolean {
  if (!active) return false;
  return tokenValid;
}

export function sessionLabel(role: 'admin' | 'member'): string {
  return role === 'admin' ? 'Administrator' : 'Member';
}
