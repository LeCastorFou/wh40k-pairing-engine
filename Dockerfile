FROM python:3.11-slim

# Avoid writing pyc files + unbuffer logs
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# System deps (optional but useful)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install python deps
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy app
COPY . /app

# Ensure data directory exists in container
RUN mkdir -p /app/data

EXPOSE 5000

# Dev-friendly: flask run (reload) with env in compose
CMD ["flask", "run", "--host=0.0.0.0", "--port=5000"]
