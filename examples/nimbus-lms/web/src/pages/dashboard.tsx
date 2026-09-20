import { AdminNav } from '../components/AdminNav';
import { RequireAuth } from '../components/RequireRole';
import { useSession } from '../lib/session';

export default function Dashboard() {
  const { user } = useSession();
  return (
    <RequireAuth>
      <AdminNav />
      <h1>Welcome back, {user.name}</h1>
      {user.role === 'instructor' && <a href="/courses/new">Create a course</a>}
      <section>
        <h2>My courses</h2>
      </section>
    </RequireAuth>
  );
}
