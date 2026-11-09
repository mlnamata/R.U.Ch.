# R.U.Ch. hub – small production image (one process, SQLite on a volume).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production RUCH_HOST=0.0.0.0 PORT=8080 RUCH_DB=/data/ruch.db
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ruch.mjs ./
COPY web ./web
COPY prompts ./prompts
COPY skills ./skills
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "--max-semi-space-size=2", "--max-old-space-size=192", "dist/server.js"]
