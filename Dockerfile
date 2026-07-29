FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 8787 5173 5174 4174

ENV NODE_ENV=development \
    PORT=8787

CMD ["sh", "-c", "npx concurrently -n server,web -c blue,magenta \"npm run dev:server\" \"npx vite --host 0.0.0.0 --port 5173\""]
