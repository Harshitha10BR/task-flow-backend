import 'dotenv/config'
import pg from 'pg'
pg.types.setTypeParser(1700, Number)
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
export const USER_COLS = `id, name, role, email, user_role AS "userRole"`
export const PROJECT_COLS = `id, name, description, status, priority, to_char(start_date,'YYYY-MM-DD') AS "startDate", to_char(due_date,'YYYY-MM-DD') AS "dueDate", member_ids AS "memberIds"`
export const TASK_COLS = `id, project_id AS "projectId", title, description, status, priority, assignee_id AS "assigneeId", to_char(due_date,'YYYY-MM-DD') AS "dueDate", labels, comment_count AS "commentCount"`
