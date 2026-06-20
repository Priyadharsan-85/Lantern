const API_BASE = 'http://localhost:4000';

export async function fetchTraces() {
  const res = await fetch(`${API_BASE}/traces`);
  if (!res.ok) throw new Error('Failed to load traces');
  return res.json();
}

export async function fetchTraceDetail(traceId) {
  const res = await fetch(`${API_BASE}/traces/${traceId}`);
  if (!res.ok) throw new Error('Failed to load trace detail');
  return res.json();
}