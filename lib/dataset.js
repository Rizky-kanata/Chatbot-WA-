const fs = require('fs');
const path = require('path');

class DatasetManager {
  constructor() {
    this.dataDir = path.join(__dirname, '..', 'data');
    this.activeDatasets = this.parseActiveDatasets(process.env.ACTIVE_DATASET || '');
    this.ensureDataDir();
    this.datasets = new Map();
    this.loadAllDatasets();
  }

  parseActiveDatasets(value) {
    return new Set(
      String(value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    );
  }

  shouldLoadDataset(datasetName) {
    return this.activeDatasets.size === 0 || this.activeDatasets.has(datasetName);
  }

  parseCsvLine(line) {
    const values = [];
    let current = '';
    let insideQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];

      if (character === '"') {
        if (insideQuotes && line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          insideQuotes = !insideQuotes;
        }
        continue;
      }

      if (character === ',' && !insideQuotes) {
        values.push(current.trim());
        current = '';
        continue;
      }

      current += character;
    }

    values.push(current.trim());
    return values;
  }

  normalizeSearchAlias(text) {
    return text
      .toLowerCase()
      .replace(/([a-z]+)\s*-\s*(\d+[a-z]*)/g, '$1$2')
      .replace(/([a-z]+)\s*-\s*([a-z]+)/g, '$1$2')
      .replace(/(\d+)\s*m?\s*x\s*(\d+)\s*m?/gi, '$1x$2')
      .replace(/(\d+)\s*(ltr|liter|lt|l|mm|cm|m)\b/gi, '$1$2')
      .replace(/[^a-z0-9\s]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  buildSearchAliases(title) {
    if (!title) {
      return [];
    }

    const aliases = new Set();
    const lowerTitle = title.toLowerCase().trim();
    const normalized = this.normalizeSearchAlias(title);
    const spacedUnits = lowerTitle
      .replace(/(\d+)(ltr|liter|lt|l|mm|cm|m)\b/gi, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim();
    const compactDimensions = lowerTitle
      .replace(/(\d+)\s*m?\s*x\s*(\d+)\s*m?/gi, '$1x$2')
      .replace(/\s+/g, ' ')
      .trim();

    [normalized, spacedUnits, compactDimensions].forEach((alias) => {
      if (alias && alias !== lowerTitle) {
        aliases.add(alias);
      }
    });

    return Array.from(aliases);
  }

  extractPrice(row) {
    for (const value of row) {
      const cleanValue = value ? value.trim() : '';
      if (/^\d[\d.,]*$/.test(cleanValue) && /[.,]/.test(cleanValue)) {
        return cleanValue;
      }
    }

    return '';
  }

  extractDiscount(row) {
    for (const value of row) {
      const cleanValue = value ? value.trim() : '';
      if (/^-?\d+%$/.test(cleanValue)) {
        return cleanValue;
      }
    }

    return '';
  }

  buildTextFromCsvRow(headers, row) {
    const title = this.extractCsvLabel(row);
    const price = this.extractPrice(row);
    const discount = this.extractDiscount(row);
    const aliases = this.buildSearchAliases(title);
    const fields = [];

    if (title) {
      fields.push(`Nama produk: ${title}`);
    }

    if (aliases.length > 0) {
      fields.push(`Alias pencarian: ${aliases.join(', ')}`);
    }

    if (price) {
      fields.push(`Harga: ${price}`);
    }

    if (discount) {
      fields.push(`Diskon: ${discount}`);
    }

    headers.forEach((header, index) => {
      const value = row[index] ? row[index].trim() : '';
      if (!value) {
        return;
      }

      const normalizedHeader = header.toLowerCase();
      if (normalizedHeader.includes('href') || normalizedHeader.includes('src')) {
        return;
      }

      if (value === title || value === price || value === discount) {
        return;
      }

      if (/^[\d.,%+-]+$/.test(value)) {
        return;
      }

      fields.push(`${header}: ${value}`);
    });

    return fields.join('\n');
  }

  extractCsvLabel(row) {
    for (const value of row) {
      const cleanValue = value ? value.trim() : '';
      if (!cleanValue) {
        continue;
      }
      if (/^https?:\/\//i.test(cleanValue)) {
        continue;
      }
      if (/^data:/i.test(cleanValue)) {
        continue;
      }
      if (/^[\d.,%+-]+$/.test(cleanValue)) {
        continue;
      }
      if (cleanValue.length < 4) {
        continue;
      }
      return cleanValue;
    }

    return 'baris';
  }

  loadCsvDataset(filePath, datasetName) {
    const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length < 2) {
      return {
        name: datasetName,
        file: filePath,
        data: { documents: [] },
        loadedAt: new Date().toISOString(),
      };
    }

    const headers = this.parseCsvLine(lines[0]);
    const documents = [];

    for (let index = 1; index < lines.length; index += 1) {
      const row = this.parseCsvLine(lines[index]);
      const text = this.buildTextFromCsvRow(headers, row);

      if (!text) {
        continue;
      }

      const title = this.extractCsvLabel(row);
      documents.push({
        source: `${datasetName}/${title}`,
        text,
      });
    }

    return {
      name: datasetName,
      file: filePath,
      data: {
        metadata: {
          name: datasetName,
          type: 'csv',
        },
        documents,
      },
      loadedAt: new Date().toISOString(),
    };
  }

  ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
      console.log(`[DATA] Created data directory: ${this.dataDir}`);
    }
  }

  loadAllDatasets() {
    try {
      const files = fs.readdirSync(this.dataDir);

      for (const file of files) {
        const filePath = path.join(this.dataDir, file);

        try {
          if (file.endsWith('.json')) {
            const datasetName = file.replace('.json', '');
            if (!this.shouldLoadDataset(datasetName)) {
              continue;
            }

            const content = fs.readFileSync(filePath, 'utf8');
            const data = JSON.parse(content);

            this.datasets.set(datasetName, {
              name: datasetName,
              file: filePath,
              data,
              loadedAt: new Date().toISOString(),
            });

            console.log(`[DATA] Loaded dataset: ${datasetName}`);
          }

          if (file.endsWith('.csv')) {
            const datasetName = file.replace('.csv', '');
            if (!this.shouldLoadDataset(datasetName)) {
              continue;
            }

            const dataset = this.loadCsvDataset(filePath, datasetName);
            this.datasets.set(datasetName, dataset);
            console.log(`[DATA] Loaded CSV dataset: ${datasetName}`);
          }
        } catch (error) {
          console.error(`[DATA] Error loading dataset ${file}:`, error.message);
        }
      }

      if (this.datasets.size === 0) {
        console.log('[DATA] No datasets found in data directory');
      }
    } catch (error) {
      console.error('Error loading datasets:', error.message);
    }
  }

  getAllDocuments() {
    const allDocs = [];

    for (const [name, dataset] of this.datasets) {
      if (dataset.data.documents && Array.isArray(dataset.data.documents)) {
        for (const doc of dataset.data.documents) {
          allDocs.push({
            source: `${name}/${doc.source || 'unknown'}`,
            text: doc.text || '',
          });
        }
      }

      if (dataset.data.faq && Array.isArray(dataset.data.faq)) {
        for (const faq of dataset.data.faq) {
          allDocs.push({
            source: `${name}/FAQ: ${faq.question || 'unknown'}`,
            text: `${faq.question}\n${faq.answer}`,
          });
        }
      }
    }

    return allDocs;
  }

  getDatasetDocuments(datasetName) {
    const dataset = this.datasets.get(datasetName);
    if (!dataset) {
      return [];
    }

    const docs = [];

    if (dataset.data.documents && Array.isArray(dataset.data.documents)) {
      for (const doc of dataset.data.documents) {
        docs.push({
          source: `${datasetName}/${doc.source || 'unknown'}`,
          text: doc.text || '',
        });
      }
    }

    if (dataset.data.faq && Array.isArray(dataset.data.faq)) {
      for (const faq of dataset.data.faq) {
        docs.push({
          source: `${datasetName}/FAQ: ${faq.question || 'unknown'}`,
          text: `${faq.question}\n${faq.answer}`,
        });
      }
    }

    return docs;
  }

  saveDataset(datasetName, data) {
    try {
      const filePath = path.join(this.dataDir, `${datasetName}.json`);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

      this.datasets.set(datasetName, {
        name: datasetName,
        file: filePath,
        data,
        loadedAt: new Date().toISOString(),
      });

      console.log(`[DATA] Saved dataset: ${datasetName}`);
      return { success: true, message: `Dataset ${datasetName} saved` };
    } catch (error) {
      console.error(`Error saving dataset ${datasetName}:`, error.message);
      return { success: false, message: error.message };
    }
  }

  listDatasets() {
    return Array.from(this.datasets.values()).map((dataset) => ({
      name: dataset.name,
      loadedAt: dataset.loadedAt,
      documentCount: this.getDatasetDocuments(dataset.name).length,
    }));
  }

  reloadDatasets() {
    this.datasets.clear();
    this.loadAllDatasets();
  }
}

module.exports = DatasetManager;
