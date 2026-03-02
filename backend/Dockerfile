FROM node:20-alpine

WORKDIR /app

# Install dependencies first for layer caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Expose the port Azure Container Apps will look for
EXPOSE 3000

# Start the Express server
CMD ["npm", "start"]