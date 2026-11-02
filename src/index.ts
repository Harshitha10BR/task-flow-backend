import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import cors from 'cors'
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express'
import { z } from 'zod'
import { pool, PROJECT_COLS, TASK_COLS, USER_COLS } from './db.js'
import { aiRouter } from './aiRoutes.js'
import { ensureAiTables } from './ai.js'

const app = express()
app.use(cors({ origin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173' }))
app.use(express.json())
const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res, next) => { fn(req, res).catch(next) }

const status = z.enum(['todo', 'in_progress', 'review', 'blocked', 'done'])
const priority = z.enum(['low', 'medium', 'high', 'urgent'])
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const projectBase = z.object({ name: z.string().min(1), description: z.string().min(10), status: z.enum(['planning', 'active', 'on_hold', 'completed']), priority, startDate: date, dueDate: date, memberIds: z.array(z.string()).default([]) });
const projectIn = projectBase
  .refine(p => p.dueDate >= p.startDate, { message: 'dueDate cannot be before startDate', path: ['dueDate'] })
const taskIn = z.object({ projectId: z.string(), title: z.string().min(1), description: z.string().default(''), status: status.default('todo'), priority: priority.default('medium'), assigneeId: z.string().nullable().default(null), dueDate: date, labels: z.array(z.string()).default([]) })

app.get('/api/health', h(async (_q, r) => { await pool.query('SELECT 1'); r.json({ ok: true }) }))
app.get('/api/me', h(async (_q, r) => {
  const { rows } = await pool.query(`SELECT ${USER_COLS} FROM users WHERE email=$1`, [process.env.CURRENT_USER_EMAIL ?? 'harshitha@example.com'])
  rows[0] ? r.json(rows[0]) : r.status(404).json({ error: 'Current user not found. Run npm run seed.' })
}))
app.get('/api/users', h(async (_q, r) => r.json((await pool.query(`SELECT ${USER_COLS} FROM users ORDER BY id`)).rows)))

app.post('/api/users', h(async (q, r) => {
  const u = z.object({ name: z.string().trim().min(1), email: z.string().email(), role: z.string().trim().min(1), userRole: z.enum(['admin', 'manager', 'member']).default('member') }).parse(q.body)
  const { rows } = await pool.query(`INSERT INTO users (id,name,role,email,user_role) VALUES ($1,$2,$3,$4,$5) RETURNING ${USER_COLS}`, [randomUUID(), u.name, u.role, u.email.toLowerCase(), u.userRole])
  r.status(201).json(rows[0])
}))

app.get('/api/projects', h(async (_q, r) => r.json((await pool.query(`SELECT ${PROJECT_COLS} FROM projects ORDER BY due_date`)).rows)))
app.get('/api/projects/:id', h(async (q, r) => {
  const { rows } = await pool.query(`SELECT ${PROJECT_COLS} FROM projects WHERE id=$1`, [q.params.id])
  rows[0] ? r.json(rows[0]) : r.status(404).json({ error: 'Project not found' })
}))
app.post('/api/projects', h(async (q, r) => {
  const p = projectIn.parse(q.body)
  const { rows } = await pool.query(`INSERT INTO projects (id,name,description,status,priority,start_date,due_date,member_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${PROJECT_COLS}`,
    [randomUUID(), p.name, p.description, p.status, p.priority, p.startDate, p.dueDate, p.memberIds])
  r.status(201).json(rows[0])
}))

const projectCols = { name: 'name', description: 'description', status: 'status', priority: 'priority', startDate: 'start_date', dueDate: 'due_date', memberIds: 'member_ids' } as const
app.patch('/api/projects/:id', h(async (q, r) => {
  const entries = Object.entries(projectBase.partial().parse(q.body)).filter(([k]) => k in projectCols)
  if (!entries.length) return r.status(400).json({ error: 'No valid fields to update' })
  const sets = entries.map(([k], i) => `${projectCols[k as keyof typeof projectCols]}=$${i + 2}`).join(', ')
  const { rows } = await pool.query(`UPDATE projects SET ${sets} WHERE id=$1 RETURNING ${PROJECT_COLS}`, [q.params.id, ...entries.map(([, v]) => v)])
  rows[0] ? r.json(rows[0]) : r.status(404).json({ error: 'Project not found' })
}))
app.delete('/api/projects/:id', h(async (q, r) => {
  const res = await pool.query('DELETE FROM projects WHERE id=$1', [q.params.id])
  res.rowCount ? r.status(204).end() : r.status(404).json({ error: 'Project not found' })
}))

app.get('/api/tasks', h(async (q, r) => {
  const filters: [string, unknown][] = [['project_id', q.query.projectId], ['assignee_id', q.query.assigneeId], ['status', q.query.status]]
  const active = filters.filter(([, v]) => typeof v === 'string')
  const where = active.length ? 'WHERE ' + active.map(([c], i) => `${c}=$${i + 1}`).join(' AND ') : ''
  r.json((await pool.query(`SELECT ${TASK_COLS} FROM tasks ${where} ORDER BY due_date`, active.map(([, v]) => v))).rows)
}))
app.post('/api/tasks', h(async (q, r) => {
  const t = taskIn.parse(q.body)
  const { rows } = await pool.query(`INSERT INTO tasks (id,project_id,title,description,status,priority,assignee_id,due_date,labels) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${TASK_COLS}`,
    [randomUUID(), t.projectId, t.title, t.description, t.status, t.priority, t.assigneeId, t.dueDate, t.labels])
  r.status(201).json(rows[0])
}))
const columns = { title: 'title', description: 'description', status: 'status', priority: 'priority', assigneeId: 'assignee_id', dueDate: 'due_date', labels: 'labels' } as const
app.patch('/api/tasks/:id', h(async (q, r) => {
  const patch = taskIn.omit({ projectId: true }).partial().parse(q.body)
  const entries = Object.entries(patch).filter(([k]) => k in columns)
  if (!entries.length) return r.status(400).json({ error: 'No valid fields to update' })
  const sets = entries.map(([k], i) => `${columns[k as keyof typeof columns]}=$${i + 2}`).join(', ')
  const { rows } = await pool.query(`UPDATE tasks SET ${sets} WHERE id=$1 RETURNING ${TASK_COLS}`, [q.params.id, ...entries.map(([, v]) => v)])
  rows[0] ? r.json(rows[0]) : r.status(404).json({ error: 'Task not found' })
}))
app.delete('/api/tasks/:id', h(async (q, r) => {
  const res = await pool.query('DELETE FROM tasks WHERE id=$1', [q.params.id])
  res.rowCount ? r.status(204).end() : r.status(404).json({ error: 'Task not found' })
}))

app.get('/api/tasks/:id/comments', h(async (q, r) => r.json((await pool.query(
  `SELECT id, task_id AS "taskId", author_id AS "authorId", body, created_at AS "createdAt" FROM comments WHERE task_id=$1 ORDER BY created_at`, [q.params.id])).rows)))
app.post('/api/tasks/:id/comments', h(async (q, r) => {
  const c = z.object({ authorId: z.string(), body: z.string().min(1) }).parse(q.body)
  const { rows } = await pool.query(`INSERT INTO comments (id,task_id,author_id,body) VALUES ($1,$2,$3,$4) RETURNING id, task_id AS "taskId", author_id AS "authorId", body, created_at AS "createdAt"`, [randomUUID(), q.params.id, c.authorId, c.body])
  await pool.query('UPDATE tasks SET comment_count = comment_count + 1 WHERE id=$1', [q.params.id])
  r.status(201).json(rows[0])
}))

app.use('/api', aiRouter)

app.use((err: unknown, _q: Request, res: Response, _n: NextFunction) => {
  if (err instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed', issues: err.issues })
  if (typeof err === 'object' && err !== null && 'code' in err && err.code === '23505') return res.status(409).json({ error: 'A member with that email already exists' })
  console.error(err); res.status(500).json({ error: 'Something went wrong' })
})
await ensureAiTables()
app.listen(Number(process.env.PORT ?? 4000), () => console.log('API on http://localhost:' + (process.env.PORT ?? 4000)))
