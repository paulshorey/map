'use client';

import { FormEvent, useState } from 'react';

export default function LineageClient() {
  const [canonical, setCanonical] = useState('');
  const [source, setSource] = useState('');
  const [record, setRecord] = useState('');
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    const params = new URLSearchParams(canonical ? { canonical } : { source, record });
    const response = await fetch(`/api/admin/lineage?${params}`);
    const body = await response.json() as unknown;
    if (!response.ok) { setResult(null); setError((body as { error?: string }).error ?? 'Request failed'); return; }
    setResult(body);
  }

  return <main className="mx-auto max-w-5xl p-6 text-slate-900">
    <h1 className="text-2xl font-semibold">Ingest lineage</h1>
    <p className="mt-2 text-sm text-slate-600">Read-only developer tool. Search by canonical id or by source and source record id.</p>
    <form onSubmit={submit} className="mt-6 grid gap-3 rounded border p-4 md:grid-cols-3">
      <label className="grid gap-1 text-sm">Canonical id<input value={canonical} onChange={(e) => setCanonical(e.target.value)} className="rounded border px-2 py-1" /></label>
      <label className="grid gap-1 text-sm">Source<input value={source} disabled={Boolean(canonical)} onChange={(e) => setSource(e.target.value)} className="rounded border px-2 py-1" /></label>
      <label className="grid gap-1 text-sm">Source record id<input value={record} disabled={Boolean(canonical)} onChange={(e) => setRecord(e.target.value)} className="rounded border px-2 py-1" /></label>
      <button className="w-fit rounded bg-slate-900 px-3 py-2 text-sm text-white" type="submit">Trace</button>
    </form>
    {error && <p className="mt-4 text-sm text-red-700">{error}</p>}
    {result !== null && <pre className="mt-6 overflow-auto rounded bg-slate-950 p-4 text-xs text-slate-100">{JSON.stringify(result, null, 2)}</pre>}
  </main>;
}
