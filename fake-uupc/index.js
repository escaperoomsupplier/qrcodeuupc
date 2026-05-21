import http from 'node:http';

const PORT = Number(process.env.PORT || 9100);
let machineState = 0;

const server = http.createServer((req, res) => {
  if (req.url === '/machine/state' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const value = Number(params.get('value'));
      if (![0, 1, 2, 3].includes(value)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: 'value must be 0..3' }));
        return;
      }
      machineState = value;
      const label = ['ARMED', 'IN PROGRESS', 'WIN', 'LEARNING'][value];
      console.log(`[fake-uupc] machine_state=${value} (${label})`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', machine_state: value }));
    });
    return;
  }

  if (req.url === '/machine/state' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', machine_state: machineState }));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`[fake-uupc] listening on http://localhost:${PORT}`);
});
