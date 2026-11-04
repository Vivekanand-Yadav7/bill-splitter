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

// POST /api/bills/:billId/shares/:shareId/pay
app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const billId = c.req.param('billId')
  const shareId = c.req.param('shareId')

  // 1. Order of checks: share exists under that bill (404)
  const share = await c.env.DB.prepare(
    'SELECT id, bill_id AS billId, member_id AS memberId, amount_cents AS amountCents, paid_at AS paidAt, idempotency_key AS idempotencyKey FROM shares WHERE id = ? AND bill_id = ?',
  )
    .bind(shareId, billId)
    .first<{
      id: string
      billId: string
      memberId: string
      amountCents: number
      paidAt: string | null
      idempotencyKey: string | null
    }>()

  if (!share) {
    return c.json({ error: 'Share or bill not found' }, 404)
  }

  // 2. Idempotency-Key present (400)
  const idempotencyKey = c.req.header('Idempotency-Key')
  if (!idempotencyKey || idempotencyKey.trim().length === 0) {
    return c.json({ error: 'Idempotency-Key header is required' }, 400)
  }

  // If already paid with the same key, return existing record (idempotency)
  if (share.paidAt !== null) {
    if (share.idempotencyKey === idempotencyKey) {
      return c.json(
        {
          id: share.id,
          memberId: share.memberId,
          amountCents: share.amountCents,
          paidAt: share.paidAt,
        },
        200,
      )
    }
    // Already paid with a different key -> 409 Conflict
    return c.json({ error: 'Share has already been paid with a different key' }, 409)
  }

  // 3. One atomic statement to mark share as paid
  const now = new Date().toISOString()
  const updated = await c.env.DB.prepare(
    `UPDATE shares
     SET paid_at = ?, idempotency_key = ?
     WHERE id = ? AND bill_id = ? AND paid_at IS NULL
     RETURNING id, member_id AS memberId, amount_cents AS amountCents, paid_at AS paidAt, idempotency_key AS idempotencyKey`,
  )
    .bind(now, idempotencyKey, shareId, billId)
    .first<{
      id: string
      memberId: string
      amountCents: number
      paidAt: string
      idempotencyKey: string
    }>()

  if (updated) {
    return c.json(
      {
        id: updated.id,
        memberId: updated.memberId,
        amountCents: updated.amountCents,
        paidAt: updated.paidAt,
      },
      200,
    )
  }

  // Concurrent payment race handling
  const current = await c.env.DB.prepare(
    'SELECT id, member_id AS memberId, amount_cents AS amountCents, paid_at AS paidAt, idempotency_key AS idempotencyKey FROM shares WHERE id = ? AND bill_id = ?',
  )
    .bind(shareId, billId)
    .first<{
      id: string
      memberId: string
      amountCents: number
      paidAt: string
      idempotencyKey: string
    }>()

  if (current && current.idempotencyKey === idempotencyKey) {
    return c.json(
      {
        id: current.id,
        memberId: current.memberId,
        amountCents: current.amountCents,
        paidAt: current.paidAt,
      },
      200,
    )
  }

  return c.json({ error: 'Share has already been paid with a different key' }, 409)
})

// GET /api/homes/:homeId/balances
app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<{ id: string }>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const balancesResult = await c.env.DB.prepare(
    `SELECT
       m.id AS memberId,
       m.name,
       COALESCE(
         (
           SELECT SUM(s.amount_cents)
           FROM shares s
           JOIN bills b ON b.id = s.bill_id
           WHERE s.member_id = m.id
             AND b.home_id = m.home_id
             AND s.paid_at IS NULL
         ),
         0
       ) AS outstandingCents
     FROM members m
     WHERE m.home_id = ?
     ORDER BY m.created_at ASC, m.rowid ASC`,
  )
    .bind(homeId)
    .all<{
      memberId: string
      name: string
      outstandingCents: number
    }>()

  return c.json(
    {
      balances: balancesResult.results || [],
    },
    200,
  )
})

export default app
