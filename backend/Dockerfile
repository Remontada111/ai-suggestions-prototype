# backend/Dockerfile
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN apt-get update -y \
    && apt-get install -y --no-install-recommends git build-essential curl \
    && rm -rf /var/lib/apt/lists/*

# Skapa venv i bilden
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

# ⬇️ Observera: vi är redan inne i build-contexten "backend/"
COPY requirements.txt ./requirements.txt
RUN pip install -U pip && pip install -r requirements.txt

# Kopiera hela backend-koden in i bilden
COPY . /app/backend

# Samma importväg som lokalt
ENV PYTHONPATH="/app:${PYTHONPATH}"
WORKDIR /app
