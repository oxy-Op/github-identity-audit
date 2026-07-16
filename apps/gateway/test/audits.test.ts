import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import appPlugin from '../src/app.ts'

async function build() {
  const app = Fastify({ logger: false })
  await app.register(appPlugin)
  await app.ready()
  return app
}

test('Fastify gateway exposes health and root routes', async () => {
  const app = await build()
  try {
    const health = await app.inject({ method: 'GET', url: '/health' })
    assert.equal(health.statusCode, 200)
    assert.deepEqual(health.json(), { ok: true, service: 'identity-audit-gateway' })
    assert.equal((await app.inject({ method: 'GET', url: '/' })).statusCode, 200)
  } finally { await app.close() }
})

test('audit endpoint rejects invalid account input before scheduling work', async () => {
  const app = await build()
  try {
    const response = await app.inject({ method: 'POST', url: '/api/audits', payload: { account: 'https://example.com/not-github' } })
    assert.equal(response.statusCode, 400)
  } finally { await app.close() }
})
