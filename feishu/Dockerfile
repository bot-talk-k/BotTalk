# ── Stage 1: Install dependencies ─────────────────────────────────────────
FROM node:22-bookworm-slim AS deps

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production

# ── Stage 2: Runtime ─────────────────────────────────────────────────────
FROM node:22-bookworm-slim

WORKDIR /app

# Set timezone (default: Asia/Shanghai, overridable via TZ env var)
ENV TZ=Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Copy dependencies from build stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application code
COPY . .

# Ensure data directory exists
RUN mkdir -p data

# Create non-root user and set ownership
RUN groupadd --system bottalk && \
    useradd --system --gid bottalk --no-create-home bottalk && \
    chown -R bottalk:bottalk /app

USER bottalk

EXPOSE 3000

CMD ["node", "app.js"]
