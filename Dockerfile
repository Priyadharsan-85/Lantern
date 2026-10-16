FROM node:22-alpine

WORKDIR /app

RUN apk upgrade --no-cache && apk add --no-cache curl

# Copy SDK
COPY packages/sdk ./packages/sdk
RUN cd packages/sdk && npm ci --omit=dev && cd ../..

# Copy collector
COPY packages/collector ./packages/collector
RUN cd packages/collector && npm ci --omit=dev && cd ../..

# Copy services
COPY services ./services
RUN cd services/api-gateway && npm ci --omit=dev && cd ../.. && \
    cd services/order-service && npm ci --omit=dev && cd ../.. && \
    cd services/payment-service && npm ci --omit=dev && cd ../..

RUN rm -rf /usr/local/lib/node_modules/npm

# Expose ports
EXPOSE 4000 3000 4001 4002

CMD ["node", "packages/collector/index.js"]