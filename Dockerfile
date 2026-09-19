# Crosswalk — one image for the web server and the job worker (docs/DEPLOYMENT.md).
#
#   docker build -t crosswalk .
#   docker run --env-file .env -p 3000:3000 crosswalk            # web (migrates on start)
#   docker run --env-file .env crosswalk worker                   # a dedicated job worker
#   docker run --env-file .env crosswalk migrate                  # migrations only
#
# The runtime keeps the full dependency tree (the worker runs TypeScript through tsx, and
# `prisma migrate deploy` needs the CLI); the Next.js build output is copied in from the
# build stage. Nothing secret is baked in: DATABASE_URL and friends arrive at run time, or
# from a secret manager through SECRETS_PROVIDER.

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

# ---- dependencies --------------------------------------------------------------------------
FROM base AS deps
ENV NODE_ENV=development
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
# --ignore-scripts skips the postinstall `prisma generate`; it runs explicitly in the build stage.
RUN npm ci --ignore-scripts && npm cache clean --force

# ---- build ----------------------------------------------------------------------------------
FROM deps AS build
ENV NODE_ENV=production
COPY . .
# The Prisma client reads DATABASE_URL when a module loads; the build never connects.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN npx prisma generate && npm run build

# ---- runtime --------------------------------------------------------------------------------
FROM base AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/src/generated ./src/generated
COPY package.json package-lock.json next.config.ts prisma.config.ts tsconfig.json postcss.config.mjs ./
COPY prisma ./prisma
COPY public ./public
COPY src ./src
COPY scripts ./scripts
COPY data/fixtures ./data/fixtures
COPY deploy/entrypoint.sh ./deploy/entrypoint.sh
RUN chmod +x deploy/entrypoint.sh && chown -R node:node /app
USER node
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/app/deploy/entrypoint.sh"]
CMD ["web"]
