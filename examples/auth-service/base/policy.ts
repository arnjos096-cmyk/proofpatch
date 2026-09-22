export function retryDelay(attempt: number): number {
  return Math.min(Math.max(attempt, 0) * 100, 3000);
}

export function isAllowed(role: 'admin' | 'member', ownsResource: boolean): boolean {
  return role === 'admin' || ownsResource;
}
