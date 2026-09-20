export function AdminPanel({ user }) {
  return <div>{user.role === 'ADMIN' && <button>Delete everything</button>}{user.role === 'SUPPORT' && <a href="/tickets">Tickets</a>}<RequireRole role="AUDITOR"><Report /></RequireRole></div>;
}
