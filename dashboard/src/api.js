const API_BASE = import.meta.env.VITE_COLLECTOR_URL || '';

const DEFAULT_TIMEOUT_MS = 8000;

async function apiFetch(path, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

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
            const error = new Error(errorInfo.error || `HTTP ${res.status}`);
            error.code = errorInfo.code;
            error.status = res.status;
            throw error;
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
            errorToThrow = new Error('Request timed out. The service may be slow or temporarily unavailable.');
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

export async function registerCustomer(email, password) {
    return apiFetch('/auth/customer/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    }, 35_000);
}

export async function loginCustomer(email, password) {
    return apiFetch('/auth/customer/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
}

export async function requestCustomerVerification(email, password) {
    return apiFetch('/auth/customer/request-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    }, 35_000);
}

export async function verifyCustomerEmail(token) {
    return apiFetch('/auth/customer/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
    });
}

export async function requestPasswordReset(email) {
    return apiFetch('/auth/customer/request-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
    });
}

export async function resetCustomerPassword(token, password) {
    return apiFetch('/auth/customer/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
    });
}

export async function logoutCustomer() {
    return apiFetch('/auth/customer/logout', { method: 'POST' });
}

export async function checkCustomerSession() {
    return apiFetch('/auth/customer/me');
}

export async function fetchProducts() {
    return apiFetch('/products');
}

export async function listProjects() {
      return apiFetch('/projects');
}

export async function createProject(name) {
      return apiFetch('/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
      });
}

export async function rotateProjectKey(projectId) {
      return apiFetch(`/projects/${encodeURIComponent(projectId)}/rotate-key`, { method: 'POST' });
}

export async function createOrder(items, idempotencyKey) {
    if (typeof idempotencyKey !== 'string' ||
        idempotencyKey.length < 16 || idempotencyKey.length > 255) {
        throw new Error('A 16-255 character Idempotency-Key is required');
    }
    return apiFetch('/order', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ items }),
    }, 20_000);
}

export async function fetchTraces({ projectId, limit = 50, offset = 0 } = {}) {
    if (!projectId) throw new Error('Select a project before loading traces');
    const params = new URLSearchParams({ projectId, limit: String(limit), offset: String(offset) });
    return apiFetch(`/traces?${params}`);
}

export async function fetchTraceDetail(traceId, projectId) {
    if (!projectId) throw new Error('Select a project before loading trace details');
    const params = new URLSearchParams({ projectId });
    return apiFetch(`/traces/${encodeURIComponent(traceId)}?${params}`);
}