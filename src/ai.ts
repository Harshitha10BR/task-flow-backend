import { pool } from './db.js'
type Msg = { role: 'user' | 'assistant'; content: string }
type Provider = 'ollama' | 'groq' | 'anthropic' | 'rules'
interface Row { [k: string]: string | number | null }
interface Ctx { today: string; projects: Row[]; overdueCount: number; overdue: Row[]; blocked: Row[]; workload: Row[] }

const DEFAULT_MODEL = { ollama: 'qwen3.5:4b', groq: 'openai/gpt-oss-20b', anthropic: 'claude-haiku-5-5' } as const
// AI_PROVIDER wins. Otherwise: a Groq key selects groq, an Anthropic key selects anthropic, else rule-based answers.
function provider(): Provider {
  const p = process.env.AI_PROVIDER?.toLowerCase()
  if (p === 'ollama' || p === 'groq' || p === 'anthropic' || p === 'rules') return p
  if (process.env.GROQ_API_KEY) return 'groq'
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic'
  return 'rules'
}
const modelFor = (p: Exclude<Provider, 'rules'>) => process.env.AI_MODEL || DEFAULT_MODEL[p]

export async function ensureAiTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (id text PRIMARY KEY, title text NOT NULL DEFAULT 'New conversation', created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS messages (id text PRIMARY KEY, conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role text NOT NULL, content text NOT NULL, source text, created_at timestamptz NOT NULL DEFAULT clock_timestamp());`)
  const p = provider()
  console.log(p === 'rules' ? 'AI: rule-based answers only (set AI_PROVIDER=groq or ollama for a real model)' : `AI: ${p} (${modelFor(p)})`)
}

const taskList = (where: string) => `SELECT t.title, p.name AS project, u.name AS assignee, t.priority, to_char(t.due_date,'YYYY-MM-DD') AS due
  FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN users u ON u.id=t.assignee_id WHERE ${where} ORDER BY t.due_date LIMIT 12`
async function loadContext(): Promise<Ctx> {
  const rows = async (sql: string) => (await pool.query(sql)).rows as Row[]
  const [projects, overdue, blocked, workload, count] = await Promise.all([
    rows(`SELECT p.name, count(t.id)::int AS total, count(*) FILTER (WHERE t.status='done')::int AS done FROM projects p LEFT JOIN tasks t ON t.project_id=p.id GROUP BY p.id ORDER BY p.name`),
    rows(taskList(`t.status<>'done' AND t.due_date < CURRENT_DATE`)), rows(taskList(`t.status='blocked'`)),
    rows(`SELECT u.name, count(t.id) FILTER (WHERE t.status<>'done')::int AS open FROM users u LEFT JOIN tasks t ON t.assignee_id=u.id GROUP BY u.id ORDER BY open DESC`),
    rows(`SELECT count(*)::int AS n FROM tasks WHERE status<>'done' AND due_date < CURRENT_DATE`),
  ])
  return { today: new Date().toISOString().slice(0, 10), projects, overdueCount: Number(count[0].n), overdue, blocked, workload }
}

const line = (t: Row) => `"${t.title}" (${t.project}, ${t.assignee ?? 'unassigned'}, due ${t.due})`
function ruleAnswer(q: string, c: Ctx): string {
  const m = q.toLowerCase()
  if (m.includes('overdue')) return c.overdueCount ? `${c.overdueCount} tasks are overdue. The oldest are: ${c.overdue.slice(0, 3).map(line).join('; ')}.` : 'No tasks are overdue. You are all caught up!'
  if (m.includes('block')) return c.blocked.length ? `${c.blocked.length} tasks are blocked, for example: ${c.blocked.slice(0, 3).map(line).join('; ')}.` : 'Nothing is blocked right now.'
  if (/workload|busiest|highest|capacity/.test(m)) return `${c.workload[0].name} has the highest workload with ${c.workload[0].open} open tasks, followed by ${c.workload[1]?.name} (${c.workload[1]?.open}).`
  if (m.includes('prioriti')) return `Start with the ${c.overdueCount} overdue tasks${c.overdue[0] ? `, beginning with ${line(c.overdue[0])}` : ''}. Then unblock the ${c.blocked.length} blocked tasks.`
  if (/summar|progress|project/.test(m)) return c.projects.map(p => `${p.name}: ${p.done}/${p.total} tasks done`).join('. ') + '.'
  return 'I can answer questions about overdue tasks, blockers, team workload, priorities and project progress. Try one of the suggestions.'
}

const systemPrompt = (c: Ctx) => `You are TaskFlow AI, an assistant inside a project management app. Answer only from the data below. If the data does not contain the answer, say so. Be concise (under 150 words), plain text, no markdown tables.\nData: ${JSON.stringify(c)}`
const clean = (t: string) => { const out = t.replace(/<think>[\s\S]*?<\/think>/g, '').trim(); if (!out) throw new Error('The model returned an empty answer'); return out }
async function post(url: string, headers: Record<string, string>, body: unknown, ms: number, name: string) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) })
  if (!res.ok) throw new Error(`${name} returned ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json() as Promise<unknown>
}

async function askOllama(msgs: Msg[], c: Ctx) {
  const base = process.env.OLLAMA_URL ?? 'http://localhost:11434'
  // Native endpoint so thinking can be switched off: a 4B model on CPU is far too slow if it reasons first.
  const data = await post(`${base}/api/chat`, {}, { model: modelFor('ollama'), stream: false, think: false,
    options: { temperature: 0.3, num_predict: 500, num_ctx: 4096 }, messages: [{ role: 'system', content: systemPrompt(c) }, ...msgs] }, 180_000, 'Ollama') as { message?: { content?: string } }
  return clean(data.message?.content ?? '')
}
async function askGroq(msgs: Msg[], c: Ctx) {
  const key = process.env.GROQ_API_KEY; if (!key) throw new Error('GROQ_API_KEY is not set')
  const model = modelFor('groq')
  const data = await post('https://api.groq.com/openai/v1/chat/completions', { authorization: `Bearer ${key}` },
    { model, temperature: 0.3, max_tokens: 1000, ...(model.includes('gpt-oss') ? { reasoning_effort: 'low' } : {}), messages: [{ role: 'system', content: systemPrompt(c) }, ...msgs] }, 30_000, 'Groq') as { choices?: { message?: { content?: string | null } }[] }
  return clean(data.choices?.[0]?.message?.content ?? '')
}
async function askClaude(msgs: Msg[], c: Ctx) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error('ANTHROPIC_API_KEY is not set')
  const data = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    { model: modelFor('anthropic'), max_tokens: 600, system: systemPrompt(c), messages: msgs }, 30_000, 'Anthropic') as { content?: { type: string; text?: string }[] }
  return clean((data.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join(''))
}

export async function answer(message: string, history: Msg[]): Promise<{ reply: string; source: string }> {
  const ctx = await loadContext(); const p = provider()
  if (p !== 'rules') {
    const past = history.slice(); while (past.length && past[0].role !== 'user') past.shift()
    const msgs: Msg[] = [...past, { role: 'user', content: message }]
    try { return { reply: await { ollama: askOllama, groq: askGroq, anthropic: askClaude }[p](msgs, ctx), source: p } }
    catch (e) { console.error(`AI (${p}) failed, using rule-based answer:`, e instanceof Error ? e.message : e) }
  }
  return { reply: ruleAnswer(message, ctx), source: 'rules' }
}
