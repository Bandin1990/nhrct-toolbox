const server = require('../server');

// Catch every /api/* request with Vercel's file-system router.
module.exports = (req, res) => server.emit('request', req, res);
