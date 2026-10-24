# Replaces the Nixpacks build, whose bundled Node (18.20.5) has CVE-2026-111497
# (Brotli RCE, Oct 2026 Node security release). Same steps Nixpacks ran:
# install, build, start. Deploy with Dokploy build type "Dockerfile".
FROM node:22.23.4-bookworm
WORKDIR /app
COPY . .
RUN npm ci
CMD ["npm", "start"]
