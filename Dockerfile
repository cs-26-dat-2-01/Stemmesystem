# Build stage
FROM denoland/deno:latest AS builder
WORKDIR /app
COPY ./package.json ./deno.json ./
# Install dependencies  
RUN apt-get update --assume-yes && apt-get upgrade --assume-yes  &&\
apt-get install npm --assume-yes && \
npm install -g node-gyp && \
deno install # Using package.json and deno.json

# Production stage
FROM builder AS production
WORKDIR /app
# Copy install artifacts
COPY --from=builder /app .
COPY . .
RUN deno task build
 
# CMD ["deno", "task", "prod"]
