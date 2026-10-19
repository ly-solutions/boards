# syntax=docker/dockerfile:1
#
# boards: the editor (Vite) and the server-side Excalidraw bundle (esbuild) are built here, not at runtime.
# The runtime image only gets the built files and the server's production dependencies.

ARG NODE_VERSION=22.22.3

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY vite.config.mjs ./
COPY web ./web
COPY shared ./shared
COPY engine ./engine
COPY scripts ./scripts
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund \
 && find node_modules -type f \( -name '*.md' -o -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' \) -delete


FROM node:${NODE_VERSION}-alpine AS runtime
LABEL org.opencontainers.image.title="boards" \
      org.opencontainers.image.description="Excalidraw whiteboards that people draw and AI agents read and edit" \
      org.opencontainers.image.source="https://github.com/ly-solutions/boards" \
      org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    BOARDS_DATA_DIR=/data
# Layers from least to most frequently changed.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json LICENSE NOTICE ./
COPY --chown=node:node shared ./shared
COPY --chown=node:node server ./server
COPY --chown=node:node bin ./bin
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080 9090
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "bin/boards.mjs"]
CMD ["serve"]
