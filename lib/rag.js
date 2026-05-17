const STOPWORDS_ID = new Set([
  'yang',
  'dan',
  'di',
  'ke',
  'dari',
  'untuk',
  'dengan',
  'atau',
  'pada',
  'adalah',
  'ini',
  'itu',
  'dalam',
  'juga',
  'karena',
  'agar',
  'sebagai',
  'saat',
  'oleh',
  'akan',
  'bisa',
  'dapat',
  'sudah',
  'belum',
  'kami',
  'kamu',
  'anda',
  'saya',
  'aku',
  'kita',
  'mereka',
  'apa',
  'siapa',
  'kapan',
  'dimana',
  'bagaimana',
  'kenapa',
  'jika',
  'kalau',
]);

const SHORT_PRODUCT_TOKENS = new Set([
  'ws',
  'jr',
  'sl',
  'bp',
  'mm',
  'cm',
  'l',
]);

const TOKEN_ALIASES = new Map([
  ['l', 'liter'],
  ['ltr', 'liter'],
  ['lt', 'liter'],
  ['ws', 'women'],
  ['jr', 'junior'],
  ['anak', 'kids'],
  ['pria', 'men'],
  ['wanita', 'women'],
  ['shoe', 'shoes'],
  ['sepatu', 'shoes'],
  ['sanda', 'sandals'],
  ['sandal', 'sandals'],
  ['sendal', 'sandals'],
]);

class RAGEngine {
  constructor() {
    this.cache = {
      signature: '',
      index: null,
    };
  }

  normalizeText(text) {
    return text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/([a-z]+)\s*-\s*(\d+[a-z]*)/g, '$1$2 $1 $2')
      .replace(/([a-z]+)\s*-\s*([a-z]+)/g, '$1$2 $1 $2')
      .replace(/(\d+)\s*m?\s*[xX]\s*(\d+)\s*m?/g, '$1x$2 $1 x $2')
      .replace(/(\d+)\s*(ltr|liter|lt|l|mm|cm|m)\b/g, '$1$2 $1 $2')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  isUsefulToken(token) {
    if (!token || STOPWORDS_ID.has(token)) {
      return false;
    }

    if (SHORT_PRODUCT_TOKENS.has(token)) {
      return true;
    }

    if (/^\d+$/.test(token)) {
      return token.length > 1;
    }

    if (/\d/.test(token)) {
      return true;
    }

    return token.length > 2;
  }

  expandToken(token) {
    const variants = new Set([token]);
    const tokenAlias = TOKEN_ALIASES.get(token);

    if (tokenAlias) {
      variants.add(tokenAlias);
    }

    const dimensionMatch = token.match(/^(\d+)x(\d+)$/);
    if (dimensionMatch) {
      variants.add(dimensionMatch[1]);
      variants.add(dimensionMatch[2]);
    }

    const numberUnitMatch = token.match(/^(\d+)(ltr|liter|lt|l|mm|cm|m)$/);
    if (numberUnitMatch) {
      variants.add(numberUnitMatch[1]);
      variants.add(numberUnitMatch[2]);

      const unitAlias = TOKEN_ALIASES.get(numberUnitMatch[2]);
      if (unitAlias) {
        variants.add(unitAlias);
      }
    }

    const lettersDigitsMatch = token.match(/^([a-z]+)(\d+[a-z0-9]*)$/);
    if (lettersDigitsMatch) {
      variants.add(lettersDigitsMatch[1]);
      variants.add(lettersDigitsMatch[2]);
    }

    const digitsLettersMatch = token.match(/^(\d+)([a-z]+)$/);
    if (digitsLettersMatch) {
      variants.add(digitsLettersMatch[1]);
      variants.add(digitsLettersMatch[2]);

      const unitAlias = TOKEN_ALIASES.get(digitsLettersMatch[2]);
      if (unitAlias) {
        variants.add(unitAlias);
      }
    }

    return Array.from(variants).filter((item) => this.isUsefulToken(item));
  }

  tokenize(text) {
    if (!text) {
      return [];
    }

    const normalized = this.normalizeText(text);
    if (!normalized) {
      return [];
    }

    return normalized.split(/\s+/).flatMap((token) => this.expandToken(token));
  }

  splitIntoChunks(text, chunkSize = 700, overlap = 120) {
    if (!text) {
      return [];
    }

    const normalized = text.replace(/\r/g, '').trim();
    if (!normalized) {
      return [];
    }

    const chunks = [];
    let start = 0;

    while (start < normalized.length) {
      let end = Math.min(start + chunkSize, normalized.length);

      if (end < normalized.length) {
        const lastBreak = normalized.lastIndexOf('\n', end);
        if (lastBreak > start + 120) {
          end = lastBreak;
        }
      }

      const chunk = normalized.slice(start, end).trim();
      if (chunk.length > 40) {
        chunks.push(chunk);
      }

      if (end >= normalized.length) {
        break;
      }

      start = Math.max(end - overlap, start + 1);
    }

    return chunks;
  }

  buildTfMap(tokens) {
    const tf = new Map();

    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    return tf;
  }

  buildSignature(documents) {
    return JSON.stringify(
      (documents || []).map((doc) => ({
        source: doc.source || '',
        text: doc.text || '',
      }))
    );
  }

  buildRagIndex(documents) {
    if (!documents || documents.length === 0) {
      return { idf: new Map(), vectors: [] };
    }

    const signature = this.buildSignature(documents);
    if (this.cache.signature === signature && this.cache.index) {
      return this.cache.index;
    }

    const tokenizedDocs = documents.map((doc) => this.tokenize(doc.text));
    const normalizedDocs = documents.map((doc) => this.normalizeText(doc.text));
    const docFreq = new Map();

    tokenizedDocs.forEach((tokens) => {
      const uniqueTokens = new Set(tokens);
      uniqueTokens.forEach((token) => {
        docFreq.set(token, (docFreq.get(token) || 0) + 1);
      });
    });

    const totalDocs = Math.max(documents.length, 1);
    const idf = new Map();

    docFreq.forEach((freq, token) => {
      idf.set(token, Math.log((totalDocs + 1) / (freq + 1)) + 1);
    });

    const vectors = tokenizedDocs.map((tokens, idx) => {
      const tf = this.buildTfMap(tokens);
      const vector = new Map();
      let normSquared = 0;

      tf.forEach((count, token) => {
        const weight = count * (idf.get(token) || 0);
        vector.set(token, weight);
        normSquared += weight * weight;
      });

      return {
        source: documents[idx].source,
        text: documents[idx].text,
        normalizedText: normalizedDocs[idx],
        vector,
        norm: Math.sqrt(normSquared),
      };
    });

    const index = { idf, vectors };
    this.cache.signature = signature;
    this.cache.index = index;

    return index;
  }

  retrieveContext(query, documents, topK = 3, minScore = 0.07) {
    if (!documents || documents.length === 0) {
      return [];
    }

    const { idf, vectors } = this.buildRagIndex(documents);
    if (!vectors.length) {
      return [];
    }

    const queryTokens = this.tokenize(query);
    if (!queryTokens.length) {
      return [];
    }

    const normalizedQuery = this.normalizeText(query);

    const queryTf = this.buildTfMap(queryTokens);
    const queryVector = new Map();
    let queryNormSquared = 0;

    queryTf.forEach((count, token) => {
      const weight = count * (idf.get(token) || 0);
      if (weight > 0) {
        queryVector.set(token, weight);
        queryNormSquared += weight * weight;
      }
    });

    const queryNorm = Math.sqrt(queryNormSquared);
    if (!queryNorm) {
      return [];
    }

    const totalQueryTokens = Math.max(queryVector.size, 1);

    const scored = vectors
      .map((item) => {
        if (!item.norm) {
          return { ...item, score: 0 };
        }

        let dot = 0;
        let matchedTokenCount = 0;
        queryVector.forEach((qWeight, token) => {
          const dWeight = item.vector.get(token);
          if (dWeight) {
            dot += qWeight * dWeight;
            matchedTokenCount += 1;
          }
        });

        const baseScore = dot / (queryNorm * item.norm);
        const coverageBoost = 0.7 + (matchedTokenCount / totalQueryTokens) * 0.3;
        const exactPhraseBoost =
          normalizedQuery && item.normalizedText.includes(normalizedQuery) ? 1.15 : 1;

        return {
          source: item.source,
          text: item.text,
          score: baseScore * coverageBoost * exactPhraseBoost,
        };
      })
      .filter((item) => item.score > minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scored;
  }

  retrieveBroadContext(query, documents, topK = 3) {
    return this.retrieveContext(query, documents, topK, 0.015);
  }

  buildContextBlock(contextItems) {
    if (!contextItems || !contextItems.length) {
      return '';
    }

    return contextItems
      .map((item, idx) => {
        const cleanText = item.text.replace(/\s+/g, ' ').trim();
        return `[Konteks ${idx + 1}] Sumber: ${item.source}\n${cleanText}`;
      })
      .join('\n\n');
  }

  clearCache() {
    this.cache.signature = '';
    this.cache.index = null;
  }
}

module.exports = RAGEngine;
