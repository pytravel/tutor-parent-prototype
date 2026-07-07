FROM node:22-alpine

# Install dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files first for layer caching
COPY server/package.json server/package-lock.json* ./server/

# Install dependencies
RUN cd server && npm install --production

# Copy all source code
COPY server/ ./server/
COPY index.html ./index.html
COPY admin.html ./admin.html

# Create data directory for SQLite persistence
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q --spider http://localhost:3000/api/admin/stats || exit 1

# Start the server
CMD ["node", "server/app.js"]
