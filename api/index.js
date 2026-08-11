const server = require('../server');

// Vercel expects a request handler function. The local server remains
// reusable, but must not be exported as an http.Server instance directly.
module.exports = (req, res) => server.emit('request', req, res);
