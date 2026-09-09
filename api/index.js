'use strict';

const app = require('../src/app');
const { connectMongo } = require('../src/config/mongoose');

let mongoConnection;

module.exports = async function handler(req, res) {
  mongoConnection ??= connectMongo().catch((err) => {
    mongoConnection = undefined;
    throw err;
  });

  await mongoConnection;
  return app(req, res);
};
