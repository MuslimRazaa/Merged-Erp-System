FROM node:20-alpine
WORKDIR /app
COPY backend/package.json backend/package-lock.json* ./
RUN npm install --omit=dev
COPY backend ./backend
COPY public ./public
ENV PORT=5050 NODE_ENV=production
EXPOSE 5050
USER node
CMD ["node", "backend/server.js"]
