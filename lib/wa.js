const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const AUTH_DIR = path.join(__dirname, '..', 'auth_info');
const QR_CACHE = path.join(__dirname, 'qr-cache.png');

let sock = null;
let qrData = null;
let connectionState = 'close';
let userInfo = null;
let retryCount = 0;
let authState = null;
let saveCreds = null;
let destroySocket = null;
let contactsCache = {};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function clearAuth() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    if (fs.existsSync(QR_CACHE)) {
      fs.unlinkSync(QR_CACHE);
    }
  } catch (e) {
    console.error('clearAuth error:', e.message);
  }
}

async function writeQR(qr) {
  qrData = qr;
  try {
    await QRCode.toFile(QR_CACHE, qr, { type: 'png', width: 400, margin: 2 });
  } catch (e) {
    console.error('QR write error:', e.message);
  }
}

function removeQR() {
  qrData = null;
  try {
    if (fs.existsSync(QR_CACHE)) fs.unlinkSync(QR_CACHE);
  } catch (e) {
    // ignore
  }
}

async function connectToWhatsApp() {
  if (destroySocket) {
    try { destroySocket(); } catch (e) {}
    destroySocket = null;
  }

  ensureDir(AUTH_DIR);

  const { state, saveCreds: _saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  authState = state;
  saveCreds = _saveCreds;

  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

  const newSock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: state,
    browser: ['WhatsAppAdmin', 'Chrome', '1.0'],
    markOnlineOnConnect: false,
    defaultQueryTimeoutMs: 60000,
  });

  sock = newSock;

  newSock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('QR received');
      retryCount = 0;
      await writeQR(qr);
    }

    if (connection === 'close') {
      connectionState = 'close';
      userInfo = null;
      removeQR();

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log('Connection closed. Code:', statusCode, 'Reconnect?', shouldReconnect, 'Retry:', retryCount);

      if (!shouldReconnect) {
        console.log('Logged out — clearing auth');
        await clearAuth();
        retryCount = 0;
        setTimeout(() => connectToWhatsApp(), 3000);
        return;
      }

      if (retryCount < 5) {
        retryCount++;
        console.log(`Reconnecting attempt ${retryCount}/5 in 5s...`);
        setTimeout(() => connectToWhatsApp(), 5000);
      } else {
        console.log('Max retries reached. Clearing auth for fresh QR.');
        await clearAuth();
        retryCount = 0;
        setTimeout(() => connectToWhatsApp(), 3000);
      }
    } else if (connection === 'open') {
      connectionState = 'open';
      retryCount = 0;
      removeQR();
      userInfo = {
        id: newSock.user?.id,
        name: newSock.user?.name || 'Unknown',
      };
      console.log('Connected as', userInfo.name);
    }
  });

  newSock.ev.on('creds.update', saveCreds);

  // v7 dropped makeInMemoryStore; cache contacts manually
  newSock.ev.on('contacts.update', (contacts) => {
    for (const c of contacts || []) {
      if (c.id) {
        contactsCache[c.id] = { ...contactsCache[c.id], ...c };
      }
    }
  });

  newSock.ev.on('contacts.set', (contacts) => {
    for (const c of contacts || []) {
      if (c.id) {
        contactsCache[c.id] = { ...contactsCache[c.id], ...c };
      }
    }
  });

  destroySocket = () => {
    try {
      newSock.ev.removeAllListeners('connection.update');
      newSock.ev.removeAllListeners('creds.update');
      newSock.ws?.close();
    } catch (e) {}
  };
}

async function clearSessionAndRestart() {
  await clearAuth();
  retryCount = 0;
  if (destroySocket) {
    try { destroySocket(); } catch (e) {}
    destroySocket = null;
  }
  sock = null;
  connectionState = 'close';
  userInfo = null;
  qrData = null;
  contactsCache = {};
  setTimeout(() => connectToWhatsApp(), 1000);
}

// --- API helpers ---

function getStatus() {
  return {
    connected: connectionState === 'open',
    user: userInfo,
    qrReady: !!qrData && connectionState !== 'open',
  };
}

function getSocket() {
  return sock;
}

function isConnected() {
  return connectionState === 'open' && sock != null;
}

function normalizeJid(jid) {
  if (!jid) return null;
  return jid.split('@')[0].split(':')[0];
}

async function getGroups() {
  if (!isConnected()) throw new Error('Not connected');
  const groups = await sock.groupFetchAllParticipating();
  const myPhone = normalizeJid(sock.user?.id);
  const myLid = normalizeJid(sock.user?.lid);
  return Object.values(groups).map(g => {
    const me = g.participants?.find(p => {
      const base = normalizeJid(p.id);
      return base === myPhone || base === myLid;
    });
    return {
      id: g.id,
      name: g.subject,
      participantCount: g.participants?.length || 0,
      isAdmin: me && (me.admin === 'admin' || me.admin === 'superadmin'),
    };
  });
}

/**
 * Format phone numbers like WhatsApp native display.
 * Country-code-aware grouping based on common patterns.
 */
function formatPhone(num) {
  const s = String(num).replace(/\D/g, '');
  if (!s) return String(num);

  // Detect country code and strip it
  const ccPatterns = [
    { cc: '1', len: 1 },         // US/CA
    { cc: '7', len: 1 },         // Russia
    { cc: '20', len: 2 },        // Egypt
    { cc: '27', len: 2 },        // South Africa
    { cc: '30', len: 2 },        // Greece
    { cc: '31', len: 2 },        // Netherlands
    { cc: '32', len: 2 },        // Belgium
    { cc: '33', len: 2 },        // France
    { cc: '34', len: 2 },        // Spain
    { cc: '36', len: 2 },        // Hungary
    { cc: '39', len: 2 },        // Italy
    { cc: '40', len: 2 },        // Romania
    { cc: '41', len: 2 },        // Switzerland
    { cc: '43', len: 2 },        // Austria
    { cc: '44', len: 2 },        // UK
    { cc: '45', len: 2 },        // Denmark
    { cc: '46', len: 2 },        // Sweden
    { cc: '47', len: 2 },        // Norway
    { cc: '48', len: 2 },        // Poland
    { cc: '49', len: 2 },        // Germany
    { cc: '51', len: 2 },        // Peru
    { cc: '52', len: 2 },        // Mexico
    { cc: '53', len: 2 },        // Cuba
    { cc: '54', len: 2 },        // Argentina
    { cc: '55', len: 2 },        // Brazil
    { cc: '56', len: 2 },        // Chile
    { cc: '57', len: 2 },        // Colombia
    { cc: '58', len: 2 },        // Venezuela
    { cc: '60', len: 2 },        // Malaysia
    { cc: '61', len: 2 },        // Australia
    { cc: '62', len: 2 },        // Indonesia
    { cc: '63', len: 2 },        // Philippines
    { cc: '64', len: 2 },        // New Zealand
    { cc: '65', len: 2 },        // Singapore
    { cc: '66', len: 2 },        // Thailand
    { cc: '81', len: 2 },        // Japan
    { cc: '82', len: 2 },        // South Korea
    { cc: '84', len: 2 },        // Vietnam
    { cc: '86', len: 2 },        // China
    { cc: '90', len: 2 },        // Turkey
    { cc: '91', len: 2 },        // India
    { cc: '92', len: 2 },        // Pakistan
    { cc: '93', len: 2 },        // Afghanistan
    { cc: '94', len: 2 },        // Sri Lanka
    { cc: '95', len: 2 },        // Myanmar
    { cc: '98', len: 2 },        // Iran
    { cc: '212', len: 3 },       // Morocco
    { cc: '213', len: 3 },       // Algeria
    { cc: '216', len: 3 },       // Tunisia
    { cc: '218', len: 3 },       // Libya
    { cc: '220', len: 3 },       // Gambia
    { cc: '221', len: 3 },       // Senegal
    { cc: '222', len: 3 },       // Mauritania
    { cc: '223', len: 3 },       // Mali
    { cc: '224', len: 3 },       // Guinea
    { cc: '225', len: 3 },       // Ivory Coast
    { cc: '226', len: 3 },       // Burkina Faso
    { cc: '227', len: 3 },       // Niger
    { cc: '228', len: 3 },       // Togo
    { cc: '229', len: 3 },       // Benin
    { cc: '230', len: 3 },       // Mauritius
    { cc: '231', len: 3 },       // Liberia
    { cc: '232', len: 3 },       // Sierra Leone
    { cc: '233', len: 3 },       // Ghana
    { cc: '234', len: 3 },       // Nigeria
    { cc: '235', len: 3 },       // Chad
    { cc: '236', len: 3 },       // Central African Republic
    { cc: '237', len: 3 },       // Cameroon
    { cc: '238', len: 3 },       // Cape Verde
    { cc: '239', len: 3 },       // Sao Tome and Principe
    { cc: '240', len: 3 },       // Equatorial Guinea
    { cc: '241', len: 3 },       // Gabon
    { cc: '242', len: 3 },       // Republic of the Congo
    { cc: '243', len: 3 },       // Democratic Republic of the Congo
    { cc: '244', len: 3 },       // Angola
    { cc: '245', len: 3 },       // Guinea-Bissau
    { cc: '246', len: 3 },       // British Indian Ocean Territory
    { cc: '247', len: 3 },       // Ascension Island
    { cc: '248', len: 3 },       // Seychelles
    { cc: '249', len: 3 },       // Sudan
    { cc: '250', len: 3 },       // Rwanda
    { cc: '251', len: 3 },       // Ethiopia
    { cc: '252', len: 3 },       // Somalia
    { cc: '253', len: 3 },       // Djibouti
    { cc: '254', len: 3 },       // Kenya
    { cc: '255', len: 3 },       // Tanzania
    { cc: '256', len: 3 },       // Uganda
    { cc: '257', len: 3 },       // Burundi
    { cc: '258', len: 3 },       // Mozambique
    { cc: '260', len: 3 },       // Zambia
    { cc: '261', len: 3 },       // Madagascar
    { cc: '262', len: 3 },       // Reunion
    { cc: '263', len: 3 },       // Zimbabwe
    { cc: '264', len: 3 },       // Namibia
    { cc: '265', len: 3 },       // Malawi
    { cc: '266', len: 3 },       // Lesotho
    { cc: '267', len: 3 },       // Botswana
    { cc: '268', len: 3 },       // Eswatini
    { cc: '269', len: 3 },       // Comoros
    { cc: '290', len: 3 },       // Saint Helena
    { cc: '291', len: 3 },       // Eritrea
    { cc: '297', len: 3 },       // Aruba
    { cc: '298', len: 3 },       // Faroe Islands
    { cc: '299', len: 3 },       // Greenland
    { cc: '350', len: 3 },       // Gibraltar
    { cc: '351', len: 3 },       // Portugal
    { cc: '352', len: 3 },       // Luxembourg
    { cc: '353', len: 3 },       // Ireland
    { cc: '354', len: 3 },       // Iceland
    { cc: '355', len: 3 },       // Albania
    { cc: '356', len: 3 },       // Malta
    { cc: '357', len: 3 },       // Cyprus
    { cc: '358', len: 3 },       // Finland
    { cc: '359', len: 3 },       // Bulgaria
    { cc: '370', len: 3 },       // Lithuania
    { cc: '371', len: 3 },       // Latvia
    { cc: '372', len: 3 },       // Estonia
    { cc: '373', len: 3 },       // Moldova
    { cc: '374', len: 3 },       // Armenia
    { cc: '375', len: 3 },       // Belarus
    { cc: '376', len: 3 },       // Andorra
    { cc: '377', len: 3 },       // Monaco
    { cc: '378', len: 3 },       // San Marino
    { cc: '379', len: 3 },       // Vatican City
    { cc: '380', len: 3 },       // Ukraine
    { cc: '381', len: 3 },       // Serbia
    { cc: '382', len: 3 },       // Montenegro
    { cc: '383', len: 3 },       // Kosovo
    { cc: '385', len: 3 },       // Croatia
    { cc: '386', len: 3 },       // Slovenia
    { cc: '387', len: 3 },       // Bosnia and Herzegovina
    { cc: '389', len: 3 },       // North Macedonia
    { cc: '420', len: 3 },       // Czech Republic
    { cc: '421', len: 3 },       // Slovakia
    { cc: '423', len: 3 },       // Liechtenstein
    { cc: '500', len: 3 },       // Falkland Islands
    { cc: '501', len: 3 },       // Belize
    { cc: '502', len: 3 },       // Guatemala
    { cc: '503', len: 3 },       // El Salvador
    { cc: '504', len: 3 },       // Honduras
    { cc: '505', len: 3 },       // Nicaragua
    { cc: '506', len: 3 },       // Costa Rica
    { cc: '507', len: 3 },       // Panama
    { cc: '508', len: 3 },       // Saint Pierre and Miquelon
    { cc: '509', len: 3 },       // Haiti
    { cc: '590', len: 3 },       // Guadeloupe
    { cc: '591', len: 3 },       // Bolivia
    { cc: '592', len: 3 },       // Guyana
    { cc: '593', len: 3 },       // Ecuador
    { cc: '594', len: 3 },       // French Guiana
    { cc: '595', len: 3 },       // Paraguay
    { cc: '596', len: 3 },       // Martinique
    { cc: '597', len: 3 },       // Suriname
    { cc: '598', len: 3 },       // Uruguay
    { cc: '599', len: 3 },       // Curacao
    { cc: '670', len: 3 },       // East Timor
    { cc: '672', len: 3 },       // Norfolk Island
    { cc: '673', len: 3 },       // Brunei
    { cc: '674', len: 3 },       // Nauru
    { cc: '675', len: 3 },       // Papua New Guinea
    { cc: '676', len: 3 },       // Tonga
    { cc: '677', len: 3 },       // Solomon Islands
    { cc: '678', len: 3 },       // Vanuatu
    { cc: '679', len: 3 },       // Fiji
    { cc: '680', len: 3 },       // Palau
    { cc: '681', len: 3 },       // Wallis and Futuna
    { cc: '682', len: 3 },       // Cook Islands
    { cc: '683', len: 3 },       // Niue
    { cc: '685', len: 3 },       // Samoa
    { cc: '686', len: 3 },       // Kiribati
    { cc: '687', len: 3 },       // New Caledonia
    { cc: '688', len: 3 },       // Tuvalu
    { cc: '689', len: 3 },       // French Polynesia
    { cc: '690', len: 3 },       // Tokelau
    { cc: '691', len: 3 },       // Micronesia
    { cc: '692', len: 3 },       // Marshall Islands
    { cc: '850', len: 3 },       // North Korea
    { cc: '852', len: 3 },       // Hong Kong
    { cc: '853', len: 3 },       // Macau
    { cc: '855', len: 3 },       // Cambodia
    { cc: '856', len: 3 },       // Laos
    { cc: '880', len: 3 },       // Bangladesh
    { cc: '886', len: 3 },       // Taiwan
    { cc: '960', len: 3 },       // Maldives
    { cc: '961', len: 3 },       // Lebanon
    { cc: '962', len: 3 },       // Jordan
    { cc: '963', len: 3 },       // Syria
    { cc: '964', len: 3 },       // Iraq
    { cc: '965', len: 3 },       // Kuwait
    { cc: '966', len: 3 },       // Saudi Arabia
    { cc: '967', len: 3 },       // Yemen
    { cc: '968', len: 3 },       // Oman
    { cc: '970', len: 3 },       // Palestine
    { cc: '971', len: 3 },       // UAE
    { cc: '972', len: 3 },       // Israel
    { cc: '973', len: 3 },       // Bahrain
    { cc: '974', len: 3 },       // Qatar
    { cc: '975', len: 3 },       // Bhutan
    { cc: '976', len: 3 },       // Mongolia
    { cc: '977', len: 3 },       // Nepal
    { cc: '992', len: 3 },       // Tajikistan
    { cc: '993', len: 3 },       // Turkmenistan
    { cc: '994', len: 3 },       // Azerbaijan
    { cc: '995', len: 3 },       // Georgia
    { cc: '996', len: 3 },       // Kyrgyzstan
    { cc: '998', len: 3 },       // Uzbekistan
  ];

  let cc = '';
  let ccLen = 0;
  for (const p of ccPatterns) {
    if (s.startsWith(p.cc)) {
      if (p.len > ccLen) {
        cc = p.cc;
        ccLen = p.len;
      }
    }
  }

  const rest = s.slice(ccLen);

  // Country-specific formatting (WhatsApp native patterns)
  switch (cc) {
    case '1': {
      // US/Canada: +1 (XXX) XXX-XXXX
      if (rest.length === 10) return `+${cc} (${rest.slice(0,3)}) ${rest.slice(3,6)}-${rest.slice(6)}`;
      break;
    }
    case '44': {
      // UK: +44 XXXX XXXXXX
      if (rest.length === 10) return `+${cc} ${rest.slice(0,4)} ${rest.slice(4)}`;
      if (rest.length === 9) return `+${cc} ${rest.slice(0,3)} ${rest.slice(3)}`;
      break;
    }
    case '49': {
      // Germany: +49 XXX XXXXXXX
      if (rest.length >= 10) return `+${cc} ${rest.slice(0,3)} ${rest.slice(3)}`;
      break;
    }
    case '61': {
      // Australia: +61 XXX XXX XXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,3)} ${rest.slice(3,6)} ${rest.slice(6)}`;
      break;
    }
    case '81': {
      // Japan: +81 XX-XXXX-XXXX
      if (rest.length === 10) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,6)}-${rest.slice(6)}`;
      if (rest.length === 11) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,7)}-${rest.slice(7)}`;
      break;
    }
    case '91': {
      // India: +91 XXXXX XXXXX (5-5)
      if (rest.length === 10) return `+${cc} ${rest.slice(0,5)} ${rest.slice(5)}`;
      break;
    }
    case '92': {
      // Pakistan: +92 XXX-XXXXXXX
      if (rest.length === 10) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3)}`;
      break;
    }
    case '880': {
      // Bangladesh: +880 XXXX-XXXXXX (4-6)
      if (rest.length === 10) return `+${cc} ${rest.slice(0,4)}-${rest.slice(4)}`;
      break;
    }
    case '86': {
      // China: +86 XXX-XXXX-XXXX
      if (rest.length === 11) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,7)}-${rest.slice(7)}`;
      break;
    }
    case '65': {
      // Singapore: +65 XXXX XXXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,4)} ${rest.slice(4)}`;
      break;
    }
    case '84': {
      // Vietnam: +84 XX-XXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '62': {
      // Indonesia: +62 XXX-XXX-XXX
      if (rest.length >= 10) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,6)}-${rest.slice(6)}`;
      break;
    }
    case '60': {
      // Malaysia: +60 XX-XXX XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)} ${rest.slice(5)}`;
      if (rest.length === 10) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,6)} ${rest.slice(6)}`;
      break;
    }
    case '66': {
      // Thailand: +66 XX-XXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '7': {
      // Russia: +7 XXX XXX-XX-XX
      if (rest.length === 10) return `+${cc} ${rest.slice(0,3)} ${rest.slice(3,6)}-${rest.slice(6,8)}-${rest.slice(8)}`;
      break;
    }
    case '33': {
      // France: +33 X XX XX XX XX
      if (rest.length === 9) return `+${cc} ${rest[0]} ${rest.slice(1,3)} ${rest.slice(3,5)} ${rest.slice(5,7)} ${rest.slice(7)}`;
      break;
    }
    case '39': {
      // Italy: +39 XXX XXX XXXX
      if (rest.length === 10) return `+${cc} ${rest.slice(0,3)} ${rest.slice(3,6)} ${rest.slice(6)}`;
      break;
    }
    case '34': {
      // Spain: +34 XXX XXX XXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,3)} ${rest.slice(3,6)} ${rest.slice(6)}`;
      break;
    }
    case '55': {
      // Brazil: +55 XX XXXXX-XXXX
      if (rest.length === 11) return `+${cc} ${rest.slice(0,2)} ${rest.slice(2,7)}-${rest.slice(7)}`;
      break;
    }
    case '90': {
      // Turkey: +90 XXX XXX XX XX
      if (rest.length === 10) return `+${cc} ${rest.slice(0,3)} ${rest.slice(3,6)} ${rest.slice(6,8)} ${rest.slice(8)}`;
      break;
    }
    case '971': {
      // UAE: +971 XX-XXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '966': {
      // Saudi Arabia: +966 XX-XXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '234': {
      // Nigeria: +234 XXX-XXX-XXXX
      if (rest.length === 10) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,6)}-${rest.slice(6)}`;
      break;
    }
    case '254': {
      // Kenya: +254 XXX-XXXXXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3)}`;
      break;
    }
    case '27': {
      // South Africa: +27 XX-XXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '20': {
      // Egypt: +20 XXX-XXX-XXXX
      if (rest.length === 10) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,6)}-${rest.slice(6)}`;
      break;
    }
    case '51': {
      // Peru: +51 XXX-XXX-XXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,6)}-${rest.slice(6)}`;
      break;
    }
    case '52': {
      // Mexico: +52 XXX-XXX-XXXX
      if (rest.length === 10) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,6)}-${rest.slice(6)}`;
      break;
    }
    case '57': {
      // Colombia: +57 XXX-XXX-XXXX
      if (rest.length === 10) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,6)}-${rest.slice(6)}`;
      break;
    }
    case '93': {
      // Afghanistan: +93 XX-XXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '94': {
      // Sri Lanka: +94 XX-XXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '95': {
      // Myanmar: +95 X-XXX-XXX
      if (rest.length === 7) return `+${cc} ${rest[0]}-${rest.slice(1,4)}-${rest.slice(4)}`;
      if (rest.length === 8) return `+${cc} ${rest[0]}-${rest.slice(1,4)}-${rest.slice(4)}`;
      break;
    }
    case '98': {
      // Iran: +98 XXX-XXX-XXXX
      if (rest.length === 10) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,6)}-${rest.slice(6)}`;
      break;
    }
    case '212': {
      // Morocco: +212 XX-XXXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,6)}-${rest.slice(6)}`;
      break;
    }
    case '213': {
      // Algeria: +213 XXX-XXX-XXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,6)}-${rest.slice(6)}`;
      break;
    }
    case '216': {
      // Tunisia: +216 XX-XXX-XXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '218': {
      // Libya: +218 XX-XXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '233': {
      // Ghana: +233 XX-XXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '256': {
      // Uganda: +256 XXX-XXXXXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3)}`;
      break;
    }
    case '255': {
      // Tanzania: +255 XXX-XXX-XXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,6)}-${rest.slice(6)}`;
      break;
    }
    case '250': {
      // Rwanda: +250 XXX-XXX-XXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,6)}-${rest.slice(6)}`;
      break;
    }
    case '251': {
      // Ethiopia: +251 XX-XXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '252': {
      // Somalia: +252 XX-XXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '253': {
      // Djibouti: +253 XX-XX-XX-XX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,4)}-${rest.slice(4,6)}-${rest.slice(6)}`;
      break;
    }
    case '260': {
      // Zambia: +260 XX-XXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '261': {
      // Madagascar: +261 XX-XX-XXX-XX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,4)}-${rest.slice(4,7)}-${rest.slice(7)}`;
      break;
    }
    case '263': {
      // Zimbabwe: +263 XX-XXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '264': {
      // Namibia: +264 XX-XXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '265': {
      // Malawi: +265 X-XXXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest[0]}-${rest.slice(1,5)}-${rest.slice(5)}`;
      break;
    }
    case '267': {
      // Botswana: +267 XX-XXX-XXXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '852': {
      // Hong Kong: +852 XXXX-XXXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,4)}-${rest.slice(4)}`;
      break;
    }
    case '853': {
      // Macau: +853 XXXX-XXXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,4)}-${rest.slice(4)}`;
      break;
    }
    case '886': {
      // Taiwan: +886 XXX-XXX-XXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,6)}-${rest.slice(6)}`;
      break;
    }
    case '960': {
      // Maldives: +960 XXX-XXXX
      if (rest.length === 7) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3)}`;
      break;
    }
    case '961': {
      // Lebanon: +961 XX-XXX-XXX
      if (rest.length === 7 || rest.length === 8) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '962': {
      // Jordan: +962 X-XXXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest[0]}-${rest.slice(1,5)}-${rest.slice(5)}`;
      break;
    }
    case '963': {
      // Syria: +963 XXX-XXX-XXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,6)}-${rest.slice(6)}`;
      break;
    }
    case '964': {
      // Iraq: +964 XXX-XXX-XXXX
      if (rest.length === 10) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,6)}-${rest.slice(6)}`;
      break;
    }
    case '965': {
      // Kuwait: +965 XXXX-XXXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,4)}-${rest.slice(4)}`;
      break;
    }
    case '968': {
      // Oman: +968 XXXX-XXXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,4)}-${rest.slice(4)}`;
      break;
    }
    case '973': {
      // Bahrain: +973 XXXX-XXXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,4)}-${rest.slice(4)}`;
      break;
    }
    case '974': {
      // Qatar: +974 XXXX-XXXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,4)}-${rest.slice(4)}`;
      break;
    }
    case '975': {
      // Bhutan: +975 XX-XXX-XXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '976': {
      // Mongolia: +976 XX-XX-XXXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,4)}-${rest.slice(4)}`;
      break;
    }
    case '977': {
      // Nepal: +977 XXXX-XXXXXXX
      if (rest.length === 10) return `+${cc} ${rest.slice(0,4)}-${rest.slice(4)}`;
      break;
    }
    case '992': {
      // Tajikistan: +992 XX-XXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '993': {
      // Turkmenistan: +993 XX-XXX-XXXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '994': {
      // Azerbaijan: +994 XX-XXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '995': {
      // Georgia: +995 XXX-XXX-XXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,6)}-${rest.slice(6)}`;
      break;
    }
    case '996': {
      // Kyrgyzstan: +996 XXX-XXX-XXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,6)}-${rest.slice(6)}`;
      break;
    }
    case '998': {
      // Uzbekistan: +998 XX-XXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '32': {
      // Belgium: +32 XXX-XX-XX-XX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,5)}-${rest.slice(5,7)}-${rest.slice(7)}`;
      break;
    }
    case '352': {
      // Luxembourg: +352 XXX-XXX-XXX-XXX
      if (rest.length >= 9) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,6)}-${rest.slice(6,9)}-${rest.slice(9)}`;
      break;
    }
    case '41': {
      // Switzerland: +41 XX-XXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '43': {
      // Austria: +43 XXX-XXXXXXX
      if (rest.length >= 9) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3)}`;
      break;
    }
    case '45': {
      // Denmark: +45 XX-XX-XX-XX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,4)}-${rest.slice(4,6)}-${rest.slice(6)}`;
      break;
    }
    case '46': {
      // Sweden: +46 XX-XXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '47': {
      // Norway: +47 XXX-XX-XXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,5)}-${rest.slice(5)}`;
      break;
    }
    case '48': {
      // Poland: +48 XX-XXX-XX-XX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5,7)}-${rest.slice(7)}`;
      break;
    }
    case '351': {
      // Portugal: +351 XXX-XXX-XXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,6)}-${rest.slice(6)}`;
      break;
    }
    case '354': {
      // Iceland: +354 XXX-XXXX
      if (rest.length === 7) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3)}`;
      break;
    }
    case '355': {
      // Albania: +355 XX-XXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '356': {
      // Malta: +356 XXXX-XXXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,4)}-${rest.slice(4)}`;
      break;
    }
    case '357': {
      // Cyprus: +357 XX-XXX-XXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '358': {
      // Finland: +358 XX-XXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '359': {
      // Bulgaria: +359 XXX-XXX-XXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,6)}-${rest.slice(6)}`;
      break;
    }
    case '370': {
      // Lithuania: +370 XXX-XXXXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3)}`;
      break;
    }
    case '371': {
      // Latvia: +371 XXXX-XXXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,4)}-${rest.slice(4)}`;
      break;
    }
    case '372': {
      // Estonia: +372 XXXX-XXXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,4)}-${rest.slice(4)}`;
      break;
    }
    case '373': {
      // Moldova: +373 XXX-XXXXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3)}`;
      break;
    }
    case '374': {
      // Armenia: +374 XX-XXX-XXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '375': {
      // Belarus: +375 XX-XXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '376': {
      // Andorra: +376 XXX-XXX
      if (rest.length === 6) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3)}`;
      break;
    }
    case '377': {
      // Monaco: +377 XXXX-XXXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,4)}-${rest.slice(4)}`;
      break;
    }
    case '378': {
      // San Marino: +378 XXXX-XXXXX
      if (rest.length >= 9) return `+${cc} ${rest.slice(0,4)}-${rest.slice(4)}`;
      break;
    }
    case '380': {
      // Ukraine: +380 XX-XXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '381': {
      // Serbia: +381 XX-XXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '382': {
      // Montenegro: +382 XX-XXX-XXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '383': {
      // Kosovo: +383 XX-XXX-XXXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '385': {
      // Croatia: +385 XX-XXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '386': {
      // Slovenia: +386 XX-XXX-XXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '387': {
      // Bosnia and Herzegovina: +387 XX-XXX-XXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '389': {
      // North Macedonia: +389 XX-XXX-XXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '420': {
      // Czech Republic: +420 XXX-XXX-XXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,6)}-${rest.slice(6)}`;
      break;
    }
    case '421': {
      // Slovakia: +421 XXX-XXX-XXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,6)}-${rest.slice(6)}`;
      break;
    }
    case '423': {
      // Liechtenstein: +423 XXX-XXX-XXX
      if (rest.length === 7) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,6)}-${rest.slice(6)}`;
      break;
    }
    case '502': {
      // Guatemala: +502 XXXX-XXXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,4)}-${rest.slice(4)}`;
      break;
    }
    case '503': {
      // El Salvador: +503 XXXX-XXXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,4)}-${rest.slice(4)}`;
      break;
    }
    case '504': {
      // Honduras: +504 XXXX-XXXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,4)}-${rest.slice(4)}`;
      break;
    }
    case '505': {
      // Nicaragua: +505 XXXX-XXXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,4)}-${rest.slice(4)}`;
      break;
    }
    case '506': {
      // Costa Rica: +506 XXXX-XXXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,4)}-${rest.slice(4)}`;
      break;
    }
    case '507': {
      // Panama: +507 XXXX-XXXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,4)}-${rest.slice(4)}`;
      break;
    }
    case '591': {
      // Bolivia: +591 X-XXX-XXXX
      if (rest.length === 8) return `+${cc} ${rest[0]}-${rest.slice(1,4)}-${rest.slice(4)}`;
      break;
    }
    case '593': {
      // Ecuador: +593 XX-XXX-XXXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      break;
    }
    case '595': {
      // Paraguay: +595 XXX-XXX-XXX
      if (rest.length === 9) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,6)}-${rest.slice(6)}`;
      break;
    }
    case '597': {
      // Suriname: +597 XXX-XXXX
      if (rest.length === 7) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3)}`;
      break;
    }
    case '598': {
      // Uruguay: +598 XXXX-XXXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,4)}-${rest.slice(4)}`;
      break;
    }
    case '673': {
      // Brunei: +673 XXX-XXXX
      if (rest.length === 7) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3)}`;
      break;
    }
    case '855': {
      // Cambodia: +855 XX-XXX-XXX
      if (rest.length === 8) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,5)}-${rest.slice(5)}`;
      if (rest.length === 9) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3,6)}-${rest.slice(6)}`;
      break;
    }
    case '856': {
      // Laos: +856 XX-XX-XXX-XXX
      if (rest.length === 10) return `+${cc} ${rest.slice(0,2)}-${rest.slice(2,4)}-${rest.slice(4,7)}-${rest.slice(7)}`;
      break;
    }
    case '960': {
      // Maldives: +960 XXX-XXXX
      if (rest.length === 7) return `+${cc} ${rest.slice(0,3)}-${rest.slice(3)}`;
      break;
    }
    default:
      break;
  }

  // Fallback: just return +cc + rest unformatted
  return `+${cc}${rest}`;
}

async function getGroupMembers(groupId) {
  if (!isConnected()) throw new Error('Not connected');
  const meta = await sock.groupMetadata(groupId);
  const myPhone = normalizeJid(sock.user?.id);
  const myLid = normalizeJid(sock.user?.lid);
  const isAdmin = meta.participants?.some(p => {
    const base = normalizeJid(p.id);
    return (base === myPhone || base === myLid) && (p.admin === 'admin' || p.admin === 'superadmin');
  });

  const members = (meta.participants || []).map(p => {
    // Baileys v7: participant.id is often a LID pseudonym.
    // Try to resolve real phone from any available field, fallback to LID digits.
    const rawId = p.id?.split('@')[0] || '';
    let realPhone = p.phoneNumber || p.number || p.phone || rawId;
    realPhone = String(realPhone).replace(/\D/g, '');
    const phone = formatPhone(realPhone);

    // Try contact cache for a saved name
    const contact = contactsCache[p.id]
      || contactsCache[rawId + '@s.whatsapp.net']
      || contactsCache[realPhone + '@s.whatsapp.net'];
    const name = contact?.notify || contact?.name || contact?.verifiedName || null;

    return {
      id: p.id,
      name: name || null,
      phone,
      isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
    };
  });

  return {
    groupName: meta.subject,
    isAdmin,
    members,
  };
}

async function removeMember(groupId, memberJid) {
  if (!isConnected()) throw new Error('Not connected');
  const meta = await sock.groupMetadata(groupId);
  const myPhone = normalizeJid(sock.user?.id);
  const myLid = normalizeJid(sock.user?.lid);
  const amAdmin = meta.participants?.some(p => {
    const base = normalizeJid(p.id);
    return (base === myPhone || base === myLid) && (p.admin === 'admin' || p.admin === 'superadmin');
  });
  if (!amAdmin) throw new Error('You are not an admin in this group');

  const target = meta.participants?.find(p => p.id === memberJid);
  if (!target) throw new Error('Member not found');
  if (target.admin === 'superadmin') throw new Error('Cannot remove group owner');

  await sock.groupParticipantsUpdate(groupId, [memberJid], 'remove');
  return { success: true };
}

// Start on load
connectToWhatsApp();

module.exports = {
  getStatus,
  getSocket,
  isConnected,
  getGroups,
  getGroupMembers,
  removeMember,
  clearSessionAndRestart,
  QR_CACHE,
};
