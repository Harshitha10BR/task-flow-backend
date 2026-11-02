import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { pool } from './db.js'

export const ACTION_COLS = `id, message_id AS "messageId", tool, summary, status, result, created_at AS "createdAt"`
let ready: Promise<unknown> | null = null
export const ensureAgentTables = () => (ready ??= pool.query(`CREATE TABLE IF NOT EXISTS agent_actions (
  id text PRIMARY KEY, conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, message_id text, tool text NOT NULL,
  args jsonb NOT NULL, summary text NOT NULL, status text NOT NULL, result text, created_at timestamptz NOT NULL DEFAULT clock_timestamp())`))

// ---------- helpers: turn names the model gives us into real database ids ----------
type Named = { id: string; name: string }
type Fail = { error: string }
const pick = (rows: Named[], ref: string, kind: string): Named | Fail => {
  if (!rows.length) return { error: `No ${kind} matches "${ref}"` }
  if (rows.length > 1 && rows[0].name.toLowerCase() !== ref.toLowerCase() && rows[0].id !== ref) return { error: `"${ref}" is ambiguous. Candidates: ${rows.map(r => `${r.name} (${r.id})`).join(', ')}` }
  return rows[0]
}
const findBy = async (table: 'users' | 'projects', ref: string) =>
  pick((await pool.query(`SELECT id, name FROM ${table} WHERE name ILIKE $1 ORDER BY (lower(name)=lower($2)) DESC LIMIT 5`, [`%${ref}%`, ref])).rows as Named[], ref, table.slice(0, -1))
const findTask = async (ref: string) =>
  pick((await pool.query(`SELECT id, title AS name FROM tasks WHERE id=$1 OR title ILIKE $2 ORDER BY (id=$1) DESC, (lower(title)=lower($1)) DESC LIMIT 5`, [ref, `%${ref}%`])).rows as Named[], ref, 'task')
const me = async () => (await pool.query('SELECT id, name FROM users WHERE email=$1', [process.env.CURRENT_USER_EMAIL ?? 'harshitha@example.com'])).rows[0] as Named | undefined

// ---------- tool definitions: Zod checks the inputs, JSON schema tells the model what exists ----------
const status = z.enum(['todo', 'in_progress', 'review', 'blocked', 'done'])
const priority = z.enum(['low', 'medium', 'high', 'urgent'])
const S = {
  search_tasks: z.object({ assignee: z.string().optional(), project: z.string().optional(), status: status.optional(), priority: priority.optional(), overdue: z.boolean().optional(), text: z.string().optional() }),
  get_project_summary: z.object({ project: z.string() }),
  team_workload: z.object({}),
  create_task: z.object({ title: z.string().min(1), project: z.string(), assignee: z.string().optional(), priority: priority.default('medium'), status: status.default('todo'), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), labels: z.array(z.string()).default([]) }),
  update_task_status: z.object({ task: z.string(), status }),
  add_comment: z.object({ task: z.string(), text: z.string().min(1).max(1000) }),
}
const str = (description: string) => ({ type: 'string', description })
const ST = { type: 'string', enum: status.options }, PR = { type: 'string', enum: priority.options }
const def = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } })
const TOOLS = [
  def('search_tasks', 'READ. Find tasks. Use for any question about which tasks exist, who owns them, or what is overdue or blocked.', { assignee: str('Person name'), project: str('Project name'), status: ST, priority: PR, overdue: { type: 'boolean' }, text: str('Words in the title') }),
  def('get_project_summary', 'READ. Task counts by status, overdue count and next deadlines for one project.', { project: str('Project name') }, ['project']),
  def('team_workload', 'READ. Number of open tasks per team member.', {}),
  def('create_task', 'WRITE (needs user confirmation). Create a task. dueDate must be YYYY-MM-DD.', { title: str('Task title'), project: str('Project name'), assignee: str('Person name'), priority: PR, status: ST, dueDate: str('YYYY-MM-DD'), labels: { type: 'array', items: { type: 'string' } } }, ['title', 'project', 'dueDate']),
  def('update_task_status', 'WRITE (needs user confirmation). Change a task status.', { task: str('Task title or id'), status: ST }, ['task', 'status']),
  def('add_comment', 'WRITE (needs user confirmation). Comment on a task as the current user.', { task: str('Task title or id'), text: str('Comment text') }, ['task', 'text']),
]

const read = <T extends z.ZodTypeAny>(schema: T, run: (a: z.infer<T>) => Promise<unknown>) => ({ schema, run: run as (a: unknown) => Promise<unknown> })
type Prepared = { summary: string; args: Record<string, unknown> } | Fail
const write = <T extends z.ZodTypeAny>(schema: T, prepare: (a: z.infer<T>) => Promise<Prepared>) => ({ schema, prepare: prepare as (a: unknown) => Promise<Prepared> })

const READ = {
  search_tasks: read(S.search_tasks, async a => {
    const where: string[] = []; const p: unknown[] = []
    const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)) }
    if (a.assignee) add('u.name ILIKE ?', `%${a.assignee}%`)
    if (a.project) add('pr.name ILIKE ?', `%${a.project}%`)
    if (a.status) add('t.status = ?', a.status)
    if (a.priority) add('t.priority = ?', a.priority)
    if (a.text) add('t.title ILIKE ?', `%${a.text}%`)
    if (a.overdue) where.push(`t.status <> 'done' AND t.due_date < CURRENT_DATE`)
    const sql = `SELECT t.id, t.title, pr.name AS project, u.name AS assignee, t.status, t.priority, to_char(t.due_date,'YYYY-MM-DD') AS due
      FROM tasks t JOIN projects pr ON pr.id=t.project_id LEFT JOIN users u ON u.id=t.assignee_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.due_date LIMIT 15`
    return (await pool.query(sql, p)).rows
  }),
  get_project_summary: read(S.get_project_summary, async a => {
    const p = await findBy('projects', a.project); if ('error' in p) return p
    const q = async (sql: string) => (await pool.query(sql, [p.id])).rows
    return { project: p.name, byStatus: await q(`SELECT status, count(*)::int AS n FROM tasks WHERE project_id=$1 GROUP BY status`),
      overdue: (await q(`SELECT count(*)::int AS n FROM tasks WHERE project_id=$1 AND status<>'done' AND due_date<CURRENT_DATE`))[0].n,
      upcoming: await q(`SELECT title, to_char(due_date,'YYYY-MM-DD') AS due FROM tasks WHERE project_id=$1 AND status<>'done' AND due_date>=CURRENT_DATE ORDER BY due_date LIMIT 5`) }
  }),
  team_workload: read(S.team_workload, async () => (await pool.query(`SELECT u.name, count(t.id) FILTER (WHERE t.status<>'done')::int AS open FROM users u LEFT JOIN tasks t ON t.assignee_id=u.id GROUP BY u.id ORDER BY open DESC`)).rows),
} as const
const WRITE = {
  create_task: write(S.create_task, async a => {
    const p = await findBy('projects', a.project); if ('error' in p) return p
    let assigneeId: string | null = null; let who = 'unassigned'
    if (a.assignee) { const u = await findBy('users', a.assignee); if ('error' in u) return u; assigneeId = u.id; who = u.name }
    return { summary: `Create task "${a.title}" in ${p.name}, assigned to ${who}, ${a.priority} priority, due ${a.dueDate}`,
      args: { title: a.title, projectId: p.id, assigneeId, priority: a.priority, status: a.status, dueDate: a.dueDate, labels: a.labels } }
  }),
  update_task_status: write(S.update_task_status, async a => {
    const t = await findTask(a.task); if ('error' in t) return t
    return { summary: `Move "${t.name}" to ${a.status}`, args: { taskId: t.id, status: a.status } }
  }),
  add_comment: write(S.add_comment, async a => {
    const t = await findTask(a.task); if ('error' in t) return t
    return { summary: `Comment on "${t.name}": "${a.text}"`, args: { taskId: t.id, text: a.text } }
  }),
} as const

// ---------- executing a confirmed action: only called after the user clicks Confirm ----------
export async function executeAction(tool: string, args: Record<string, unknown>): Promise<string> {
  if (tool === 'create_task') {
    const a = args as { title: string; projectId: string; assigneeId: string | null; priority: string; status: string; dueDate: string; labels: string[] }
    await pool.query(`INSERT INTO tasks (id,project_id,title,description,status,priority,assignee_id,due_date,labels) VALUES ($1,$2,$3,'',$4,$5,$6,$7,$8)`, [randomUUID(), a.projectId, a.title, a.status, a.priority, a.assigneeId, a.dueDate, a.labels])
    return `Created task "${a.title}"`
  }
  if (tool === 'update_task_status') {
    const a = args as { taskId: string; status: string }
    const r = await pool.query('UPDATE tasks SET status=$2 WHERE id=$1', [a.taskId, a.status]); if (!r.rowCount) throw new Error('Task no longer exists')
    return `Status changed to ${a.status}`
  }
  if (tool === 'add_comment') {
    const a = args as { taskId: string; text: string }; const user = await me(); if (!user) throw new Error('Current user not found')
    await pool.query('INSERT INTO comments (id,task_id,author_id,body) VALUES ($1,$2,$3,$4)', [randomUUID(), a.taskId, user.id, a.text])
    await pool.query('UPDATE tasks SET comment_count = comment_count + 1 WHERE id=$1', [a.taskId])
    return 'Comment added'
  }
  throw new Error(`Unknown action ${tool}`)
}

// ---------- the agent loop ----------
interface ToolCall { id: string; function: { name: string; arguments: string } }
interface ChatMsg { role: string; content: string; tool_calls?: ToolCall[]; tool_call_id?: string }
async function handleCall(name: string, rawArgs: string, conversationId: string, ids: string[]): Promise<unknown> {
  let raw: unknown; try { raw = JSON.parse(rawArgs || '{}') } catch { return { error: 'Arguments were not valid JSON' } }
  const log = async (summary: string, status: string, args: unknown) => {
    const id = randomUUID()
    await pool.query(`INSERT INTO agent_actions (id,conversation_id,tool,args,summary,status) VALUES ($1,$2,$3,$4,$5,$6)`, [id, conversationId, name, JSON.stringify(args), summary, status]); ids.push(id)
  }
  const issues = (e: z.ZodError) => ({ error: e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') })
  if (name in READ) {
    const t = READ[name as keyof typeof READ]; const p = t.schema.safeParse(raw); if (!p.success) return issues(p.error)
    const out = await t.run(p.data); await log(`Used ${name}`, 'done', p.data); return out
  }
  if (name in WRITE) {
    const t = WRITE[name as keyof typeof WRITE]; const p = t.schema.safeParse(raw); if (!p.success) return issues(p.error)
    const prep = await t.prepare(p.data); if ('error' in prep) return prep
    await log(prep.summary, 'pending', prep.args)
    return { status: 'awaiting_user_confirmation', summary: prep.summary, note: 'NOT executed yet. Tell the user to press Confirm or Cancel below your message.' }
  }
  return { error: `Unknown tool ${name}` }
}

export async function runAgent(message: string, history: { role: 'user' | 'assistant'; content: string }[], conversationId: string): Promise<{ reply: string; actionIds: string[] }> {
  await ensureAgentTables()
  const key = process.env.GROQ_API_KEY; if (!key) throw new Error('GROQ_API_KEY is not set')
  const user = await me(); const past = history.slice(); while (past.length && past[0].role !== 'user') past.shift()
  const messages: ChatMsg[] = [{ role: 'system', content: `You are TaskFlow AI, an agent inside a project management app. Today is ${new Date().toISOString().slice(0, 10)}. The current user is ${user?.name ?? 'unknown'}.
Use tools to look up data instead of guessing; never invent ids or names. Write tools only PREPARE a change: the user must press Confirm in the UI, so say it is ready for confirmation and never claim it is done. If a tool returns an error, fix the input or ask the user. Be concise, plain text.` }, ...past, { role: 'user', content: message }]
  const actionIds: string[] = []
  for (let step = 0; step < 6; step++) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ model: process.env.AI_MODEL || 'openai/gpt-oss-20b', temperature: 0.2, max_tokens: 1000, reasoning_effort: 'low', tools: TOOLS, messages }) })
    if (!res.ok) throw new Error(`Groq returned ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const msg = ((await res.json()) as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[] }).choices?.[0]?.message
    if (!msg) throw new Error('Empty response from Groq')
    const calls = msg.tool_calls ?? []
    if (!calls.length) { const reply = (msg.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim(); if (!reply) throw new Error('Empty answer'); return { reply, actionIds } }
    messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls })
    for (const c of calls) messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(await handleCall(c.function.name, c.function.arguments, conversationId, actionIds)) })
  }
  return { reply: 'That took too many steps. Please try a simpler request.', actionIds }
}
