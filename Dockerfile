# Build and run the MCP server without installing Node locally.
#   docker build -t business-overview-mcp .
#   docker run -i --rm -v /path/to/projects:/workspace business-overview-mcp
FROM node:22-slim AS build
WORKDIR /srv
COPY package.json package-lock.json* tsconfig.json ./
RUN npm ci || npm install
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /srv
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts || npm install --omit=dev --ignore-scripts
COPY --from=build /srv/dist ./dist
COPY README.md LICENSE ./
# Mount the project to analyse at /workspace and pass root="/workspace/<name>".
ENTRYPOINT ["node", "/srv/dist/index.js"]
