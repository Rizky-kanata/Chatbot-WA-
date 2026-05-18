require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCodeRenderer = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
const Groq = require('groq-sdk');

const RAGEngine = require('./lib/rag');
const DatasetManager = require('./lib/dataset');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

app.get('/welcome', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'welcome.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const ragEngine = new RAGEngine();
const datasetManager = new DatasetManager();

let client = null;
let qrCodeData = null;
let isReady = false;
let isCleaning = false;
let isInitializing = false;

const handledMessageIds = new Set();
const recentChatContexts = new Map();
const knowledgeFile = path.join(__dirname, 'knowledge.json');
const behaviorFile = path.join(__dirname, 'config', 'behavior.json');
const CHAT_CONTEXT_TTL_MS = 30 * 60 * 1000;
const GENERAL_SCOPE_HINTS = [
  'produk',
  'barang',
  'jual',
  'harga',
  'eiger',
  'foot ware',
  'footware',
  'footwear',
  'alas kaki',
  'sanda',
  'sandal',
  'sendal',
  'sandals',
  'sepatu',
  'shoes',
  'outdoor',
  'diskon',
  'clearance',
];

const CATALOG_OVERVIEW_HINTS = [
  'jualan apa',
  'jual apa',
  'jual apa saja',
  'jualan apa saja',
  'ada apa saja',
  'ada produk apa',
  'ada barang apa',
  'produk apa',
  'barang apa',
  'jual barang apa',
  'menjual apa',
  'produk yang dijual apa',
  'barang yang dijual apa',
  'toko ini jual apa',
  'store ini jual apa',
  'kamu jual apa',
  'kalian jual apa',
  'kategori produk',
  'kategori barang',
  'kategori apa saja',
];

const CATALOG_LIST_HINTS = [
  'daftar produk',
  'katalog produk',
  'semua produk',
  'daftar barang',
  'daftar item',
  'produk apa saja',
  'barang apa saja',
  'barang apa aja',
  'produk apa aja',
  'produk yang ada',
  'barang yang ada',
  'lihat produk',
  'lihat daftar produk',
  'lihat katalog',
  'tampilkan produk',
  'tampilkan semua produk',
  'tampilkan daftar produk',
  'tampilkan katalog',
  'etalase produk',
];

const CATALOG_LIST_PAGE_SIZE = 10;

const CATEGORY_MENU_HINTS = [
  'kategori tersedia',
  'kategori produk',
];

const CATEGORY_RULES = [
  {
    key: 'footware',
    label: 'Foot ware',
    aliases: ['foot ware', 'footware', 'footwear', 'alas kaki', 'sanda', 'sandal', 'sendal', 'sandals', 'sepatu', 'shoes'],
    include: [/\bshoes?\b/i, /\bsandals?\b/i],
    exclude: [/\bbag\b/i],
  },
];

const PRODUCT_HINTS = [...new Set(CATEGORY_RULES.flatMap((rule) => rule.aliases))];

const HELP_HINTS = [
  'menu',
  'help',
  'bantuan',
  'daftar chat',
  'contoh chat',
  'cara pakai',
  'panduan',
  'perintah',
  'fitur',
];

const WELCOME_HINTS = [
  'halo',
  'hallo',
  'hai',
  'hi',
  'hello',
  'selamat pagi',
  'selamat siang',
  'selamat sore',
  'selamat malam',
  'assalamualaikum',
  'assalamu alaikum',
  'permisi',
  'misi',
  'p',
  'ping',
  'tes',
  'test',
  'cek',
  'kak',
  'min',
  'admin',
  'gan',
  'bos',
  'bro',
];

const CHEAP_FOLLOWUP_HINTS = [
  'yang murah',
  'pilih yang murah',
  'pilihkan yang murah',
  'pilihin yang murah',
  'paling murah',
  'yang paling murah',
  'termurah',
  'yang termurah',
];

const EXPENSIVE_FOLLOWUP_HINTS = [
  'yang mahal',
  'pilih yang mahal',
  'pilihkan yang mahal',
  'pilihin yang mahal',
  'paling mahal',
  'yang paling mahal',
  'termahal',
  'yang termahal',
];

const POPULAR_FOLLOWUP_HINTS = [
  'yang terlaris',
  'pilih yang terlaris',
  'pilihkan yang terlaris',
  'pilihin yang terlaris',
  'paling laris',
  'yang paling laris',
  'terlaris',
  'best seller',
  'bestseller',
];
const browserCandidates = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

if (!fs.existsSync(knowledgeFile)) {
  fs.writeFileSync(
    knowledgeFile,
    JSON.stringify({ keywords: {}, responses: {} }, null, 2)
  );
}

function loadKnowledge() {
  try {
    const data = fs.readFileSync(knowledgeFile, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading knowledge:', error);
    return { keywords: {}, responses: {} };
  }
}

function saveKnowledge(data) {
  try {
    fs.writeFileSync(knowledgeFile, JSON.stringify(data, null, 2));
    ragEngine.clearCache();
    return true;
  } catch (error) {
    console.error('Error saving knowledge:', error);
    return false;
  }
}

function loadBehavior() {
  try {
    if (!fs.existsSync(behaviorFile)) {
      return null;
    }

    const content = fs.readFileSync(behaviorFile, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error('Error loading behavior config:', error.message);
    return null;
  }
}

function getDefaultBehavior() {
  return {
    language: 'id',
    max_sentences: 3,
    reply_style: 'singkat',
    store_name: 'EIGER Official Shop',
    store_location: 'Belum diatur',
    store_scope:
      'produk EIGER kategori Foot ware seperti sandal dan sepatu yang ada di katalog toko',
    catalog_overview_response:
      'Nomor ini khusus melayani kategori Foot ware EIGER, seperti sandal dan sepatu sesuai katalog toko.',
    welcome_response:
      'Selamat datang di store kami. Saya siap membantu info produk Foot ware yang tersedia di katalog. Ketik "jualan apa", "tampilkan semua produk", atau sebutkan produk yang Anda cari.',
    help_response:
      'Menu contoh chat:\n\n1. Ketik "jualan apa" untuk melihat kategori yang dilayani.\n2. Ketik "tampilkan semua produk" untuk melihat 10 produk pertama.\n3. Setelah daftar muncul, balas "1" sampai "10" untuk pilih produk pada halaman itu.\n4. Ketik "halaman 2" untuk lanjut ke halaman berikutnya.\n5. Ketik "Foot ware" untuk melihat rekomendasi kategori ini.\n6. Setelah rekomendasi muncul, balas "1", "2", atau "3" untuk pilih produk.\n7. Ketik "sepatu eiger" untuk mencari produk sepatu.\n8. Ketik "sandal eiger" untuk mencari produk sandal.\n9. Setelah hasil muncul, ketik "yang murah" untuk pilihan termurah.\n10. Setelah hasil muncul, ketik "yang terlaris" untuk produk paling laris.\n11. Setelah hasil muncul, ketik "yang paling mahal" untuk produk harga tertinggi.\n12. Ketik target harga seperti "200.000" untuk mencari harga terdekat.\n13. Ketik "nama toko" atau "lokasi toko" untuk info toko.\n\nCatatan: nomor ini khusus kategori Foot ware.',
    system_instructions:
      'Anda adalah asisten chat toko. Jawab hanya seputar produk yang ada di katalog dan profil toko yang tersedia di sistem. Untuk pertanyaan umum produk, rekomendasikan 1 sampai 3 item paling relevan dari konteks beserta harga jika ada. Jangan mengarang stok, alamat detail, atau informasi di luar data. Jika ditanya di luar ruang lingkup toko, tolak dengan sopan menggunakan respons out-of-scope yang tersedia.',
    fallback_response:
      'Mohon maaf, produk Foot ware yang Anda cari belum ditemukan di katalog toko kami. Coba sebutkan sandal, sepatu, nama model, atau target harga.',
    out_of_scope_response:
      'Maaf, nomor ini khusus melayani kategori Foot ware EIGER. Untuk kategori Tas, Pakaian, Aksesoris, atau Perlengkapan Kemah, silakan pilih lewat halaman welcome page.',
    store_name_response:
      'Nama toko kami adalah EIGER Official Shop.',
    store_location_response:
      'Lokasi toko belum tersedia di dataset ini. Silakan cek alamat lengkap di halaman Shopee toko.',
  };
}

function resolveBehavior() {
  return {
    ...getDefaultBehavior(),
    ...(loadBehavior() || {}),
  };
}

function normalizeIntentText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsAnyPhrase(text, phrases) {
  return phrases.some((phrase) => text.includes(phrase));
}

function matchesAnyPhraseExactly(text, phrases) {
  return phrases.some((phrase) => text === phrase);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function queryMatchesAliases(text, aliases) {
  return aliases.some((alias) => {
    const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(alias)}(?:$|\\s)`);
    return pattern.test(text);
  });
}

function isStoreLocationQuestion(text) {
  return containsAnyPhrase(text, [
    'lokasi toko',
    'alamat toko',
    'dimana toko',
    'di mana toko',
    'lokasi store',
    'alamat store',
    'alamatnya dimana',
    'alamatnya di mana',
  ]);
}

function isStoreNameQuestion(text) {
  return containsAnyPhrase(text, [
    'nama toko',
    'nama store',
    'nama seller',
    'nama tokonya',
    'ini toko apa',
    'ini store apa',
  ]);
}

function isCatalogOverviewQuestion(text) {
  return matchesAnyPhraseExactly(text, CATALOG_OVERVIEW_HINTS) || text === 'eiger';
}

function isCatalogListQuestion(text) {
  if (matchesAnyPhraseExactly(text, CATALOG_LIST_HINTS)) {
    return true;
  }

  return CATALOG_LIST_HINTS.some((phrase) => {
    const pagePattern = new RegExp(`^${phrase}\\s+\\d{1,2}$`);
    return pagePattern.test(text);
  });
}

function isCatalogPageFollowup(text) {
  return /^\d{1,2}$/.test(text);
}

function isCatalogPageCommand(text) {
  return /^(halaman|page|hlm|lanjut)(\s+ke)?\s+\d{1,2}$/i.test(text);
}

function isHelpQuestion(text) {
  return text === '?' || containsAnyPhrase(text, HELP_HINTS);
}

function isCheapFollowupQuestion(text) {
  if (CHEAP_FOLLOWUP_HINTS.some((phrase) => text === phrase)) {
    return true;
  }

  return [
    /^(yang\s+)?(paling\s+)?murah(\s+\w+)?$/i,
    /^(pilih|pilihin|pilihkan|carikan|kasih|rekomendasi(in)?)\s+yang\s+(paling\s+)?murah(\s+\w+)?$/i,
  ].some((pattern) => pattern.test(text));
}

function isExpensiveFollowupQuestion(text) {
  if (EXPENSIVE_FOLLOWUP_HINTS.some((phrase) => text === phrase)) {
    return true;
  }

  return [
    /^(yang\s+)?(paling\s+)?mahal(\s+\w+)?$/i,
    /^(pilih|pilihin|pilihkan|carikan|kasih|rekomendasi(in)?)\s+yang\s+(paling\s+)?mahal(\s+\w+)?$/i,
  ].some((pattern) => pattern.test(text));
}

function isPopularFollowupQuestion(text) {
  if (POPULAR_FOLLOWUP_HINTS.some((phrase) => text === phrase)) {
    return true;
  }

  return [
    /^(yang\s+)?(paling\s+)?laris(\s+\w+)?$/i,
    /^(yang\s+)?terlaris(\s+\w+)?$/i,
    /^(pilih|pilihin|pilihkan|carikan|kasih|rekomendasi(in)?)\s+yang\s+(paling\s+)?laris(\s+\w+)?$/i,
    /^(pilih|pilihin|pilihkan|carikan|kasih|rekomendasi(in)?)\s+yang\s+terlaris(\s+\w+)?$/i,
  ].some((pattern) => pattern.test(text));
}

function isWelcomeQuestion(text) {
  if (matchesAnyPhraseExactly(text, WELCOME_HINTS)) {
    return true;
  }

  return [
    /^(halo|hallo|hai|hi|hello)\s+(kak|min|admin|gan|bos|bro)$/i,
    /^(selamat pagi|selamat siang|selamat sore|selamat malam)\s+(kak|min|admin|gan|bos|bro)$/i,
    /^(permisi|assalamualaikum|assalamu alaikum)\s+(kak|min|admin|gan|bos|bro)$/i,
    /^(tes|test|cek)\s+(kak|min|admin|gan|bos|bro)$/i,
  ].some((pattern) => pattern.test(text));
}

function isCategoryMenuQuestion(text) {
  return matchesAnyPhraseExactly(text, CATEGORY_MENU_HINTS);
}

function getCategoryRuleForQuery(text) {
  return CATEGORY_RULES.find((rule) => queryMatchesAliases(text, rule.aliases)) || null;
}

function isProductScopeQuestion(text) {
  return (
    isHelpQuestion(text) ||
    isCatalogListQuestion(text) ||
    isCatalogOverviewQuestion(text) ||
    GENERAL_SCOPE_HINTS.some((hint) => text.includes(hint)) ||
    PRODUCT_HINTS.some((hint) => text.includes(hint)) ||
    /[a-z]{2,}\d{1,}[a-z0-9-]*/i.test(text)
  );
}

async function sendBotMessage(msg, text) {
  if (client) {
    try {
      await client.sendMessage(msg.from, text);
      return;
    } catch (error) {
      console.error('Error sending direct message:', error.message);
    }
  }

  await msg.reply(text);
}

function setRecentChatContext(chatId, context) {
  if (!chatId || !context) {
    return;
  }

  recentChatContexts.set(chatId, {
    ...context,
    savedAt: Date.now(),
  });
}

function getRecentChatContext(chatId) {
  if (!chatId || !recentChatContexts.has(chatId)) {
    return null;
  }

  const context = recentChatContexts.get(chatId);
  if (!context || Date.now() - context.savedAt > CHAT_CONTEXT_TTL_MS) {
    recentChatContexts.delete(chatId);
    return null;
  }

  return context;
}

function extractProductTitle(item) {
  const titleLine = (item.text || '')
    .split('\n')
    .find((line) => line.toLowerCase().startsWith('nama produk:'));
  return titleLine ? titleLine.replace(/^Nama produk:\s*/i, '').trim() : item.source;
}

function extractProductPrice(item) {
  const priceLine = (item.text || '')
    .split('\n')
    .find((line) => line.toLowerCase().startsWith('harga:'));
  return priceLine ? priceLine.replace(/^Harga:\s*/i, '').trim() : '';
}

function extractProductDiscount(item) {
  const discountLine = (item.text || '')
    .split('\n')
    .find((line) => line.toLowerCase().startsWith('diskon:'));
  return discountLine ? discountLine.replace(/^Diskon:\s*/i, '').trim() : '';
}

function parsePriceValue(priceText) {
  const digits = String(priceText || '').replace(/[^0-9]/g, '');
  if (!digits) {
    return null;
  }

  const value = Number(digits);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function extractTargetPrice(message) {
  const text = String(message || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) {
    return null;
  }

  const patterns = [
    /^(?:rp\s*)?(\d{1,3}(?:[.,\s]\d{3})+|\d+)(?:\s*(rb|ribu|k|jt|juta))?(?:\s+(dong|aja|saja))?$/i,
    /^(?:(?:yang|sekitar|kisaran|budget|harga|di harga|range|rentang)\s+)+(?:rp\s*)?(\d{1,3}(?:[.,\s]\d{3})+|\d+)(?:\s*(rb|ribu|k|jt|juta))?(?:\s+(dong|aja|saja))?$/i,
    /^(?:(?:pilih|pilihin|pilihkan|carikan|cari|kasih|rekomendasi(?:in)?)\s+)+(?:(?:yang|harga|sekitar|kisaran|budget)\s+)?(?:rp\s*)?(\d{1,3}(?:[.,\s]\d{3})+|\d+)(?:\s*(rb|ribu|k|jt|juta))?(?:\s+(dong|aja|saja))?$/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) {
      continue;
    }

    const rawNumber = match[1] || '';
    const unit = (match[2] || '').toLowerCase();
    const compactNumber = rawNumber.replace(/[.,\s]/g, '');
    if (!compactNumber) {
      continue;
    }

    if (!unit && compactNumber.length < 4) {
      continue;
    }

    let value = Number(compactNumber);
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }

    if (unit === 'rb' || unit === 'ribu' || unit === 'k') {
      value *= 1000;
    } else if (unit === 'jt' || unit === 'juta') {
      value *= 1000000;
    }

    if (value >= 1000) {
      return value;
    }
  }

  return null;
}

function formatPriceNumber(value) {
  return Number(value || 0).toLocaleString('id-ID');
}

function extractSoldLabel(item) {
  const soldLine = (item.text || '').split('\n').find((line) => /terjual/i.test(line));
  if (!soldLine) {
    return '';
  }

  return soldLine.replace(/^[^:]+:\s*/i, '').trim();
}

function extractSoldScore(item) {
  const soldLabel = extractSoldLabel(item).toUpperCase();
  if (!soldLabel) {
    return 0;
  }

  const rbMatch = soldLabel.match(/(\d+(?:[.,]\d+)?)RB\+?/);
  if (rbMatch) {
    return Math.round(Number(rbMatch[1].replace(',', '.')) * 1000);
  }

  const numericMatch = soldLabel.match(/(\d+(?:[.,]\d+)?)/);
  if (numericMatch) {
    return Math.round(Number(numericMatch[1].replace(/\./g, '').replace(',', '.')));
  }

  return 0;
}

function truncateText(text, maxLength = 88) {
  if (!text || text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3).trim()}...`;
}

function extractRequestedPage(text) {
  const match = text.match(/\b(\d{1,2})\b/);
  if (!match) {
    return 1;
  }

  const page = Number(match[1]);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

function getCatalogPageData(documents, requestedPage = 1) {
  const totalItems = documents.length;
  if (totalItems === 0) {
    return {
      totalItems: 0,
      totalPages: 1,
      currentPage: 1,
      startIndex: 0,
      pageItems: [],
    };
  }

  const totalPages = Math.max(1, Math.ceil(totalItems / CATALOG_LIST_PAGE_SIZE));
  const currentPage = Math.min(Math.max(requestedPage, 1), totalPages);
  const startIndex = (currentPage - 1) * CATALOG_LIST_PAGE_SIZE;
  const pageItems = documents.slice(startIndex, startIndex + CATALOG_LIST_PAGE_SIZE);

  return {
    totalItems,
    totalPages,
    currentPage,
    startIndex,
    pageItems,
  };
}

function buildCatalogListResponse(documents, requestedPage = 1) {
  const { totalItems, totalPages, currentPage, startIndex, pageItems } = getCatalogPageData(
    documents,
    requestedPage
  );

  if (totalItems === 0) {
    return 'Daftar produk saat ini kosong.';
  }

  const lines = [
    `Daftar produk toko - halaman ${currentPage}/${totalPages} (${totalItems} produk, menampilkan ${startIndex + 1}-${startIndex + pageItems.length}):`,
    '',
  ];

  pageItems.forEach((item, index) => {
    const title = truncateText(extractProductTitle(item), 92);
    const price = extractProductPrice(item);
    lines.push(`${index + 1}. ${title}${price ? ` - Harga: ${price}` : ''}`);
  });

  lines.push('');
  lines.push(`Balas angka 1 sampai ${pageItems.length} untuk pilih produk di halaman ini.`);

  if (currentPage < totalPages) {
    lines.push(`Ketik "halaman ${currentPage + 1}" untuk melihat halaman berikutnya.`);
  }

  if (currentPage > 1) {
    lines.push(`Ketik "halaman ${currentPage - 1}" untuk kembali ke halaman sebelumnya.`);
  }

  lines.push('');
  lines.push(
    'Ketik "yang murah", "yang terlaris", "yang paling mahal", atau kirim target harga seperti "50.000".'
  );

  return lines.join('\n');
}

function buildBroadMatchResponse(query, matches) {
  const lines = [
    `Saya belum menemukan kecocokan yang persis untuk "${query}", tapi ada beberapa produk yang paling mendekati di katalog kami:`,
    '',
  ];

  matches.slice(0, 3).forEach((item, index) => {
    const title = extractProductTitle(item);
    const price = extractProductPrice(item);
    lines.push(`${index + 1}. ${title}${price ? ` - Harga: ${price}` : ''}`);
  });

  lines.push('');
  lines.push(
    `Balas angka 1 sampai ${Math.min(matches.length, 3)} untuk pilih produk, atau ketik "yang murah", "yang terlaris", "yang paling mahal", atau kirim target harga seperti "50.000".`
  );
  return lines.join('\n');
}

function filterDocumentsByCategory(rule, documents) {
  return documents.filter((item) => {
    const haystack = `${extractProductTitle(item)}\n${item.text || ''}`;
    const hasIncludeMatch = rule.include.some((pattern) => pattern.test(haystack));
    if (!hasIncludeMatch) {
      return false;
    }

    return !rule.exclude.some((pattern) => pattern.test(haystack));
  });
}

function buildCategoryResponse(rule, query, matches) {
  const lines = [
    `Berikut ${Math.min(matches.length, 3)} rekomendasi ${rule.label} yang paling relevan untuk "${query}":`,
    '',
  ];

  matches.slice(0, 3).forEach((item, index) => {
    const title = truncateText(extractProductTitle(item), 92);
    const price = extractProductPrice(item);
    const soldLabel = extractSoldLabel(item);
    const extra = [price ? `Harga: ${price}` : '', soldLabel ? `Terjual: ${soldLabel}` : ''].filter(Boolean).join(' | ');
    lines.push(`${index + 1}. ${title}${extra ? ` - ${extra}` : ''}`);
  });

  lines.push('');
  lines.push(
    `Balas angka 1 sampai ${Math.min(matches.length, 3)} untuk pilih produk, atau ketik "yang murah", "yang terlaris", "yang paling mahal", atau kirim target harga seperti "50.000".`
  );
  return lines.join('\n');
}

function buildCategoryMenuResponse() {
  const lines = ['Kategori produk yang tersedia:', ''];

  CATEGORY_RULES.forEach((rule, index) => {
    lines.push(`${index + 1}. ${rule.label}`);
  });

  lines.push('');
  lines.push(
    'Ketik Foot ware, sandal, atau sepatu untuk melihat rekomendasi produk.'
  );

  return lines.join('\n');
}

function buildWelcomeResponse(behavior) {
  const hasStoreName =
    behavior.store_name && normalizeIntentText(behavior.store_name) !== 'belum diatur';
  const storeLabel = hasStoreName ? behavior.store_name : 'store kami';

  if (behavior.welcome_response) {
    return behavior.welcome_response.replace(/\{store_name\}/gi, storeLabel);
  }

  return `Selamat datang di ${storeLabel}. Saya siap membantu info produk yang tersedia di katalog. Ketik "jualan apa", "daftar produk", atau sebutkan produk yang Anda cari.`;
}

function getComparableCatalogEntries(chatContext) {
  if (!chatContext || !Array.isArray(chatContext.documents) || chatContext.documents.length === 0) {
    return [];
  }

  return chatContext.documents.map((item) => {
    const priceText = extractProductPrice(item);
    const soldLabel = extractSoldLabel(item);
    return {
      item,
      priceText,
      priceValue: parsePriceValue(priceText),
      soldLabel,
      soldScore: extractSoldScore(item),
    };
  });
}

function buildRankedRecommendationResponse(chatContext, mode, targetPrice = null) {
  if (!chatContext || !Array.isArray(chatContext.documents) || chatContext.documents.length === 0) {
    return {
      text: 'Silakan sebutkan dulu kategori atau produk yang ingin dicari, misalnya: Foot ware, sandal, atau sepatu.',
      options: [],
    };
  }

  const comparableEntries = getComparableCatalogEntries(chatContext);
  let rankedEntries = [];
  let intro = '';

  if (mode === 'cheap') {
    rankedEntries = comparableEntries
      .filter((entry) => entry.priceValue !== null)
      .sort((a, b) => {
        if (a.priceValue !== b.priceValue) {
          return a.priceValue - b.priceValue;
        }

        return b.soldScore - a.soldScore;
      });
    intro = chatContext.query
      ? `Berikut rekomendasi ${chatContext.label || 'produk'} yang paling murah untuk "${chatContext.query}":`
      : `Berikut rekomendasi ${chatContext.label || 'produk'} yang paling murah:`;
  } else if (mode === 'expensive') {
    rankedEntries = comparableEntries
      .filter((entry) => entry.priceValue !== null)
      .sort((a, b) => {
        if (a.priceValue !== b.priceValue) {
          return b.priceValue - a.priceValue;
        }

        return b.soldScore - a.soldScore;
      });
    intro = chatContext.query
      ? `Berikut rekomendasi ${chatContext.label || 'produk'} yang paling mahal untuk "${chatContext.query}":`
      : `Berikut rekomendasi ${chatContext.label || 'produk'} yang paling mahal:`;
  } else if (mode === 'popular') {
    rankedEntries = comparableEntries
      .slice()
      .sort((a, b) => {
        if (b.soldScore !== a.soldScore) {
          return b.soldScore - a.soldScore;
        }

        if (a.priceValue !== null && b.priceValue !== null && a.priceValue !== b.priceValue) {
          return a.priceValue - b.priceValue;
        }

        return extractProductTitle(a.item).localeCompare(extractProductTitle(b.item));
      });
    intro = chatContext.query
      ? `Berikut rekomendasi ${chatContext.label || 'produk'} yang paling laris untuk "${chatContext.query}":`
      : `Berikut rekomendasi ${chatContext.label || 'produk'} yang paling laris:`;
  } else if (mode === 'price_target') {
    rankedEntries = comparableEntries
      .filter((entry) => entry.priceValue !== null)
      .sort((a, b) => {
        const diffA = Math.abs(a.priceValue - targetPrice);
        const diffB = Math.abs(b.priceValue - targetPrice);
        if (diffA !== diffB) {
          return diffA - diffB;
        }

        if (a.priceValue !== b.priceValue) {
          return a.priceValue - b.priceValue;
        }

        return b.soldScore - a.soldScore;
      });
    intro = chatContext.query
      ? `Berikut rekomendasi ${chatContext.label || 'produk'} dengan harga terdekat ke ${formatPriceNumber(
          targetPrice
        )} untuk "${chatContext.query}":`
      : `Berikut rekomendasi ${chatContext.label || 'produk'} dengan harga terdekat ke ${formatPriceNumber(
          targetPrice
        )}:`;
  }

  if (rankedEntries.length === 0) {
    return {
      text: `Saya belum menemukan data yang bisa dibandingkan untuk ${chatContext.label || 'produk terakhir'}.`,
      options: [],
    };
  }

  if (mode === 'popular' && rankedEntries.every((entry) => entry.soldScore === 0)) {
    return {
      text: `Saya belum menemukan data penjualan yang cukup untuk menentukan produk terlaris pada ${chatContext.label || 'produk terakhir'}.`,
      options: [],
    };
  }

  const lines = [intro, ''];
  const visibleEntries = rankedEntries.slice(0, 3);

  visibleEntries.forEach((entry, index) => {
    const title = truncateText(extractProductTitle(entry.item), 92);
    const extra = [
      entry.priceText ? `Harga: ${entry.priceText}` : '',
      entry.soldLabel ? `Terjual: ${entry.soldLabel}` : '',
    ]
      .filter(Boolean)
      .join(' | ');
    lines.push(`${index + 1}. ${title}${extra ? ` - ${extra}` : ''}`);
  });

  lines.push('');
  lines.push(
    `Balas angka 1 sampai ${visibleEntries.length} untuk pilih produk dari hasil ini.`
  );

  return {
    text: lines.join('\n'),
    options: visibleEntries.map((entry) => entry.item),
  };
}

function buildSelectedProductResponse(chatContext, selectedIndex) {
  if (
    !chatContext ||
    !Array.isArray(chatContext.options) ||
    chatContext.options.length === 0 ||
    selectedIndex < 1 ||
    selectedIndex > chatContext.options.length
  ) {
    return null;
  }

  const item = chatContext.options[selectedIndex - 1];
  const lines = [
    `Pilihan ${selectedIndex}:`,
    '',
    `Nama produk: ${extractProductTitle(item)}`,
  ];

  const price = extractProductPrice(item);
  const discount = extractProductDiscount(item);
  const soldLabel = extractSoldLabel(item);

  if (price) {
    lines.push(`Harga: ${price}`);
  }

  if (discount) {
    lines.push(`Diskon: ${discount}`);
  }

  if (soldLabel) {
    lines.push(`Terjual: ${soldLabel}`);
  }

  lines.push('');
  lines.push('Ketik "yang murah", "yang terlaris", "yang paling mahal", atau cari produk lain jika ingin lanjut.');

  return lines.join('\n');
}

function getCategoryMatches(query, documents, topK = 3) {
  const normalizedQuery = normalizeIntentText(query);
  const categoryRule = getCategoryRuleForQuery(normalizedQuery);
  if (!categoryRule) {
    return null;
  }

  const categoryDocs = filterDocumentsByCategory(categoryRule, documents);
  if (categoryDocs.length === 0) {
    return { rule: categoryRule, matches: [] };
  }

  const relevantMatches = ragEngine
    .retrieveBroadContext(query, categoryDocs, Math.max(topK * 2, 6))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return extractSoldScore(b) - extractSoldScore(a);
    });

  if (relevantMatches.length > 0) {
    return { rule: categoryRule, matches: relevantMatches.slice(0, topK) };
  }

  const popularMatches = categoryDocs
    .slice()
    .sort((a, b) => extractSoldScore(b) - extractSoldScore(a))
    .slice(0, topK);

  return { rule: categoryRule, matches: popularMatches };
}

function getDirectBehaviorResponse(message, behavior) {
  const normalizedMessage = normalizeIntentText(message);

  if (isWelcomeQuestion(normalizedMessage)) {
    return buildWelcomeResponse(behavior);
  }

  if (isCategoryMenuQuestion(normalizedMessage)) {
    return buildCategoryMenuResponse();
  }

  if (isHelpQuestion(normalizedMessage)) {
    return (
      behavior.help_response ||
      'Ketik menu, jualan apa, daftar produk, nama toko, atau lokasi toko untuk mulai.'
    );
  }

  if (isStoreNameQuestion(normalizedMessage)) {
    return behavior.store_name_response || `Nama toko yang saya layani adalah ${behavior.store_name}.`;
  }

  if (isStoreLocationQuestion(normalizedMessage)) {
    return (
      behavior.store_location_response ||
      `Lokasi toko: ${behavior.store_location || 'belum tersedia di sistem kami.'}`
    );
  }

  if (isCatalogOverviewQuestion(normalizedMessage)) {
    return (
      behavior.catalog_overview_response ||
      `Kami menjual ${behavior.store_scope || 'produk yang tersedia di katalog toko kami'}.`
    );
  }

  return null;
}

function getNoContextResponse(message, behavior) {
  const normalizedMessage = normalizeIntentText(message);
  const directResponse = getDirectBehaviorResponse(normalizedMessage, behavior);

  if (directResponse) {
    return { text: directResponse, mode: 'store_profile' };
  }

  if (isProductScopeQuestion(normalizedMessage)) {
    return {
      text:
        behavior.fallback_response ||
        'Mohon maaf, produk yang Anda cari belum ditemukan di katalog toko kami.',
      mode: 'fallback_no_context',
    };
  }

  return {
    text:
      behavior.out_of_scope_response ||
      'Maaf, saya hanya bisa membantu informasi produk dan profil toko yang tersedia di sistem kami.',
    mode: 'out_of_scope',
  };
}

function saveBehavior(obj) {
  try {
    fs.mkdirSync(path.dirname(behaviorFile), { recursive: true });
    fs.writeFileSync(behaviorFile, JSON.stringify(obj, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving behavior config:', error.message);
    return false;
  }
}

function resolveBrowserPath() {
  for (const candidate of browserCandidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function createPuppeteerConfig() {
  const browserPath = resolveBrowserPath();
  const headlessValue = (process.env.WHATSAPP_HEADLESS || 'true').toLowerCase();
  const useHeadless = !['false', '0', 'no'].includes(headlessValue);

  const config = {
    headless: useHeadless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-translate',
      '--disable-extensions',
      '--disable-default-apps',
      '--disable-component-extensions-with-background-pages',
    ],
    timeout: 120000,
  };

  if (browserPath) {
    config.executablePath = browserPath;
  }

  if (process.env.PUPPETEER_USER_DATA_DIR) {
    config.userDataDir = process.env.PUPPETEER_USER_DATA_DIR;
  }

  return { config, browserPath };
}

function generateQrSvgDataUrl(qrText) {
  if (!qrText) {
    return null;
  }

  const qr = new QRCodeRenderer(-1, QRErrorCorrectLevel.L);
  qr.addData(qrText);
  qr.make();

  const cellSize = 8;
  const margin = 4;
  const moduleCount = qr.getModuleCount();
  const size = (moduleCount + margin * 2) * cellSize;
  const rects = [];

  for (let row = 0; row < moduleCount; row += 1) {
    for (let col = 0; col < moduleCount; col += 1) {
      if (qr.isDark(row, col)) {
        rects.push(
          `<rect x="${(col + margin) * cellSize}" y="${(row + margin) * cellSize}" width="${cellSize}" height="${cellSize}"/>`
        );
      }
    }
  }

  const svg = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="QR Code WhatsApp">`,
    `<rect width="${size}" height="${size}" fill="#ffffff"/>`,
    `<g fill="#111827">`,
    rects.join(''),
    '</g>',
    '</svg>',
  ].join('');

  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

function getGroqClient() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return null;
  }

  return new Groq({ apiKey });
}

async function getAIResponse(message, contextItems = [], behavior = null) {
  try {
    const contextBlock = ragEngine.buildContextBlock(contextItems);

    if (!behavior) {
      behavior = resolveBehavior();
    }

    // Jika tidak ada konteks yang relevan, kembalikan fallback tanpa memanggil LLM.
    if (!contextBlock || contextItems.length === 0) {
      return getNoContextResponse(message, behavior);
    }

    const systemParts = [];

    if (behavior.system_instructions) {
      systemParts.push(behavior.system_instructions);
    }

    systemParts.push(
      `Profil toko: nama toko ${behavior.store_name || 'tidak disebutkan'}, lokasi ${behavior.store_location || 'tidak tersedia'}, fokus toko ${behavior.store_scope || 'produk yang ada di katalog'}.`
    );
    systemParts.push(
      `Jawab hanya menggunakan konteks berikut. Jika konteks tidak memadai, jawab: ${behavior.fallback_response}`
    );
    systemParts.push(
      `Jika pengguna bertanya di luar produk atau profil toko, jawab: ${behavior.out_of_scope_response}`
    );
    systemParts.push(
      `Jawab maksimal ${behavior.max_sentences || 3} kalimat. Bahasa: ${behavior.language || 'id'}.`
    );

    const systemMessage = systemParts.join(' ');
    const userMessage = `Konteks:\n${contextBlock}\n\nPertanyaan: ${message}`;
    const groq = getGroqClient();

    if (!groq) {
      console.warn('GROQ_API_KEY belum diatur. Menggunakan fallback response.');
      return getNoContextResponse(message, behavior);
    }

    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userMessage },
      ],
      model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
      max_tokens: Number(process.env.GROQ_MAX_TOKENS || 200),
      temperature: 0.1,
    });

    return {
      text: completion.choices[0].message.content,
      mode: 'model',
    };
  } catch (error) {
    console.error('Error getting AI response:', error.message);
    return null;
  }
}

async function startBot() {
  if (isReady || isInitializing) {
    return { success: false, message: 'Bot sudah berjalan atau sedang dimulai' };
  }

  if (isCleaning) {
    return { success: false, message: 'Bot sedang dihentikan, harap tunggu' };
  }

  isInitializing = true;

  try {
    const clientInstance = initializeClient();
    await clientInstance.initialize();
    isInitializing = false;
    return { success: true, message: 'Bot dimulai, silakan scan QR code' };
  } catch (error) {
    isInitializing = false;
    client = null;
    qrCodeData = null;
    isCleaning = false;
    throw error;
  }
}

function initializeClient() {
  if (client) {
    return client;
  }

  const { config: puppeteerConfig, browserPath } = createPuppeteerConfig();
  console.log(
    `[BOT] Launching WhatsApp client with browser: ${browserPath || 'bundled/default browser'}`
  );

  client = new Client({
    authStrategy: new LocalAuth({ clientId: 'whatsapp-bot' }),
    puppeteer: puppeteerConfig,
  });

  client.on('qr', (qr) => {
    console.log('[QR] QR code generated');
    console.log('\n[SCAN] Scan QR code di bawah untuk connect bot:\n');
    qrCodeData = qr;
    qrcode.generate(qr, { small: true });
    console.log('\n');
  });

  client.on('ready', () => {
    console.log('[READY] Bot is ready!');
    isReady = true;
    isCleaning = false;
  });

  client.on('authenticated', () => {
    console.log('[AUTH] Client authenticated');
  });

  client.on('auth_failure', (message) => {
    console.error('[AUTH] Authentication failure:', message);
  });

  client.on('disconnected', (reason) => {
    console.log('[DISC] Client disconnected:', reason);
    isReady = false;
    client = null;
  });

  const handleIncomingMessage = async (msg, eventName) => {
    try {
      console.log(
        `[${eventName}] from=${msg.from}, fromMe=${msg.fromMe}, body=${JSON.stringify(msg.body)}`
      );

      const messageId = msg && msg.id && msg.id._serialized ? msg.id._serialized : null;

      if (messageId) {
        if (handledMessageIds.has(messageId)) {
          console.log('[SKIP] Ignoring duplicate event for same message');
          return;
        }

        handledMessageIds.add(messageId);
        setTimeout(() => handledMessageIds.delete(messageId), 5 * 60 * 1000);
      }

      if (msg.fromMe) {
        console.log('[SKIP] Ignoring self-sent message to avoid reply loop');
        return;
      }

      const isPersonalChat = msg.from.endsWith('@c.us') || msg.from.endsWith('@lid');
      const isNotStatus = !msg.from.endsWith('@status');

      if (!isPersonalChat || !isNotStatus) {
        console.log(`[SKIP] Ignoring non-personal or status message: from=${msg.from}`);
        return;
      }

      console.log(`[INBOX] Personal message from ${msg.from}: ${msg.body}`);

      try {
        await msg.getChat().then((chat) => chat.sendStateTyping());
      } catch (error) {
        console.log('Note: Cannot show typing indicator');
      }

      const knowledge = loadKnowledge();
      const keyword = msg.body.toLowerCase().trim();
      const behavior = resolveBehavior();
      const normalizedMessage = normalizeIntentText(msg.body);
      const allDocuments = datasetManager.getAllDocuments();
      const targetPrice = extractTargetPrice(msg.body);

      if (isCheapFollowupQuestion(normalizedMessage)) {
        const recentContext = getRecentChatContext(msg.from);
        const rankedResult = buildRankedRecommendationResponse(recentContext, 'cheap');
        if (recentContext) {
          setRecentChatContext(msg.from, {
            ...recentContext,
            options: rankedResult.options,
          });
        }
        await sendBotMessage(msg, rankedResult.text);
        console.log(`[CHEAPEST] Replied with cheapest recommendation for ${msg.from}`);
        return;
      }

      if (isExpensiveFollowupQuestion(normalizedMessage)) {
        const recentContext = getRecentChatContext(msg.from);
        const rankedResult = buildRankedRecommendationResponse(recentContext, 'expensive');
        if (recentContext) {
          setRecentChatContext(msg.from, {
            ...recentContext,
            options: rankedResult.options,
          });
        }
        await sendBotMessage(msg, rankedResult.text);
        console.log(`[EXPENSIVE] Replied with most expensive recommendation for ${msg.from}`);
        return;
      }

      if (isPopularFollowupQuestion(normalizedMessage)) {
        const recentContext = getRecentChatContext(msg.from);
        const rankedResult = buildRankedRecommendationResponse(recentContext, 'popular');
        if (recentContext) {
          setRecentChatContext(msg.from, {
            ...recentContext,
            options: rankedResult.options,
          });
        }
        await sendBotMessage(msg, rankedResult.text);
        console.log(`[POPULAR] Replied with most popular recommendation for ${msg.from}`);
        return;
      }

      if (targetPrice !== null) {
        const recentContext = getRecentChatContext(msg.from);
        const rankedResult = buildRankedRecommendationResponse(recentContext, 'price_target', targetPrice);
        if (recentContext) {
          setRecentChatContext(msg.from, {
            ...recentContext,
            options: rankedResult.options,
          });
        }
        await sendBotMessage(msg, rankedResult.text);
        console.log(
          `[PRICE_TARGET] Replied with nearest price recommendation for ${msg.from} at ${targetPrice}`
        );
        return;
      }

      if (isCatalogPageFollowup(normalizedMessage)) {
        const recentContext = getRecentChatContext(msg.from);
        const requestedPage = extractRequestedPage(normalizedMessage);

        if (
          recentContext &&
          Array.isArray(recentContext.options) &&
          requestedPage >= 1 &&
          requestedPage <= recentContext.options.length
        ) {
          const selectedProductResponse = buildSelectedProductResponse(recentContext, requestedPage);
          if (selectedProductResponse) {
            setRecentChatContext(msg.from, recentContext);
            await sendBotMessage(msg, selectedProductResponse);
            console.log(`[SELECT] Replied with selected product #${requestedPage} for ${msg.from}`);
            return;
          }
        }

        if (recentContext && Array.isArray(recentContext.options) && recentContext.options.length > 0) {
          const currentPage = Number(recentContext.currentPage || 1);
          const totalPages = Number(recentContext.totalPages || currentPage);
          const suggestedPage = currentPage < totalPages ? currentPage + 1 : Math.max(1, currentPage - 1);
          const guidance =
            recentContext.kind === 'catalog_list'
              ? `Pilihan tidak tersedia. Balas angka 1 sampai ${recentContext.options.length} untuk pilih produk, atau ketik "halaman ${suggestedPage}" jika ingin pindah halaman.`
              : `Pilihan tidak tersedia. Balas angka 1 sampai ${recentContext.options.length} untuk pilih produk dari hasil yang sedang tampil.`;
          await sendBotMessage(msg, guidance);
          console.log(`[SELECT] Invalid numeric selection ${requestedPage} for ${msg.from}`);
          return;
        }
      }

      if (isCatalogPageCommand(normalizedMessage)) {
        const recentContext = getRecentChatContext(msg.from);
        const requestedPage = extractRequestedPage(normalizedMessage);
        if (recentContext && recentContext.kind === 'catalog_list') {
          const catalogDocuments = Array.isArray(recentContext.documents)
            ? recentContext.documents
            : allDocuments;
          const catalogResponse = buildCatalogListResponse(catalogDocuments, requestedPage);
          const pageData = getCatalogPageData(catalogDocuments, requestedPage);
          setRecentChatContext(msg.from, {
            ...recentContext,
            kind: 'catalog_list',
            documents: catalogDocuments,
            options: pageData.pageItems,
            currentPage: pageData.currentPage,
            totalPages: pageData.totalPages,
          });
          await sendBotMessage(msg, catalogResponse);
          console.log(`[REPLY] Replied with catalog list page ${requestedPage} from page command`);
          return;
        }
      }

      if (isCatalogListQuestion(normalizedMessage)) {
        const requestedPage = extractRequestedPage(normalizedMessage);
        const catalogResponse = buildCatalogListResponse(allDocuments, requestedPage);
        const pageData = getCatalogPageData(allDocuments, requestedPage);
        setRecentChatContext(msg.from, {
          kind: 'catalog_list',
          label: 'produk katalog',
          query: null,
          documents: allDocuments,
          options: pageData.pageItems,
          currentPage: pageData.currentPage,
          totalPages: pageData.totalPages,
        });
        await sendBotMessage(msg, catalogResponse);
        console.log(`[REPLY] Replied with catalog list page ${requestedPage}`);
        return;
      }

      const directBehaviorResponse = getDirectBehaviorResponse(msg.body, behavior);

      if (directBehaviorResponse) {
        await sendBotMessage(msg, directBehaviorResponse);
        console.log('[REPLY] Replied with store profile response');
        return;
      }

      if (knowledge.responses[keyword]) {
        await sendBotMessage(msg, knowledge.responses[keyword]);
        console.log('[REPLY] Replied with FAQ keyword match');
      } else {
        const contextItems = ragEngine.retrieveContext(
          msg.body,
          allDocuments,
          Number(process.env.RAG_TOP_K || 3)
        );

        console.log(`[RAG] Retrieved ${contextItems.length} relevant context(s)`);

        const categoryMatches = getCategoryMatches(
          msg.body,
          allDocuments,
          Number(process.env.RAG_TOP_K || 3)
        );

        if (categoryMatches && categoryMatches.matches.length > 0) {
          setRecentChatContext(msg.from, {
            kind: 'category',
            label: categoryMatches.rule.label,
            query: msg.body,
            documents: filterDocumentsByCategory(categoryMatches.rule, allDocuments),
            options: categoryMatches.matches.slice(0, 3),
          });
          await sendBotMessage(
            msg,
            buildCategoryResponse(categoryMatches.rule, msg.body, categoryMatches.matches)
          );
          console.log(`[CATEGORY] Replied with category recommendations for query: ${msg.body}`);
          return;
        }

        if (contextItems.length === 0) {
          const broadMatches = ragEngine.retrieveBroadContext(
            msg.body,
            allDocuments,
            Number(process.env.RAG_TOP_K || 3)
          );

          if (broadMatches.length > 0) {
            setRecentChatContext(msg.from, {
              kind: 'broad_match',
              label: 'produk terkait',
              query: msg.body,
              documents: broadMatches,
              options: broadMatches.slice(0, 3),
            });
            await sendBotMessage(msg, buildBroadMatchResponse(msg.body, broadMatches));
            console.log(`[BROAD_MATCH] Sent loose catalog matches for query: ${msg.body}`);
            return;
          }

          const noContextResponse = getNoContextResponse(msg.body, behavior);
          await sendBotMessage(msg, noContextResponse.text);
          console.log(`[${noContextResponse.mode.toUpperCase()}] No relevant product context found for query: ${msg.body}`);
          return;
        }

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('AI response timeout')), 15000)
        );

        try {
          const aiResult = await Promise.race([
            getAIResponse(msg.body, contextItems, behavior),
            timeoutPromise,
          ]);

          if (aiResult && aiResult.text) {
            setRecentChatContext(msg.from, {
              kind: 'rag_context',
              label: 'produk terkait',
              query: msg.body,
              documents: contextItems,
            });
            await sendBotMessage(msg, aiResult.text);

            if (aiResult.mode === 'model') {
              console.log(
                `[REPLY] Replied with context-grounded AI response (RAG contexts: ${contextItems.length})`
              );
            } else {
              console.log(
                `[FALLBACK] Sent fallback response (${aiResult.mode}) despite having ${contextItems.length} context(s)`
              );
            }
          } else {
            await sendBotMessage(msg, 'Maaf, saya tidak memahami pesan Anda. Silakan coba lagi.');
          }
        } catch (aiError) {
          console.error('AI Error:', aiError.message);
          await sendBotMessage(
            msg,
            'Maaf, terjadi kesalahan dalam memproses pesan. Silakan coba lagi.'
          );
        }
      }
    } catch (error) {
      console.error('Message handler error:', error.message);
    }
  };

  client.on('message', (msg) => handleIncomingMessage(msg, 'message'));
  client.on('message_create', (msg) => handleIncomingMessage(msg, 'message_create'));

  return client;
}

app.get('/api/bot/status', (req, res) => {
  res.json({
    isReady,
    isCleaning,
    isInitializing,
    hasQRCode: !!qrCodeData,
  });
});

app.post('/api/bot/start', async (req, res) => {
  try {
    const result = await startBot();
    return res.json(result);
  } catch (error) {
    console.error('Error starting bot:', error.message);
    res.status(500).json({
      message: 'Error memulai bot. Pastikan koneksi internet stabil dan coba lagi.',
      detail: error.message,
      success: false,
    });
  }
});

app.post('/api/bot/stop', async (req, res) => {
  try {
    if (!client) {
      return res.json({ message: 'Bot tidak sedang berjalan', success: false });
    }

    isCleaning = true;
    isReady = false;
    qrCodeData = null;

    const clientToDestroy = client;
    client = null;

    res.json({ message: 'Bot sudah dihentikan', success: true });

    setImmediate(async () => {
      try {
        await clientToDestroy.destroy();
      } catch (destroyError) {
        console.error('Error destroying client:', destroyError.message);
      } finally {
        isCleaning = false;
      }
    });
  } catch (error) {
    console.error('Error stopping bot:', error);
    isCleaning = false;
    res.status(500).json({
      message: `Error menghentikan bot: ${error.message}`,
      success: false,
    });
  }
});

app.get('/api/bot/qr', (req, res) => {
  if (qrCodeData) {
    res.set('Cache-Control', 'no-store');
    res.json({
      qr: qrCodeData,
      imageUrl: generateQrSvgDataUrl(qrCodeData),
    });
  } else {
    res.set('Cache-Control', 'no-store');
    res.json({ qr: null, imageUrl: null });
  }
});

app.get('/api/datasets', (req, res) => {
  res.json({
    datasets: datasetManager.listDatasets(),
    totalDocuments: datasetManager.getAllDocuments().length,
  });
});

app.get('/api/datasets/:name', (req, res) => {
  const docs = datasetManager.getDatasetDocuments(req.params.name);

  if (docs.length === 0) {
    return res.status(404).json({ message: 'Dataset tidak ditemukan' });
  }

  res.json({ documents: docs });
});

app.post('/api/datasets', (req, res) => {
  try {
    const { name, data } = req.body;

    if (!name || !data) {
      return res.status(400).json({ message: 'name dan data harus diisi' });
    }

    const result = datasetManager.saveDataset(name, data);
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: `Error: ${error.message}` });
  }
});

app.get('/api/knowledge/keywords', (req, res) => {
  const knowledge = loadKnowledge();
  res.json(knowledge);
});

app.post('/api/knowledge/keyword', (req, res) => {
  try {
    const { keyword, response } = req.body;

    if (!keyword || !response) {
      return res.status(400).json({
        message: 'Keyword dan response harus diisi',
        success: false,
      });
    }

    const knowledge = loadKnowledge();
    knowledge.responses[keyword.toLowerCase().trim()] = response;

    if (saveKnowledge(knowledge)) {
      res.json({ message: 'Keyword berhasil disimpan', success: true });
    } else {
      res.status(500).json({ message: 'Error menyimpan keyword', success: false });
    }
  } catch (error) {
    res.status(500).json({ message: `Error: ${error.message}`, success: false });
  }
});

app.delete('/api/knowledge/keyword/:keyword', (req, res) => {
  try {
    const keyword = decodeURIComponent(req.params.keyword).toLowerCase();
    const knowledge = loadKnowledge();

    if (knowledge.responses[keyword]) {
      delete knowledge.responses[keyword];

      if (saveKnowledge(knowledge)) {
        res.json({ message: 'Keyword berhasil dihapus', success: true });
      } else {
        res.status(500).json({ message: 'Error menghapus keyword', success: false });
      }
    } else {
      res.status(404).json({ message: 'Keyword tidak ditemukan', success: false });
    }
  } catch (error) {
    res.status(500).json({ message: `Error: ${error.message}`, success: false });
  }
});

app.get('/api/behavior', (req, res) => {
  try {
    const behavior = loadBehavior();

    if (!behavior) {
      return res.status(404).json({ message: 'Behavior config not found' });
    }

    res.json(behavior);
  } catch (error) {
    res.status(500).json({ message: `Error: ${error.message}` });
  }
});

app.post('/api/behavior', (req, res) => {
  try {
    const obj = req.body;

    if (!obj || typeof obj !== 'object') {
      return res.status(400).json({ message: 'Invalid behavior object' });
    }

    const saved = saveBehavior(obj);

    if (saved) {
      return res.json({ message: 'Behavior saved', success: true });
    }

    res.status(500).json({ message: 'Error saving behavior', success: false });
  } catch (error) {
    res.status(500).json({ message: `Error: ${error.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`[SERVER] Server berjalan di http://localhost:${PORT}`);
  console.log(`[ADMIN] Admin Dashboard: http://localhost:${PORT}`);
  console.log(`[DATASET] Datasets loaded: ${datasetManager.listDatasets().length}`);
  console.log(`[ENV] Node ${process.version} on ${os.platform()} ${os.release()}`);

  if (process.env.AUTO_START_BOT !== 'false') {
    setTimeout(() => {
      startBot().catch((error) => {
        console.error('Error auto-starting bot:', error.message);
      });
    }, 500);
  }
});
