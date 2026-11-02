import { randomUUID } from 'node:crypto'
import { Router, type Request, type RequestHandler, type Response } from 'express'
import { z } from 'zod'
import { ACTION_COLS, ensureAgentTables, executeAction, runAgent } from './agent.js'
import { answer } from './ai.js'
import { pool } from './db.js'
type Past = { role: 'user' | 'assistant'; content: string }[]
const MSG = `id, conversation_id AS "conversationId", role, content, source, created_at AS "createdAt"`
const h = (fn: (q: Request, r: Response) => Promise<unknown>): RequestHandler => (q, r, next) => { fn(q, r).catch(next) }
// The agent needs a Groq key (tool calling). AI_AGENT=off, or another AI_PROVIDER, keeps the plain chatbot.
const agentOn = () => process.env.AI_AGENT !== 'off' && !!process.env.GROQ_API_KEY && (process.env.AI_PROVIDER ?? 'groq').toLowerCase() === 'groq'
async function respond(content: string, past: Past, conversationId: string): Promise<{ reply: string; source: string; actionIds: string[] }> {
  if (agentOn()) {
    try { const r = await runAgent(content, past, conversationId); return { reply: r.reply, source: 'groq', actionIds: r.actionIds } }
    catch (e) { console.error('Agent failed, using plain chat:', e instanceof Error ? e.message : e) }
  }
  return { ...(await answer(content, past)), actionIds: [] }
}
export const aiRouter = Router()
aiRouter.get('/conversations', h(async (_q, r) => r.json((await pool.query(`SELECT id, title, created_at AS "createdAt" FROM conversations ORDER BY created_at DESC`)).rows)))
aiRouter.post('/conversations', h(async (_q, r) => r.status(201).json((await pool.query(`INSERT INTO conversations (id) VALUES ($1) RETURNING id, title, created_at AS "createdAt"`, [randomUUID()])).rows[0])))
aiRouter.delete('/conversations/:id', h(async (q, r) => { await pool.query('DELETE FROM conversations WHERE id=$1', [q.params.id]); r.status(204).end() }))
aiRouter.get('/conversations/:id/messages', h(async (q, r) => r.json((await pool.query(`SELECT ${MSG} FROM messages WHERE conversation_id=$1 ORDER BY created_at`, [q.params.id])).rows)))
aiRouter.get('/conversations/:id/actions', h(async (q, r) => { await ensureAgentTables(); r.json((await pool.query(`SELECT ${ACTION_COLS} FROM agent_actions WHERE conversation_id=$1 ORDER BY created_at`, [q.params.id])).rows) }))
aiRouter.post('/conversations/:id/messages', h(async (q, r) => {
  const { content } = z.object({ content: z.string().trim().min(1).max(2000) }).parse(q.body)
  const id = q.params.id
  const conv = await pool.query('SELECT title FROM conversations WHERE id=$1', [id])
  if (!conv.rows[0]) return r.status(404).json({ error: 'Conversation not found' })
  const past = (await pool.query('SELECT role, content FROM messages WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 10', [id])).rows.reverse() as Past
  const result = await respond(content, past, id)
  const add = async (role: string, text: string, src: string | null) => (await pool.query(`INSERT INTO messages (id,conversation_id,role,content,source) VALUES ($1,$2,$3,$4,$5) RETURNING ${MSG}`, [randomUUID(), id, role, text, src])).rows[0]
  const user = await add('user', content, null); const assistant = await add('assistant', result.reply, result.source)
  if (result.actionIds.length) await pool.query('UPDATE agent_actions SET message_id=$1 WHERE id = ANY($2::text[])', [assistant.id, result.actionIds])
  if (conv.rows[0].title === 'New conversation') await pool.query('UPDATE conversations SET title=$2 WHERE id=$1', [id, content.slice(0, 40)])
  r.status(201).json({ messages: [user, assistant] })
}))
const decide = (how: 'confirm' | 'cancel') => h(async (q, r) => {
  await ensureAgentTables()
  const claimed = (await pool.query(`UPDATE agent_actions SET status='running' WHERE id=$1 AND status='pending' RETURNING tool, args`, [q.params.id])).rows[0]
  if (!claimed) return r.status(409).json({ error: 'This action is no longer pending' })
  let status = 'cancelled'; let result: string | null = null
  if (how === 'confirm') { try { result = await executeAction(claimed.tool, claimed.args); status = 'executed' } catch (e) { status = 'failed'; result = e instanceof Error ? e.message : 'Failed' } }
  r.json((await pool.query(`UPDATE agent_actions SET status=$2, result=$3 WHERE id=$1 RETURNING ${ACTION_COLS}`, [q.params.id, status, result])).rows[0])
})
aiRouter.post('/agent/actions/:id/confirm', decide('confirm'))
aiRouter.post('/agent/actions/:id/cancel', decide('cancel'))
