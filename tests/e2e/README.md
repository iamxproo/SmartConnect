# End-to-end tests (browser)

Playwright drives the local Google Chrome against the whole platform: the built services, the API gateway, the realtime gateway and the web app's Vite dev server.

`support/stack.ts` starts everything on its own ports:

- services on 3301–3305 and 3309 (not 3306, MySQL's default port);
- the gateway on 3300;
- the web app on 5174.

It uses the disposable test PostgreSQL and a run-unique Redis channel, so your dev servers (:3000, :5173, 31xx) and dev database are never touched.

```bash
make infra-up                 # Redis (and dev Postgres) must be running
make e2e                      # builds, starts the test DB if needed, runs every spec
make e2e ARGS='smoke.spec.ts' # one file; any Playwright CLI arguments work
```

**Shared test database:** do not run `make e2e` and `make db-test` at the same time. They use the same test instance.

**Results:**

- Traces and screenshots of failures go to `$TMPDIR/smartconnect-e2e-results` (override with `E2E_OUTPUT_DIR`).
- Service logs go to a temporary directory printed at start (override with `E2E_LOG_DIR`).

**Isolation:** every test creates its own people and organizations through the public API. Each person gets their own browser context and client address, so sessions and per-IP rate limits never mix.

**Real browser:** set `E2E_BROWSER_CHANNEL=chromium` to use a Playwright-managed Chromium instead of Chrome. That requires `npx playwright install chromium`.
