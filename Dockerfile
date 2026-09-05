# Gauntlet Crawler production image
#
# Uses node:22-slim (Debian, glibc) rather than node:22-alpine: the server
# depends on the built-in `node:sqlite` module (requires Node >= 22.5), and
# that has not been verified against Alpine's musl libc in this environment
# (no Docker daemon available to test at build time). Debian slim is the
# safer, verified choice for the built-in SQLite bindings; revisit alpine
# once it has been confirmed to work.
FROM node:22-slim

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000

WORKDIR /app

# Install production dependencies only (playwright is a devDependency and
# must never end up in the production image).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Application source.
COPY server/ ./server/
COPY shared/ ./shared/
COPY client/ ./client/

# Non-root runtime user; own the app dir and the data volume mountpoint.
RUN groupadd --system gauntlet \
    && useradd --system --gid gauntlet --home-dir /app --no-create-home gauntlet \
    && mkdir -p /data \
    && chown -R gauntlet:gauntlet /app /data

VOLUME ["/data"]
EXPOSE 3000

USER gauntlet

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/ai/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings=ExperimentalWarning", "server/index.js"]
