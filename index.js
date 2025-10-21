const express = require('express');
const axios = require('axios');
const oracledb = require('oracledb');
const net = require('net');
const { execFile } = require('child_process');
const { promisify } = require('util');

const app = express();
const execFileAsync = promisify(execFile);

// ------------------------------
// Utility comuni
// ------------------------------

// Esegue comandi senza shell con timeout, restituendo stdout/stderr utili alla diagnosi
async function tryExec(file, args = [], options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { timeout: 8000, ...options });
    return { ok: true, stdout: stdout?.toString() || '', stderr: stderr?.toString() || '' };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout?.toString?.() || '',
      stderr: (err.stderr?.toString?.() || err.message || '').toString()
    };
  }
}

// Escape HTML minimale per blocchi <pre>
function esc(s = '') {
  return s.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}

// Sanitizzazione basilare dell'host (IP o hostname semplice)
function isSafeHost(input) {
  if (!input || typeof input !== 'string') return false;
  // vietiamo spazi e caratteri di shell
  if (/[^\w\.-:]/.test(input)) return false;
  return true;
}

// Guard-rail SSRF per URL remoti
function isSafeUrl(u) {
  try {
    const url = new URL(u);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    // Blocca loopback e reti interne comuni
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
    if (/^169\.254\./.test(host)) return false; // link-local
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

// Filtra header non inoltrabili
function sanitizeForwardHeaders(h = {}) {
  const banned = new Set(['host', 'connection', 'transfer-encoding', 'content-length']);
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (!banned.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

// ------------------------------
// Diagnostica di rete (comandi)
// ------------------------------

// fallback multipli per ottenere output “equivalente”
async function getRoutingTable() {
  let out = await tryExec('netstat', ['-nrv']);
  if (out.ok && out.stdout.trim()) return { cmd: 'netstat -nrv', ...out };
  out = await tryExec('ip', ['route']);
  if (out.ok && out.stdout.trim()) return { cmd: 'ip route', ...out };
  out = await tryExec('route', ['-n']);
  return { cmd: 'route -n', ...out };
}

async function getIfconfig() {
  let out = await tryExec('ifconfig', ['-a']);
  if (out.ok && out.stdout.trim()) return { cmd: 'ifconfig -a', ...out };
  out = await tryExec('ip', ['addr', 'show']);
  if (out.ok && out.stdout.trim()) return { cmd: 'ip addr show', ...out };
  return { cmd: 'ifconfig -a', ok: false, stdout: '', stderr: 'Comando non disponibile' };
}

// ricava il gateway di default da “ip route” o “netstat -rn”
async function getDefaultGateway() {
  let gw = null;

  let r = await tryExec('ip', ['route']);
  const text = (r.stdout || '') + '\n' + (r.stderr || '');
  let m = text.match(/default\s+via\s+([0-9a-fA-F\.:]+)/);
  if (m) gw = m[1];

  if (!gw) {
    r = await tryExec('netstat', ['-rn']);
    const t = (r.stdout || '') + '\n' + (r.stderr || '');
    // “0.0.0.0  GW …” o “default  GW …”
    m = t.match(/^(?:0\.0\.0\.0|default)\s+([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/m);
    if (m) gw = m[1];
  }

  return gw;
}

// ping con massimo 4 pacchetti (ICMP può fallire su App Service)
async function pingHost(host) {
  return await tryExec('ping', ['-c', '4', '-w', '8', host]);
}

// traceroute (su alcune immagini non c’è); se manca, tentiamo “tracepath”
async function traceDestination(dest) {
  let out = await tryExec('traceroute', ['-n', '-w', '2', '-q', '1', dest]); // -n no DNS, più veloce
  if (out.ok && (out.stdout.trim() || out.stderr.trim())) return { cmd: `traceroute -n ${dest}`, ...out };
  out = await tryExec('tracepath', ['-n', dest]);
  return { cmd: `tracepath -n ${dest}`, ...out };
}

// Funzione per testare la connessione TCP su host/porta
function checkPort(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);

    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });

    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, host);
  });
}

// ------------------------------
// Config Express
// ------------------------------

// View engine
app.set('view engine', 'ejs');

// Parser nativi di Express
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ------------------------------
// Routes
// ------------------------------

// GET: Mostra la pagina HTML con il form
app.get('/', (req, res) => {
  res.render('index', {
    remoteUrl: '',
    httpMethod: 'GET',
    headersJson: '',
    payloadType: 'json',
    payloadText: '',
    statusCode: null,
    responseBody: ''
  });
});

// POST: Il form invia a /test
app.post('/test', async (req, res) => {
  const remoteUrl = req.body.RemoteUrl || '';
  const httpMethod = (req.body.HttpMethod || 'GET').toUpperCase();
  const headersJson = req.body.Headers || '';
  const payloadType = req.body.PayloadType || 'json'; // 'json' o 'xml'
  const payloadText = req.body.PayloadText || '';

  let statusCode = null;
  let responseBody = '';

//  if (!remoteUrl || !isSafeUrl(remoteUrl)) {
  if (!remoteUrl) {
    responseBody = 'RemoteUrl è vuoto o non consentito. Inserisci un URL http/https valido (no reti interne/loopback).';
    return res.render('index', {
      remoteUrl,
      httpMethod,
      headersJson,
      payloadType,
      payloadText,
      statusCode,
      responseBody
    });
  }

  // Parse degli header JSON (se presenti)
  let headers = {};
  if (headersJson.trim()) {
    try {
      headers = sanitizeForwardHeaders(JSON.parse(headersJson));
    } catch (err) {
      responseBody = `Errore nel parsing degli header JSON: ${err.message}`;
      return res.render('index', {
        remoteUrl,
        httpMethod,
        headersJson,
        payloadType,
        payloadText,
        statusCode,
        responseBody
      });
    }
  }

  console.log('Remote URL:', remoteUrl);
  console.log('Http Method:', httpMethod);
  console.log('Payload Type:', payloadType);

  // Prepara la configurazione per Axios
  const axiosConfig = {
    url: remoteUrl,
    method: httpMethod,
    headers: { ...headers },
    timeout: 10000,
    maxBodyLength: 1 * 1024 * 1024, // 1MB
    maxContentLength: 2 * 1024 * 1024, // 2MB
    validateStatus: () => true // accettiamo anche 4xx/5xx senza throw
  };

  if (['POST', 'PUT', 'PATCH'].includes(httpMethod)) {
    if (payloadType === 'json') {
      try {
        axiosConfig.data = payloadText.trim() ? JSON.parse(payloadText) : {};
        axiosConfig.headers['Content-Type'] = 'application/json';
      } catch (err) {
        responseBody = `Payload JSON non valido: ${err.message}`;
        return res.render('index', {
          remoteUrl,
          httpMethod,
          headersJson,
          payloadType,
          payloadText,
          statusCode,
          responseBody
        });
      }
    } else if (payloadType === 'xml') {
      axiosConfig.data = payloadText;
      axiosConfig.headers['Content-Type'] = 'application/xml';
    }
  }

  try {
    const response = await axios(axiosConfig);
    statusCode = response.status;
    console.log('Status Code:', statusCode);

    if (typeof response.data === 'object') {
      responseBody = JSON.stringify(response.data, null, 2);
    } else {
      responseBody = response.data;
    }
  } catch (error) {
    if (error.response) {
      statusCode = error.response.status;
      if (typeof error.response.data === 'object') {
        responseBody = JSON.stringify(error.response.data, null, 2);
        console.log('Error status:', statusCode);
      } else {
        responseBody = error.response.data || error.message;
        console.log('Error status:', statusCode);
      }
    } else {
      responseBody = error.message;
      console.log('Network/Config Error:', error.message);
    }
  }

  // Ricarichiamo la pagina con i risultati
  res.render('index', {
    remoteUrl,
    httpMethod,
    headersJson,
    payloadType,
    payloadText,
    statusCode,
    responseBody
  });
});

// Endpoint che testa la connessione a Oracle
app.get('/test-oracle', async (req, res) => {
  const { ORACLE_USER, ORACLE_PASSWORD, ORACLE_CONNECTSTRING } = process.env;
  if (!ORACLE_USER || !ORACLE_PASSWORD || !ORACLE_CONNECTSTRING) {
    return res.json({ success: false, message: 'Variabili ORACLE_* mancanti.' });
  }

  let connection;
  try {
    const connConfig = {
      user: ORACLE_USER,
      password: ORACLE_PASSWORD,
      connectString: ORACLE_CONNECTSTRING
    };

    connection = await oracledb.getConnection(connConfig);
    const result = await connection.execute("SELECT 'OK' as RESULT FROM DUAL");
    const row = result.rows[0];
    res.json({ success: true, message: 'Connessione riuscita', result: row });
  } catch (err) {
    res.json({ success: false, message: `Errore: ${err.message}` });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (closeErr) {
        console.log('Errore in chiusura:', closeErr);
      }
    }
  }
});

// GET - Home page con un form (HTML semplice) per test porta
app.get('/port', (req, res) => {
  res.send(`
    <h1>Test di raggiungibilità IP/porta</h1>
    <form action="/check-port" method="post">
      <label for="host">Host/IP:</label>
      <input type="text" name="host" id="host" placeholder="es. 8.8.8.8" required />
      <br/>
      <label for="port">Porta:</label>
      <input type="number" name="port" id="port" placeholder="es. 53" required />
      <br/><br/>
      <button type="submit">Verifica</button>
    </form>
  `);
});

// POST - Effettua il check sulla porta con diagnostica
app.post('/check-port', async (req, res) => {
  const host = req.body.host || '';
  const port = parseInt(req.body.port, 10);

  if (!isSafeHost(host) || !port) {
    return res.send('Host o porta non validi');
  }

  let tcpResultText = '';
  try {
    const isOpen = await checkPort(host, port);
    tcpResultText = isOpen
      ? `La porta ${port} su host ${host} è raggiungibile (TCP connect OK).`
      : `La porta ${port} su host ${host} non è raggiungibile (timeout o errore).`;
  } catch (err) {
    tcpResultText = `Errore durante la verifica TCP: ${err.message}`;
  }

  // --- DIAGNOSTICA DI RETE ---
  const [routeTable, ifcfg] = await Promise.all([
    getRoutingTable(),
    getIfconfig()
  ]);

  const gw = await getDefaultGateway();

  // ping al gateway (se trovato)
  let pingGw = { cmd: gw ? `ping -c 4 ${gw}` : 'ping', ok: false, stdout: '', stderr: 'Gateway non rilevato' };
  if (gw) {
    pingGw = await pingHost(gw);
    pingGw.cmd = `ping -c 4 ${gw}`;
  }

  // traceroute alla destination (host param)
  const trace = await traceDestination(host);

  // Risposta HTML con blocchi <pre>
  res.send(`
    <h1>Esito verifica porta</h1>
    <p>${tcpResultText}</p>

    <h2>Routing Table (${routeTable.cmd})</h2>
    <pre>${esc(routeTable.stdout || '') || '(vuoto)'}</pre>
    ${routeTable.stderr ? `<h3>stderr</h3><pre>${esc(routeTable.stderr)}</pre>` : ''}

    <h2>Interfacce (${ifcfg.cmd})</h2>
    <pre>${esc(ifcfg.stdout || '') || '(vuoto)'}</pre>
    ${ifcfg.stderr ? `<h3>stderr</h3><pre>${esc(ifcfg.stderr)}</pre>` : ''}

    <h2>Ping gateway${gw ? ` (${gw})` : ''} (${pingGw.cmd})</h2>
    <pre>${esc(pingGw.stdout || '') || '(vuoto)'}</pre>
    ${pingGw.stderr ? `<h3>stderr</h3><pre>${esc(pingGw.stderr)}</pre>` : ''}

    <h2>Traceroute (${trace.cmd})</h2>
    <pre>${esc(trace.stdout || '') || '(vuoto)'}</pre>
    ${trace.stderr ? `<h3>stderr</h3><pre>${esc(trace.stderr)}</pre>` : ''}

    <p style="margin-top:16px;color:#666;font-size:0.9em">
      Nota: su App Service/ASE alcuni comandi possono non essere disponibili o l’ICMP può essere bloccato;
      in tal caso è normale vedere errori pur con connettività applicativa funzionante.
    </p>
  `);
});

// ------------------------------
// Avvio del server
// ------------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server avviato su http://localhost:${port}`);
});