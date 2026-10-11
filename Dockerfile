# Un solo servicio Railway: Node (Persona Studio) + Python (regalos).
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv python3-pip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY requirements-python.txt ./
RUN python3 -m venv /opt/persona-python \
 && /opt/persona-python/bin/pip install --no-cache-dir -r requirements-python.txt

COPY . .
# Verificación de sintaxis y del formato de regalos durante el build.
RUN /opt/persona-python/bin/python -m unittest test_tiktok_python_worker -v
ENV NODE_ENV=production
ENV TIKTOK_PYTHON=/opt/persona-python/bin/python
ENV TIKTOK_PYTHON_GIFTS=1
EXPOSE 3000
CMD ["node", "server.js"]
