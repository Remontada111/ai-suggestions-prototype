# backend/Dockerfile
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    TZ=Europe/Stockholm

WORKDIR /app

# OS deps + Node.js 20 + pnpm (corepack) + tsx
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends git build-essential curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get update -y \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
# enable pnpm and pin version
RUN corepack enable && corepack prepare pnpm@9.6.0 --activate
# loader för AST-injektionen
RUN npm i -g tsx typescript

# Python venv
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

# Python deps
COPY requirements.txt ./requirements.txt
RUN pip install -U pip && pip install -r requirements.txt

# App-kod
COPY . /app/backend

# Python import path
ENV PYTHONPATH="/app:${PYTHONPATH}"
WORKDIR /app
