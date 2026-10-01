FROM node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4
RUN npm install --global pnpm@11.7.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json ./
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md TRADEMARK.md ./
COPY third-party-licenses ./third-party-licenses
COPY config ./config
COPY packages ./packages
COPY scripts ./scripts
COPY examples/industry ./examples/industry
RUN pnpm install --frozen-lockfile && pnpm build && pnpm check:dsh
ENV TELOA_DEPLOYMENT=compose \
    TELOA_DSH_HOME=/data/dsh \
    TELOA_RUNTIME_ROOT=/data/teloa \
    TELOA_WORKSPACE_ROOT=/data/teloa/workspace \
    TELOA_DSH_PROFILE=teloa \
    TELOA_DSH_PORT=3100
RUN pnpm setup:dsh && mkdir -p /data/teloa /data/secrets /data/credentials-secret && chown -R node:node /data && chmod 750 /data/secrets /data/credentials-secret
USER node
EXPOSE 8080
CMD ["node", "scripts/启动容器.mjs"]
