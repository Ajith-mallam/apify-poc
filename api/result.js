'use strict';
// Vercel Function: /api/result (logic lives in src/web/api.js, shared with the local server).
const { createApi } = require('../src/web/api');

const handle = createApi();
module.exports = (req, res) => handle('result', req, res);
