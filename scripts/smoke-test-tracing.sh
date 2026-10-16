#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-lantern-smoke}"
COMPOSE=(docker compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

cleanup() {
  local exit_code=$?
  if [ "$exit_code" -ne 0 ]; then
    "${COMPOSE[@]}" logs --no-color --tail 100 postgres redis migrate collector || true
  fi
  "${COMPOSE[@]}" down --volumes --remove-orphans || true
  exit "$exit_code"
}
trap cleanup EXIT

"${COMPOSE[@]}" up -d postgres redis migrate collector

SMOKE_TEST_TIMEOUT_MS="${SMOKE_TEST_TIMEOUT_MS:-120000}" \
  "${COMPOSE[@]}" exec -T -e "SMOKE_TEST_TIMEOUT_MS" collector node <<'NODE'
const crypto = require("node:crypto");
const baseUrl = "http://127.0.0.1:4000";
const apiKey = process.env.COLLECTOR_API_KEY;
const timeoutMs = Number(process.env.SMOKE_TEST_TIMEOUT_MS) || 120_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.text();
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}

async function main() {
  const deadline = Date.now() + timeoutMs;
  let healthy = false;
  let healthError;
  while (Date.now() < deadline) {
    try {
      const health = await request("/health");
      if (health.status === "ok" && health.service === "collector") {
        healthy = true;
        break;
      }
    } catch (error) {
      healthError = error.message;
    }
    await delay(1_000);
  }
  if (!healthy) {
    throw new Error(`Collector did not become healthy within ${timeoutMs}ms${healthError ? `: ${healthError}` : ""}`);
  }
  if (!apiKey) throw new Error("COLLECTOR_API_KEY is required for the tracing smoke test");

  const traceId = `ci-${crypto.randomUUID()}`;
  const spanId = `ci-${crypto.randomUUID()}`;
  const startTime = Date.now();
  const span = {
    spanId,
    traceId,
    name: "CI production tracing smoke test",
    serviceName: "lantern-ci",
    status: "ok",
    duration: 7,
    startTime,
    endTime: startTime + 7,
    tags: { source: "github-actions" },
    logs: [],
  };

  const queued = await request("/spans", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ spans: [span] }),
  });
  if (queued.received !== 1) throw new Error(`Collector queued an unexpected span count: ${JSON.stringify(queued)}`);

  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/traces/${traceId}`);
    if (response.ok) {
      const spans = await response.json();
      const persisted = spans.find((item) => item.span_id === spanId);
      if (persisted && persisted.name === span.name && persisted.service_name === span.serviceName) {
        console.log(`Tracing smoke test passed: span ${spanId} was persisted and returned by the collector.`);
        return;
      }
    } else if (response.status !== 404) {
      throw new Error(`/traces/${traceId} returned HTTP ${response.status}: ${await response.text()}`);
    }
    await delay(500);
  }
  throw new Error(`Span ${spanId} was accepted but not persisted within ${timeoutMs}ms`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
NODE
