# One Dockerfile for both apps:  docker build --build-arg APP=storefront|admin -f frontend/Dockerfile frontend
# Stage 1 compiles the React app; stage 2 is nginx serving the static files and proxying /api to the gateway,
# so the browser only ever talks to one origin (the refresh-token cookie needs that).
FROM node:22-alpine AS build
ARG APP=storefront
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY storefront/package.json storefront/
COPY admin/package.json admin/
RUN npm ci
COPY shared shared
COPY ${APP} ${APP}
RUN npm run build -w @shop/${APP}

FROM nginx:1.29-alpine
ARG APP=storefront
ENV GATEWAY_UPSTREAM=gateway:80
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/${APP}/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1
