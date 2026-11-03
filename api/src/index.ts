import { Hono } from 'hono'
import { splitCents } from './split'

export interface Env {
  DB: D1Database
}

const app = new Hono<{ Bindings: Env }>()

// Global notFound handler (always returns JSON error)
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404)
})

// Global onError handler (always returns JSON 500 error)
app.onError((err, c) => {
  console.error('Unhandled server error:', err)
  return c.json({ error: 'Internal server error' }, 500)
})

// Health check endpoint
app.get('/api/health', (c) => c.json({ status: 'ok' }))

// POST /api/homes
app.post('/api/homes', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body.name !== 'string' || body.name.trim().length === 0) {
    return c.json({ error: 'Name is required' }, 400)
  }

  const id = crypto.randomUUID()
  const name = body.name.trim()

  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)').bind(id, name).run()

  return c.json({ id, name }, 201)
})

// POST /api/homes/:homeId/members
app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<{ id: string }>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const body = await c.req.json().catch(() => null)
  if (!body || typeof body.name !== 'string' || body.name.trim().length === 0) {
    return c.json({ error: 'Name is required' }, 400)
  }

  const id = crypto.randomUUID()
  const name = body.name.trim()

  await c.env.DB.prepare('INSERT INTO members (id, home_id, name) VALUES (?, ?, ?)')
    .bind(id, homeId, name)
    .run()

  return c.json({ id, homeId, name }, 201)
})

// POST /api/homes/:homeId/bills
app.post('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<{ id: string }>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid request body' }, 400)
  }

  const { title, totalCents } = body as { title?: unknown; totalCents?: unknown }

  if (typeof title !== 'string' || title.trim().length === 0) {
    return c.json({ error: 'Title is required' }, 400)
  }

  if (typeof totalCents !== 'number' || !Number.isSafeInteger(totalCents) || totalCents <= 0) {
    return c.json({ error: 'Total cents must be a positive integer' }, 422)
  }

  const membersResult = await c.env.DB.prepare(
    'SELECT id FROM members WHERE home_id = ? ORDER BY created_at ASC, rowid ASC',
  )
    .bind(homeId)
    .all<{ id: string }>()

  const members = membersResult.results
  if (!members || members.length === 0) {
    return c.json({ error: 'Home has no members' }, 422)
  }

  const billId = crypto.randomUUID()
  const cleanTitle = title.trim()
  const shareAmounts = splitCents(totalCents, members.length)

  const shares = members.map((member, index) => {
    const amountCents = shareAmounts[index]
    if (amountCents === undefined) {
      throw new Error('Share amount calculation failed')
    }
    return {
      id: crypto.randomUUID(),
      memberId: member.id,
      amountCents,
      paidAt: null,
    }
  })

  const statements = [
    c.env.DB.prepare(
      'INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)',
    ).bind(billId, homeId, cleanTitle, totalCents),
    ...shares.map((share) =>
      c.env.DB.prepare(
        'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)',
      ).bind(share.id, billId, share.memberId, share.amountCents),
    ),
  ]

  await c.env.DB.batch(statements)

  return c.json(
    {
      id: billId,
      homeId,
      title: cleanTitle,
      totalCents,
      shares,
    },
    201,
  )
})

export default app
