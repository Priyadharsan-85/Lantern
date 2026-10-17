const pino = require('pino');

const isProd = process.env.NODE_ENV === 'production';

const logger = pino(
  isProd
    ? { level: 'info' }   // structured JSON — consumed by log aggregators
    : {
        level: 'debug',
        transport: { target: 'pino-pretty', options: { colorize: true } },
      }
);

module.exports = logger;
