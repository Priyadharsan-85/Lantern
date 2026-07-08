FROM node:20-alpine

WORKDIR /app

# Copy SDK
COPY packages/sdk ./packages/sdk
RUN cd packages/sdk && npm install && cd ../..

# Copy collector
COPY packages/collector ./packages/collector
RUN cd packages/collector && npm install && cd ../..

# Copy services
COPY services ./services
RUN cd services/api-gateway && npm install && cd ../../.. && \
    cd services/order-service && npm install && cd ../../.. && \
    cd services/payment-service && npm install && cd ../../..

# Copy .env
COPY .env .

# Expose ports
EXPOSE 4000 3000 4001 4002

CMD ["node", "packages/collector/index.js"]