import * as path from 'node:path'
import AutoLoad, { type AutoloadPluginOptions } from '@fastify/autoload'
import { type FastifyPluginAsync } from 'fastify'
import { fileURLToPath } from 'node:url'
import cors from '@fastify/cors'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export type AppOptions = {
  // Place your custom options for app below here.
} & Partial<AutoloadPluginOptions>

// Pass --options via CLI arguments in command to enable these options.
const options: AppOptions = {
}

const app: FastifyPluginAsync<AppOptions> = async (
  fastify,
  opts
): Promise<void> => {
  await fastify.register(cors, {
    origin: (origin, callback) => {
      const allowed = new Set((process.env.AUDIT_WEB_ORIGINS ?? 'http://127.0.0.1:3000,http://localhost:3000').split(','))
      callback(null, !origin || allowed.has(origin))
    },
    credentials: true
  })

  fastify.get('/health', async () => ({ ok: true, service: 'identity-audit-gateway' }))

  // Do not touch the following lines

  // This loads all plugins defined in plugins
  // those should be support plugins that are reused
  // through your application
  // eslint-disable-next-line no-void
  await fastify.register(AutoLoad, {
    dir: path.join(__dirname, 'plugins'),
    options: opts,
    forceESM: true
  })

  // This loads all plugins defined in routes
  // define your routes in one of these
  // eslint-disable-next-line no-void
  await fastify.register(AutoLoad, {
    dir: path.join(__dirname, 'routes'),
    options: opts,
    forceESM: true
  })
}

export default app
export { app, options }
