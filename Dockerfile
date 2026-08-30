# Builds and runs the Plot API (apps/api). Explicit, so Railway/Render (or any Docker-
# compatible host) has zero guesswork about how to build this npm-workspaces monorepo — see
# docs/DECISIONS.md.
#
# openssl is installed in BOTH stages deliberately: node:20-slim (Debian bookworm) ships with
# no OpenSSL at all, so `prisma generate` in the build stage can't detect a real OpenSSL
# version and silently guesses the wrong engine binary (openssl-1.1.x) — installing it here
# first lets Prisma's platform detection find the real one (3.x) and fetch the matching
# binary. It's installed again in the runner stage because that's what's actually needed at
# runtime for the engine binary to load (dlopen) at all.
FROM node:20-slim AS build
WORKDIR /repo
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY . .
RUN npm install
RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=apps/api

FROM node:20-slim AS runner
WORKDIR /repo
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production

COPY --from=build /repo ./

EXPOSE 4000
CMD ["npm", "run", "start", "--workspace=apps/api"]
