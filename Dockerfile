# Legacy Modernization Agent — production image.
#
# Single worker only: job state (_jobs table, rate limiters, semaphores) is
# in-process, in-memory data. A second uvicorn worker would each keep their
# own empty job table and users would lose their sessions, so the CMD below
# deliberately starts ONE worker and does NOT use --reload (reload is for
# local development only).
FROM python:3.13-slim

# The backend shells out to `git clone` (repo_fetch.py) and needs CA
# certificates for HTTPS to GitHub/the Nebius API.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so this layer is cached until requirements change.
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Application source (.env files are excluded via .dockerignore — pass
# secrets at runtime with `docker run -e ...` / your orchestrator's secrets).
COPY backend/ .

ENV PORT=8080
EXPOSE 8080

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
