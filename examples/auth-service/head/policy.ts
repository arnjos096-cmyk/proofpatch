export function retryDelay(attempt: number): number {
  // Refactor accidentally drops the lower bound.
  return Math.min(attempt * 100, 3000);
}

export function isAllowed(role: 'admin' | 'member', ownsResource: boolean): boolean {
  return ownsResource || role === 'admin';
}
