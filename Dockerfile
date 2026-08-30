# Builds and runs the Plot API (apps/api). Explicit, so Railway (or any host) has zero
# guesswork about how to build this npm-workspaces monorepo — see docs/DECISIONS.md.
FROM node:20-slim AS build
WORKDIR /repo

COPY . .
RUN npm install
RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=apps/api

FROM node:20-slim AS runner
WORKDIR /repo
ENV NODE_ENV=production

COPY --from=build /repo ./

EXPOSE 4000
CMD ["npm", "run", "start", "--workspace=apps/api"]
