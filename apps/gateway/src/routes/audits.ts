import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { type FastifyPluginAsync } from 'fastify'
import { auditGitHubAccount } from '../../../../packages/coordinator/src/index.ts'
import { writeReports } from '../../../../packages/report/src/index.ts'
import { InProcessJobQueue } from '../../../../packages/runtime/src/index.ts'
import type { AuditReport } from '../../../../packages/core/src/types.ts'

interface AuditRequest { account: string; names?: string[]; emails?: string[] }
interface AuditJob { id: string; status: 'queued' | 'running' | 'completed' | 'failed'; progress: string; createdAt: string; output: string; report?: AuditReport; error?: string }

const jobs = new Map<string, AuditJob>()
const queue = new InProcessJobQueue(Number(process.env.AUDIT_CONCURRENCY ?? 1))

const audits: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: AuditRequest }>('/api/audits', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['account'],
        properties: { account: { type: 'string', pattern: '^https://github\\.com/' }, names: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 200 } }, emails: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 320 } } }
      }
    }
  }, async (request, reply) => {
    const id = randomUUID(), output = resolve('outputs', 'gateway', id)
    const job: AuditJob = { id, status: 'queued', progress: 'Queued', createdAt: new Date().toISOString(), output }
    jobs.set(id, job)
    void queue.enqueue(() => runAudit(job, request.body))
    return reply.code(202).send({ id, status: job.status, statusUrl: `/api/audits/${id}` })
  })

  fastify.get<{ Params: { id: string } }>('/api/audits/:id', async (request, reply) => {
    const job = jobs.get(request.params.id)
    if (!job) return reply.code(404).send({ error: 'Audit not found' })
    const { report: _report, ...status } = job
    return status
  })

  fastify.get<{ Params: { id: string } }>('/api/audits/:id/report', async (request, reply) => {
    const job = jobs.get(request.params.id)
    if (!job) return reply.code(404).send({ error: 'Audit not found' })
    if (!job.report) return reply.code(409).send({ error: 'Report is not ready', status: job.status })
    return job.report
  })
}

async function runAudit(job: AuditJob, request: AuditRequest) {
  job.status = 'running'
  try {
    const report = await auditGitHubAccount({
      account: request.account, names: request.names ?? [], emails: request.emails ?? [], output: job.output,
      token: process.env.GITHUB_TOKEN, includeForks: false, includeArchived: true,
      maxRepositories: 100, maxRepositorySizeKiB: 256_000, maxSocialItems: 300, maxDeepSocialItems: 1_000, contributionYears: 10,
      limits: { maxBlobBytes: 5_000_000, maxTotalTextBytes: 100_000_000, maxFindings: 10_000, maxCommitTrees: 5_000 },
      deleteMirrorsAfterScan: process.env.AUDIT_DELETE_MIRRORS === 'true', onProgress: (message) => { job.progress = message }
    })
    await writeReports(report, job.output)
    job.report = report; job.status = 'completed'; job.progress = 'Completed'
  } catch (error) {
    job.status = 'failed'; job.error = error instanceof Error ? error.message : String(error); job.progress = 'Failed'
  }
}

export default audits
