const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const oracledb = require('oracledb');

const app = express();

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


// Avvio del server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server avviato su http://localhost:${port}`);
});