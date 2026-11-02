CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY, name text NOT NULL, role text NOT NULL,
  email text UNIQUE NOT NULL, user_role text NOT NULL DEFAULT 'member');
CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY, name text NOT NULL, description text NOT NULL DEFAULT '',
  status text NOT NULL, priority text NOT NULL,
  start_date date NOT NULL, due_date date NOT NULL, member_ids text[] NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS tasks (
  id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL, description text NOT NULL DEFAULT '',
  status text NOT NULL, priority text NOT NULL,
  assignee_id text REFERENCES users(id) ON DELETE SET NULL,
  due_date date NOT NULL, labels text[] NOT NULL DEFAULT '{}', comment_count int NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS comments (
  id text PRIMARY KEY, task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id text NOT NULL REFERENCES users(id), body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id);
CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks(assignee_id);
