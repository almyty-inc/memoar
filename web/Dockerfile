# Built from the repository root, like the server image.
#
# This used to build from web/ against a second package-lock.json living beside
# it, which meant one dependency upgrade had to be applied to two lockfiles and
# the image broke whenever somebody remembered only the workspace one. There is
# one lockfile now, at the root, and it is the one the build installs from.
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY web/package.json web/package.json
RUN npm ci --workspace @memoar/web --include-workspace-root

COPY web web
ARG VITE_API_URL=""
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build --workspace @memoar/web

# The unprivileged image: runs as uid 101 and expects to write only /tmp and
# /var/cache/nginx, which is what lets the container run with a read-only root
# filesystem and no root user anywhere in the pod.
FROM nginxinc/nginx-unprivileged:1.29-alpine AS runtime
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
