'use strict';
// Vercel Function: /api/start (logic lives in src/web/api.js, shared with the local server).
const { createApi } = require('../src/web/api');

const handle = createApi();
module.exports = (req, res) => handle('start', req, res);
