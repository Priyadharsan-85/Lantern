FROM node:22-alpine

WORKDIR /app

RUN apk upgrade --no-cache && apk add --no-cache curl

COPY . .

RUN npm ci --omit=dev && rm -rf /usr/local/lib/node_modules/npm

ENV NODE_ENV=production
ENV SERVICE=collector

EXPOSE 4000 3000 4001 4002

CMD ["sh", "-c", "if [ \"$SERVICE\" = \"api-gateway\" ]; then node services/api-gateway/index.js; elif [ \"$SERVICE\" = \"order-service\" ]; then node services/order-service/index.js; elif [ \"$SERVICE\" = \"payment-service\" ]; then node services/payment-service/index.js; else node packages/collector/index.js; fi"]