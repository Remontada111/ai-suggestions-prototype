# backend/Dockerfile
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    TZ=Europe/Stockholm

WORKDIR /app

# OS-deps: git, OpenSSH-klient, build tools, procps, curl, certs, gnupg
# + Node 20 (via NodeSource) + tsx
RUN set -eux; \
    apt-get update -y; \
    apt-get install -y --no-install-recommends \
    git openssh-client build-essential procps curl ca-certificates gnupg; \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -; \
    apt-get update -y; \
    apt-get install -y --no-install-recommends nodejs; \
    rm -rf /var/lib/apt/lists/*

# pnpm (valfritt) + tsx/ts för injektorn
RUN corepack enable && corepack prepare pnpm@9.6.0 --activate
RUN npm i -g tsx typescript

# Venv
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

# Python-deps
COPY requirements.txt /app/requirements.txt
RUN pip install -U pip && pip install -r /app/requirements.txt

# App-kod (bygg-kontekst är ./backend)
COPY . /app/backend

# PYTHONPATH så "backend.*" hittas under /app/backend
ENV PYTHONPATH="/app:${PYTHONPATH}"

WORKDIR /app
