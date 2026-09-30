// A stand-in worker for supervisor tests. Behaviour is driven by env vars.
const http = require('node:http');
const fs = require('node:fs');
const mode = process.env.FAKE_MODE;
const counter = process.env.FAKE_COUNTER;
const starts = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0) + 1;
fs.writeFileSync(counter, String(starts));
const server = http.createServer((req, res) => {
  const healthy = !(mode === 'unhealthy' && starts === 1);
  res.writeHead(healthy ? 200 : 503).end(String(starts));
});
server.listen(Number(process.env.PORT), '127.0.0.1');
if (mode === 'crash' && starts <= 2) setTimeout(() => process.exit(1), 100);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
