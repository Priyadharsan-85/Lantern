const API_BASE = import.meta.env.VITE_COLLECTOR_URL || '';

const DEFAULT_TIMEOUT_MS = 8000;

async function apiFetch(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
        const res = await fetch(`${API_BASE}${path}`, {
            ...options,
            credentials: 'include',
            signal: controller.signal,
        });

        if (!res.ok) {
            // Try to parse error body as JSON, but if it fails, use a default error message.
            let errorInfo = {};
            try {
                const text = await res.text();
                errorInfo = JSON.parse(text);
            } catch {
                // ignore, keep errorInfo as {}
            }
            throw new Error(errorInfo.error || `HTTP ${res.status}`);
        }

        // If we get here, res.ok is true, so we expect JSON.
        return await res.json();
    } catch (err) {
        if (err.name !== 'AbortError') {
            // Log unexpected errors for debugging
            console.error('Unexpected error in apiFetch:', err);
        }
        let errorToThrow = err;
        if (err.name === 'AbortError') {
            errorToThrow = new Error('Request timed out — collector may be unreachable');
        }
        throw errorToThrow;
    } finally {
        clearTimeout(timer);
    }
}

export async function login(username, password) {
    return apiFetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
    });
}

export async function logout() {
    return apiFetch('/auth/logout', { method: 'POST' });
}

export async function checkSession() {
    return apiFetch('/auth/me');
}

export async function fetchTraces({ limit = 50, offset = 0 } = {}) {
    return apiFetch(`/traces?limit=${limit}&offset=${offset}`);
}

export async function fetchTraceDetail(traceId) {
    return apiFetch(`/traces/${encodeURIComponent(traceId)}`);
}