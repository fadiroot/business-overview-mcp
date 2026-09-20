import { RequireRole } from '../components/RequireRole';

export default function CourseEditor() {
  return (
    <RequireRole role="instructor">
      <form>
        <input name="title" placeholder="Course title" />
        <button type="submit">Save</button>
      </form>
    </RequireRole>
  );
}
