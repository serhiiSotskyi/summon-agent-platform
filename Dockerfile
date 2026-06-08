FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY requirements.txt ./
RUN python3 -m venv /opt/qbr-venv \
  && /opt/qbr-venv/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/qbr-venv/bin/pip install --no-cache-dir -r requirements.txt

ENV PATH="/opt/qbr-venv/bin:${PATH}"

COPY . .

RUN npm run db:generate

CMD ["npm", "run", "worker:agent-runs"]
