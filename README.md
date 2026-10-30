# Legacy Modernizer

Paste a GitHub link to a jQuery app and get a React version back. Nemotron plans and rewrites it, a Nebius Token Factory Sandbox builds and lints it, and the agent fixes its own errors until it passes.

- Live demo: (https://legacy-modernizer-psi.vercel.app/)
- Demo video: (https://youtu.be/f0zdJh_ESoQ)
- Track: Coding and Agentic Engineering

## How to test (for judges)

1. Open the live demo. The first load can take up to a minute while the free server wakes up.
2. Keep the example repo (weather-dashboard) or paste any small public vanilla jQuery repo, then click Start Planning.
3. Review the plan, then click Run Migration. Small apps take about 3 to 5 minutes.
4. Download the zip, then run `npm install && npm run dev`.

Note: the example app keeps the original's hard-coded weather API key, which no longer works, so its searches show an error. That comes from the original app, not the migration.

## How it works

1. **Clone and check**: shallow clone of the repo, with a check that it really is a jQuery app.
2. **Plan**: Nemotron 3 Ultra (`nvidia/Nemotron-3-Ultra-550b-a55b`) reads the whole codebase in one call and writes a file-by-file migration plan. The plan is grounded with current docs from Tavily.
3. **Rewrite**: Nemotron 3 Super (`nvidia/nemotron-3-super-120b-a12b`) migrates each file to React.
4. **Verify**: the migrated app is built and linted in a Nebius Token Factory Sandbox (`npm run build` and ESLint).
5. **Self-correct**: real build or lint errors go back to Super, which fixes the file. Build and lint each get up to 3 attempts.
6. **Download**: a verified app as a zip.

## Where we use Nebius and NVIDIA

- **NVIDIA Nemotron 3 Ultra**: planning over the full repository (long context).
- **NVIDIA Nemotron 3 Super**: per-file rewriting and error fixing.
- **Nebius Token Factory**: all model calls go through the OpenAI-compatible API at `https://api.tokenfactory.nebius.com/v1/`.
- **Nebius Token Factory Sandboxes**: isolated microVMs that run the real build and lint, so the agent works from real errors.
- **Tavily**: a runtime search call during planning.


## Code map

- `backend/planner.py`: Tavily search call and Nemotron 3 Ultra planning, plus plan validation
- `backend/executor.py`: Nemotron 3 Super per-file migration and error fixing, with retry budgets
- `backend/sandbox_verify.py`: Token Factory Sandboxes build and ESLint verification
- `backend/repo_fetch.py`: GitHub clone and jQuery detection
- `backend/main.py`: FastAPI API, Server-Sent Events, job isolation, rate limits
- `frontend/`: React and TypeScript UI

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `NEBIUS_API_KEY` | yes | Token Factory and Sandboxes |
| `NEBIUS_PROJECT_ID` | yes | Sandboxes project |
| `TAVILY_API_KEY` | yes | Planning search |
| `ALLOWED_ORIGINS` | deploy | CORS origins for the frontend |
| `MAX_CONCURRENT_MIGRATIONS`, `MAX_PLANS_PER_HOUR_PER_IP`, `MAX_MIGRATIONS_PER_HOUR_PER_IP`, `DAILY_MIGRATION_CAP` | optional | Usage limits |

## Tests

Stubbed unit tests with no network or credits:

```bash
cd backend
python -m unittest test_resume_logic test_public_deployment -v
```

## Built during the hackathon

This project was created during the submission period. It has been tested on small public jQuery repos such as `coryjquirk/weather-dashboard`.


## Run locally

Requirements: Python 3.13, Node 20+, Git.

```bash
# backend
cp backend/.env.example .env   # fill in NEBIUS_API_KEY, NEBIUS_PROJECT_ID, TAVILY_API_KEY
pip install -r backend/requirements.txt
cd backend
uvicorn main:app --port 8000

# frontend (new terminal)
cd frontend
npm install
npm run dev
```

Docker: `docker build -t legacy-modernizer-api .` then `docker run -p 8080:8080 --env-file .env legacy-modernizer-api`. Set `VITE_API_BASE_URL` for the frontend.

## Limits

- Best on small and medium vanilla jQuery apps. Large multi-page apps with many plugins can fail to converge.
- It preserves the original app's behavior, including dead API keys.
- Free hosting sleeps when idle, so the first request can take about a minute.

## License

MIT