FROM node:22.18.0-bookworm AS development

ENV NODE_ENV=development
ENV npm_config_update_notifier=false

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    g++ \
    libcairo2-dev \
    libgif-dev \
    libjpeg-dev \
    libpango1.0-dev \
    librsvg2-dev \
    make \
    pkg-config \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY patches ./patches
RUN npm ci

COPY . .

CMD ["npm", "run", "dev"]

FROM development AS build

ENV NODE_ENV=production
RUN npm run build && npm prune --omit=dev

FROM node:22.18.0-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV DATA_DIR=/var/lib/musicbot

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    libcairo2 \
    libgcc-s1 \
    libgif7 \
    libjpeg62-turbo \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    librsvg2-2 \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/musicbot \
    && chown node:node /var/lib/musicbot

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

USER node
VOLUME ["/var/lib/musicbot"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "dist/main.js"]
