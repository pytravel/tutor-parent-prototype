FROM node:22-alpine

WORKDIR /app

# Copy package files first for layer caching
COPY server/package.json server/package-lock.json* ./server/

# Install dependencies (@libsql/client is pure JS, no native build needed)
RUN cd server && npm install --production

# Copy all source code
COPY server/ ./server/
COPY index.html ./index.html
COPY admin.html ./admin.html
COPY customer-service-qr.jpg ./customer-service-qr.jpg

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q --spider http://localhost:3000/api/health || exit 1

# Start the server
CMD ["node", "server/app.js"]
