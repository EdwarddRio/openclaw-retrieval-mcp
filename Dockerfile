FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy source code
COPY src/ ./src/
COPY config/ ./config/

# Create runtime directory
RUN mkdir -p /app/runtime

EXPOSE 8901

CMD ["node", "src/index.js"]
