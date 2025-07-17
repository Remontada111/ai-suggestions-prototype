# ---------- 1. Basimage ----------------------------------------------------
FROM python:3.13-slim

# ---------- 2. Miljövariabler ---------------------------------------------
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# ---------- 3. System­beroenden -------------------------------------------
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends git build-essential curl \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# ---------- 4. Python-paket -----------------------------------------------
COPY requirements.txt ./requirements.txt       
RUN pip install --upgrade pip \
    && pip install -r requirements.txt

# ---------- 5. Applikations-kod -------------------------------------------
COPY . /app/backend/                

# Lägg repo-roten i Python-sökvägen
ENV PYTHONPATH="/app:${PYTHONPATH}"

WORKDIR /app                      