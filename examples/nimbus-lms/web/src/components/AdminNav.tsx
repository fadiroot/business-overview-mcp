import { RequireRole } from './RequireRole';
import { useSession } from '../lib/session';

export function AdminNav() {
  const { user } = useSession();
  return (
    <nav>
      <a href="/courses">Courses</a>
      {user.role === 'admin' && <a href="/admin/reports">Reports</a>}
      {user.role === 'support' && <a href="/enrollments">Refunds</a>}
      {/* Moderators get a review queue in the UI. The API never checks for this role. */}
      <RequireRole role="moderator">
        <a href="/reviews/queue">Review queue</a>
      </RequireRole>
    </nav>
  );
}
