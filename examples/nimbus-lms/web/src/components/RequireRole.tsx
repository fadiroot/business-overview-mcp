import type { ReactNode } from 'react';
import { useSession } from '../lib/session';

export function RequireRole({ role, children }: { role: string; children: ReactNode }) {
  const { user } = useSession();
  if (!user || user.role !== role) return null;
  return <>{children}</>;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useSession();
  return user ? <>{children}</> : <a href="/login">Sign in</a>;
}
