"use client";

import { FormEvent, useState } from "react";
import styles from "./page.module.css";

type Job = { id: string; status: "queued" | "running" | "completed" | "failed"; progress?: string; error?: string };
type Report = { complete: boolean; metrics: Record<string, number>; warnings: Array<{ code: string; message: string }>; findings: Array<{ id: string; category: string; severity: string; confidence: number; summary: string; evidenceSpan: string; artifact: { repository: string; path?: string } }> };
const api = process.env.NEXT_PUBLIC_AUDIT_API_URL ?? "http://127.0.0.1:4318";

export default function Home() {
  const [account, setAccount] = useState("https://github.com/example-user?tab=repositories");
  const [names, setNames] = useState("Example Name");
  const [job, setJob] = useState<Job>();
  const [report, setReport] = useState<Report>();
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(undefined); setReport(undefined);
    try {
      const response = await fetch(`${api}/api/audits`, { method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify({ account, names: names.split(",").map((name) => name.trim()).filter(Boolean) }) });
      const started = await response.json();
      if (!response.ok) throw new Error(started.error ?? "Could not start audit");
      setJob(started);
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const statusResponse = await fetch(`${api}${started.statusUrl}`, { credentials: "include" });
        const status = await statusResponse.json() as Job; setJob(status);
        if (status.status === "failed") throw new Error(status.error ?? "Audit failed");
        if (status.status === "completed") {
          const result = await fetch(`${api}/api/audits/${started.id}/report`, { credentials: "include" }).then((value) => value.json());
          setReport(result); break;
        }
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }

  return <main className={styles.shell}>
    <header><p className={styles.eyebrow}>Local-first privacy tooling</p><h1>GitHub Identity Audit</h1><p className={styles.lead}>Scan public repositories, full reachable Git history, and authored GitHub surfaces with explicit limits and evidence provenance.</p></header>
    <section className={styles.panel}>
      <form onSubmit={submit}>
        <label>GitHub profile URL<input value={account} onChange={(event) => setAccount(event.target.value)} required /></label>
        <label>Trusted prior names or aliases<input value={names} onChange={(event) => setNames(event.target.value)} /><span>Comma-separated. Inferred names never become trusted seeds automatically.</span></label>
        <button disabled={job?.status === "queued" || job?.status === "running"}>{job?.status === "running" ? "Audit running…" : "Start bounded audit"}</button>
      </form>
      {job && <div className={styles.status}><strong>{job.status}</strong><span>{job.progress}</span></div>}
      {error && <p className={styles.error}>{error}</p>}
    </section>
    {report && <section className={styles.results}>
      <div className={styles.summary}><div><b>{report.findings.length}</b><span>findings</span></div><div><b>{report.metrics.repositoriesScanned ?? 0}</b><span>repositories</span></div><div><b>{report.metrics.uniqueBlobsScanned ?? 0}</b><span>unique blobs</span></div><div><b>{report.complete ? "Yes" : "Partial"}</b><span>coverage</span></div></div>
      {report.warnings.length > 0 && <aside><h2>Coverage warnings</h2>{report.warnings.map((warning) => <p key={warning.code}><b>{warning.code}</b> — {warning.message}</p>)}</aside>}
      <h2>Highest-ranked evidence</h2>
      <div className={styles.findings}>{report.findings.slice(0, 50).map((finding) => <article key={finding.id} className={styles.finding}><div><span data-severity={finding.severity}>{finding.severity}</span><small>{finding.category} · {(finding.confidence * 100).toFixed(0)}%</small></div><h3>{finding.summary}</h3><blockquote>{finding.evidenceSpan}</blockquote><code>{finding.artifact.repository}/{finding.artifact.path ?? "commit metadata"}</code></article>)}</div>
    </section>}
  </main>;
}
