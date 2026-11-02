import { readFileSync } from 'node:fs'
import { pool } from './db.js'
const names = ['Harshitha B R','Rahul Kumar','Ananya Rao','Vikram Shah','Meera Nair','Arjun Patel','Sana Khan','Dev Mehta','Priya Iyer','Karan Singh']
const roles = ['Software Engineer','Backend Engineer','Frontend Engineer','QA Engineer','Product Designer','DevOps Engineer','Data Analyst','Engineering Manager','Frontend Engineer','Backend Engineer']
const pn = ['Payment Gateway Integration','Customer Dashboard','Mobile App Redesign','AI Support Assistant','Analytics Platform','User Authentication']
const st = ['todo','in_progress','review','blocked','done'], pr = ['low','medium','high','urgent']
const verbs = ['Implement','Design','Review','Test','Document','Refactor'], things = ['checkout flow','API client','settings page','auth guard','report export','search index']
const bodies = ['Can you review the API integration?', "Sure, I'll review it today.", 'Blocked on the gateway credentials.', 'Updated the design, please take a look.', 'Tests are passing on my branch.', 'Moving this to review.']
// Dates are relative to the day you seed, so My Work always has Today/Upcoming/Overdue items.
const day = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
await pool.query(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'))
await pool.query('TRUNCATE comments, tasks, projects, users CASCADE')
for (const [i, n] of names.entries())
  await pool.query('INSERT INTO users VALUES ($1,$2,$3,$4,$5)', [`u${i + 1}`, n, roles[i], `${n.split(' ')[0].toLowerCase()}@example.com`, i === 7 ? 'manager' : 'member'])
for (const [i, n] of pn.entries())
  await pool.query('INSERT INTO projects VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [`p${i + 1}`, n, `Deliver ${n.toLowerCase()} for the next release.`, i === 5 ? 'completed' : 'active', i % 2 ? 'medium' : 'high', day(-60), day(20 + i * 12), Array.from({ length: 3 + i }, (_, k) => `u${k + 1}`)])
for (let i = 0; i < 48; i++)
  await pool.query('INSERT INTO tasks VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [`t${i + 1}`, `p${(i % 6) + 1}`, `${verbs[i % 6]} ${things[(i * 5) % 6]}`, 'Seeded task.', st[i % 5], pr[i % 4], `u${(i % 10) + 1}`, day(((i * 7) % 31) - 12), [i % 2 ? 'Backend' : 'Frontend'], 0])
for (let k = 0; k < 36; k++)
  await pool.query(`INSERT INTO comments (id,task_id,author_id,body,created_at) VALUES ($1,$2,$3,$4, now() - ($5 || ' hours')::interval)`, [`c${k + 1}`, `t${((k * 5) % 48) + 1}`, `u${(k % 10) + 1}`, bodies[k % bodies.length], String(k + 1)])
await pool.query('UPDATE tasks SET comment_count = (SELECT count(*) FROM comments c WHERE c.task_id = tasks.id)')
console.log('Database seeded: 10 users, 6 projects, 48 tasks, 36 comments')
await pool.end()
