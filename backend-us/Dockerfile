FROM node:18-slim

WORKDIR /app

# Install dependencies
COPY app/package.json ./
RUN npm install --production

# Copy application code
COPY app/src/ ./src/

EXPOSE 8000

CMD ["node", "src/index.js"]
