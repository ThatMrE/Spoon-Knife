# The game has no dependencies, so there is nothing to install and nothing to
# build: the image is a Node runtime plus the source.
FROM node:22-alpine

# Run unprivileged. The node image ships a `node` user already.
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node core ./core
COPY --chown=node:node shared ./shared
COPY --chown=node:node public ./public
USER node

ENV NODE_ENV=production
# Fly routes to this; the server reads PORT and binds 0.0.0.0 already.
ENV PORT=8080
EXPOSE 8080

# Public mode: /discover advertises that a code reaches anyone rather than just
# the WiFi, and the hostname is kept out of it. TRUST_PROXY lets the abuse
# limits see the real client address from Fly's headers instead of the proxy's.
ENV PUBLIC_SERVER=1
ENV TRUST_PROXY=1

CMD ["node", "server/index.js"]
