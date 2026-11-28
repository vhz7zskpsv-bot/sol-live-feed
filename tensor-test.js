'use strict';

const http = require('http');
const { createTensorScanner } = require('./tensor-scanner');

const scanner = createTensorScanner();
const port = Number(process.env.PORT || 8080);

const server = http.createServer((req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(scanner.getStatus()));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Tensor isolated scanner test is running. Use /status for diagnostics.\n');
});

server.listen(port, '0.0.0.0', () => {
  console.log('Tensor isolated test server listening on port ' + port);
  scanner.start();
});

const report = setInterval(() => {
  console.log('TENSOR_TEST_STATUS ' + JSON.stringify(scanner.getStatus()));
}, 30000);

function shutdown() {
  clearInterval(report);
  scanner.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
