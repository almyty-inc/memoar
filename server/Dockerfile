FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY server/package.json server/package.json
RUN npm ci --workspace @memoar/server --include-workspace-root
COPY server server
COPY contracts contracts
RUN npm run build --workspace @memoar/server

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/node_modules ./node_modules
COPY --from=build /app/server/package.json ./package.json
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/contracts ./contracts
# Where MEMOAR_ERROR_STATE_PATH points. Created here, owned by the user the
# process runs as: Docker gives a fresh named volume the ownership of the
# directory it is mounted over, and a root-owned one leaves the process unable
# to write its own state — which fails quietly, because a service must not stop
# serving the archive over a statistics file it could not save.
RUN mkdir -p /var/lib/memoar && chown node:node /var/lib/memoar
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
