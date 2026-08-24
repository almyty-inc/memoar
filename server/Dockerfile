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
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
