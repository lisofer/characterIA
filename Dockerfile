# Render build entrypoint for CVASISTENTE.
# Render uses the repository root as Docker context in this service.
FROM node:22-alpine
WORKDIR /app
COPY cv-asistente/package*.json ./
RUN apk add --no-cache ffmpeg
RUN npm install --omit=dev && npm cache clean --force
COPY cv-asistente/ ./
RUN npm run check && npm test
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
