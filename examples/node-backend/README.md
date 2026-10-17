# Example Node.js backend

This small local HTTP service demonstrates sending real backend request spans
to one Lantern project using the Lantern Node SDK. It listens only on
`127.0.0.1` and does not expose the project ingest key to browser code.

## Run on Windows

From the repository root, start the local Lantern stack if it is not already
running:

```powershell
docker compose up -d
```

Start the example backend; PowerShell prompts securely for the project's
one-time ingest key:

```powershell
.\examples\node-backend\run.ps1
```

The default collector URL is `http://localhost:3000`. To send traces to a
different Lantern gateway, set `LANTERN_COLLECTOR_URL` in the current
PowerShell session before starting the script. The key is held in the process
environment only while the backend runs; do not paste it into source code,
commit it, or share it in screenshots.

From another terminal, call the example backend:

```powershell
Invoke-RestMethod 'http://localhost:5050/api/hello?name=Lantern'
```

It returns a greeting and creates a parent `GET /api/hello` span with a child
`greeting.compose` span. In the Lantern dashboard, select the same project and
click **Check again**. Look for the service `example-node-backend`.

Use `Ctrl+C` in the backend terminal to stop it and flush pending spans. If the
spans do not appear, check that the backend process is still running, the
collector URL is reachable from that process, and the configured project key
is current. Rotating the key invalidates the previous value.

The sample binds to loopback for local testing only. For a real deployment,
instrument your own server-side application and store its project key in that
application's secret environment; never put it in a browser or mobile app.
