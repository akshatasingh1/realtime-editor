# --- build: install everything and build the React client ---
FROM node:20-slim AS build
WORKDIR /app

COPY package*.json ./
# CRA 5 pins eslint 8 while devDeps ask for eslint 9 - the flag is expected.
RUN npm ci --legacy-peer-deps

COPY . .
RUN npm run build

# --- runtime: production deps + built client + server only ---
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev --legacy-peer-deps && npm cache clean --force

COPY --from=build /app/build ./build
COPY server.js ./
COPY server ./server
# The server imports the shared event names from src/ (see README design notes).
COPY src/Actions.js ./src/Actions.js

# The app honours $PORT; 5000 is only the default / documentation.
EXPOSE 5000
CMD ["node", "server.js"]
