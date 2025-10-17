const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const oracledb = require('oracledb');
const net = require('net');
const app = express();
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// utility per eseguire comandi in modo sicuro (senza shell) con timeout
async function tryExec(file, args = [], options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { timeout: 8000, ...options });
    return { ok: true, stdout: stdout?.toString() || '', stderr: stderr?.toString() || '' };
  } catch (err) {
    // includo eventuale stdout/stderr per diagnosi
    return {
      ok: false,
      stdout: err.stdout?.toString?.() || '',
      stderr: (err.stderr?.toString?.() || err.message || '').toString()
    };
  }
}

// fallback multipli per ottenere output “equivalente”
async function getRoutingTable() {
  // netstat -nrv  (Linux: -r -n, -v ignorato)
  let out = await tryExec('netstat', ['-nrv']);
  if (out.ok && out.stdout.trim()) return { cmd: 'netstat -nrv', ...out };
  // ss non stampa la route, quindi proviamo ip route
  out = await tryExec('ip', ['route']);
  if (out.ok && out.stdout.trim()) return { cmd: 'ip route', ...out };
  // come ultima spiaggia: route -n
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
  // -c 4: 4 echo; -w 8: timeout complessivo
  return await tryExec('ping', ['-c', '4', '-w', '8', host]);
}

// traceroute (su alcune immagini non c’è); se manca, tentiamo “tracepath”
async function traceDestination(dest) {
  let out = await tryExec('traceroute', ['-n', '-w', '2', '-q', '1', dest]); // -n no DNS, più veloce
  if (out.ok && (out.stdout.trim() || out.stderr.trim())) return { cmd: `traceroute -n ${dest}`, ...out };
  out = await tryExec('tracepath', ['-n', dest]);
  return { cmd: `tracepath -n ${dest}`, ...out };
}

// sanitizzazione basilare dell’host (IP o hostname semplice)
function isSafeHost(input) {
  if (!input || typeof input !== 'string') return false;
  // vietiamo spazi e caratteri di shell
  if (/[^\w\.\-:]/.test(input)) return false;
  return true;
}


// Impostiamo EJS come "view engine"
app.set('view engine', 'ejs');

// Body-parser per leggere i campi del form in formato URL-encoded e JSON
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// GET: Mostra la pagina HTML con il form
app.get('/', (req, res) => {
  res.render('index', {
    remoteUrl: '',
    httpMethod: 'GET',
    headersJson: '',
    payloadType: 'json',    // valore di default
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
  const payloadType = req.body.PayloadType || 'json';  // 'json' o 'xml'
  const payloadText = req.body.PayloadText || '';
  

  let statusCode = null;
  let responseBody = '';

  // Se l'URL è vuoto, ritorniamo un errore subito
  if (!remoteUrl) {
    responseBody = 'RemoteUrl è vuoto. Inserisci un URL valido.';
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
      headers = JSON.parse(headersJson);
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
  
  console.log("Remote URL:" + remoteUrl);
  console.log("Http Method:" + httpMethod);
  console.log("Headers Json:" + headersJson);
  console.log("Payload Type:" + payloadType);
  console.log("Payload Text:" + payloadText);


  // Prepara la configurazione per Axios
  const axiosConfig = {
    url: remoteUrl,
    method: httpMethod,
    headers: {
      ...headers
    }
  };

  // Se il metodo supporta un payload, lo aggiungiamo
  if (['POST', 'PUT', 'PATCH'].includes(httpMethod)) {
    // JSON o XML a seconda della scelta
    if (payloadType === 'json') {
      // Se l'utente ha inserito del testo, cerchiamo di fare un parse JSON
      try {
        if (payloadText.trim()) {
          // proviamo a vedere se è JSON valido: se fallisce, lo inviamo comunque come raw JSON
          JSON.parse(payloadText);
        }
        axiosConfig.data = payloadText;
        // Impostiamo l'header Content-Type
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
      // Mandiamo il payload così com'è
      axiosConfig.data = payloadText;
      // Impostiamo l'header Content-Type per XML
      axiosConfig.headers['Content-Type'] = 'application/xml';
    }
  }

  try {
    // Inviamo la richiesta
    const response = await axios(axiosConfig);
    statusCode = response.status;
	console.log("Status Code:" || statusCode);
	
    // Cerchiamo di capire se la risposta è JSON oppure no
    // Se il server risponde con application/json, la libreria axios restituisce un oggetto.
    // Se è testuale o XML, di solito axios la tratta come stringa.
    if (typeof response.data === 'object') {
      responseBody = JSON.stringify(response.data, null, 2);
    } else {
      responseBody = response.data;
    }
  } catch (error) {
    // Se la chiamata fallisce (errore, timeout, ecc.)
    if (error.response) {
      statusCode = error.response.status;
      // Se la risposta di errore è un oggetto (JSON), cerchiamo di mostrarlo in modo leggibile
      if (typeof error.response.data === 'object') {
        responseBody = JSON.stringify(error.response.data, null, 2);
		console.log("Error: " + JSON.stringify(error.response.data, null, 2));
      } else {
        responseBody = error.response.data || error.message;
		console.log("Error: " + error.response.data || error.message);
      }
    } else {
      // Errore di rete, di configurazione, ecc.
      responseBody = error.message;
	  console.log("Error: " + error.message);
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

// Endpoint che testa la connessione
app.get('/test-oracle', async (req, res) => {
  // Esempio di connection string e credenziali
  // Su App Service, potresti usare variabili d'ambiente
  const connConfig = {
    user: process.env.ORACLE_USER || 'GEMSVIL',
    password: process.env.ORACLE_PASSWORD || 'GEMSVIL',
    connectString: process.env.ORACLE_CONNECTSTRING 
       || 'dlc101-vip.griffon.local:1540/P0NCSIDBTC.griffon.local'
       // oppure TNS:  '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=...)(PORT=1521))(CONNECT_DATA=(SID=...)))'
  };

  let connection;
  try {
    // Connessione
    connection = await oracledb.getConnection(connConfig);

    // Query di test
    const result = await connection.execute("SELECT 'OK' as RESULT FROM DUAL");
    const row = result.rows[0];
    res.json({
      success: true,
      message: 'Connessione riuscita',
      result: row
    });
  } catch (err) {
    res.json({
      success: false,
      message: `Errore: ${err.message}`
    });
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


// GET - Home page con un form (HTML semplice)
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

// POST - Effettua il check sulla porta
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

  // gateway di default
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
    <pre>${(routeTable.stdout || '').replace(/[<>&]/g, s => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[s])) || '(vuoto)'}</pre>
    ${routeTable.stderr ? `<h3>stderr</h3><pre>${routeTable.stderr.replace(/[<>&]/g, s => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[s]))}</pre>` : ''}

    <h2>Interfacce (${ifcfg.cmd})</h2>
    <pre>${(ifcfg.stdout || '').replace(/[<>&]/g, s => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[s])) || '(vuoto)'}</pre>
    ${ifcfg.stderr ? `<h3>stderr</h3><pre>${ifcfg.stderr.replace(/[<>&]/g, s => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[s]))}</pre>` : ''}

    <h2>Ping gateway${gw ? ` (${gw})` : ''} (${pingGw.cmd})</h2>
    <pre>${(pingGw.stdout || '').replace(/[<>&]/g, s => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[s])) || '(vuoto)'}</pre>
    ${pingGw.stderr ? `<h3>stderr</h3><pre>${pingGw.stderr.replace(/[<>&]/g, s => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[s]))}</pre>` : ''}

    <h2>Traceroute (${trace.cmd})</h2>
    <pre>${(trace.stdout || '').replace(/[<>&]/g, s => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[s])) || '(vuoto)'}</pre>
    ${trace.stderr ? `<h3>stderr</h3><pre>${trace.stderr.replace(/[<>&]/g, s => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[s]))}</pre>` : ''}

    <p style="margin-top:16px;color:#666;font-size:0.9em">
      Nota: su App Service/ASE alcuni comandi possono non essere disponibili o l’ICMP può essere bloccato; 
      in tal caso è normale vedere errori pur con connettività applicativa funzionante.
    </p>
  `);
});


// Funzione per testare la connessione TCP su host/porta
function checkPort(host, port, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();

    // Se entro "timeoutMs" ms non riusciamo a connetterci, consideriamo la porta chiusa
    socket.setTimeout(timeoutMs);

    // Se ci colleghiamo con successo, la porta è aperta
    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });

    // In caso di errore o timeout, la connessione non è riuscita
    socket.once('error', (err) => {
      socket.destroy();
      resolve(false); // o reject(err) se vuoi distinguere errori vari
    });

    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    // Tentiamo la connessione
    socket.connect(port, host);
  });
}


// Avvio del server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server avviato su http://localhost:${port}`);
});