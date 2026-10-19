FROM node:24-alpine AS web-build
WORKDIR /src/frontend
COPY frontend/package*.json ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY local/ ./local/
COPY --from=web-build /src/frontend/dist ./frontend/dist
USER node
EXPOSE 8080
CMD ["node", "local/server.mjs"]
