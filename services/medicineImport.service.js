import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import csvParser from 'csv-parser';
import { createReadStream, promises as fsp } from 'fs';
import { randomUUID } from 'crypto';

const HEADER_ALIASES = {
    'sno': 'sno', 's.no': 'sno', 'sl no': 'sno', 'slno': 'sno',
    'store': 'store', 'branch': 'store',
    'pcode': 'pcode', 'p code': 'pcode', 'product code': 'pcode', 'sku': 'pcode',
    'hsn': 'hsn', 'hsn code': 'hsn',
    'name': 'name', 'medicine name': 'name', 'product name': 'name',
    'pharmacological name': 'pharmacologicalName', 'generic name': 'pharmacologicalName', 'generic': 'pharmacologicalName',
    'mfr': 'manufacturer', 'manufacturer': 'manufacturer', 'mfg': 'manufacturer',
    'category': 'category',
    'risk level': 'riskLevel', 'risk': 'riskLevel',
    'batch': 'batch', 'batch number': 'batch', 'batch no': 'batch',
    'tray': 'tray', 'location': 'tray',
    'expiry': 'expiry', 'expiry date': 'expiry', 'exp': 'expiry', 'exp date': 'expiry',
    'purchase price': 'purchasePrice', 'pur price': 'purchasePrice', 'cost price': 'purchasePrice',
    'mrp': 'mrp', 'price': 'mrp', 'sale price': 'mrp',
    'max sales dis(%)': 'maxSalesDiscount', 'max sales dis': 'maxSalesDiscount',
    'max sales discount': 'maxSalesDiscount', 'max discount': 'maxSalesDiscount', 'max dis(%)': 'maxSalesDiscount',
    'tax': 'tax', 'tax(%)': 'tax', 'gst': 'tax', 'gst(%)': 'tax',
    'qty': 'qty', 'quantity': 'qty',
    'punit': 'purchaseUnit', 'p unit': 'purchaseUnit', 'purchase unit': 'purchaseUnit',
    'qty / pur unit': 'qtyPerPurchaseUnit', 'qty/pur unit': 'qtyPerPurchaseUnit',
    'qty per pur unit': 'qtyPerPurchaseUnit', 'qty per purchase unit': 'qtyPerPurchaseUnit',
};

function normalizeKey(key) {
    return String(key || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeRow(rawRow) {
    const out = {};
    for (const [key, value] of Object.entries(rawRow)) {
        const alias = HEADER_ALIASES[normalizeKey(key)];
        if (alias) out[alias] = typeof value === 'string' ? value.trim() : value;
    }
    return out;
}

function parseNumber(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = parseFloat(String(value).replace(/[,₹$\s]/g, ''));
    return Number.isFinite(n) ? n : null;
}

function parseInteger(value) {
    const n = parseNumber(value);
    return n === null ? null : Math.trunc(n);
}

/**
 * Parse flexible date formats. Accepts DD/MM/YYYY, DD-MM-YYYY, MM/YYYY, YYYY-MM-DD, etc.
 * For month-year only (MM/YYYY), pins to last day of that month.
 */
function parseExpiry(value) {
    if (!value) return null;
    const raw = String(value).trim();

    // MM/YYYY or MM-YYYY (common on medicine strips)
    let m = raw.match(/^(\d{1,2})[\/\-](\d{4})$/);
    if (m) {
        const month = parseInt(m[1], 10);
        const year = parseInt(m[2], 10);
        if (month >= 1 && month <= 12) {
            return new Date(Date.UTC(year, month, 0));
        }
    }

    // DD/MM/YYYY or DD-MM-YYYY
    m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (m) {
        const day = parseInt(m[1], 10);
        const month = parseInt(m[2], 10);
        let year = parseInt(m[3], 10);
        if (year < 100) year += 2000;
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
            return new Date(Date.UTC(year, month - 1, day));
        }
    }

    // YYYY-MM-DD and other ISO variants
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d;

    return null;
}

export class MedicineImportService {
    /**
     * Find (separator, header-line index) by scanning the first N lines and
     * picking the (line, separator) pair that produces the most columns whose
     * normalized names match one of our HEADER_ALIASES. This handles files that
     * start with title / subtitle rows (common in Excel exports).
     */
    static async detectFormat(filepath) {
        const fh = await fsp.open(filepath, 'r');
        try {
            const { buffer, bytesRead } = await fh.read({ buffer: Buffer.alloc(16 * 1024), position: 0 });
            let head = buffer.slice(0, bytesRead).toString('utf8');
            if (head.charCodeAt(0) === 0xfeff) head = head.slice(1);
            const lines = head.split(/\r?\n/).slice(0, 50);

            const separators = ['\t', ',', ';', '|'];
            let best = { separator: ',', skipLines: 0, hits: -1 };
            for (let i = 0; i < lines.length; i++) {
                for (const sep of separators) {
                    const cols = lines[i].split(sep).map(c => c.trim().replace(/^"|"$/g, ''));
                    if (cols.length < 2) continue;
                    const hits = cols.filter(c => HEADER_ALIASES[normalizeKey(c)]).length;
                    if (hits > best.hits) best = { separator: sep, skipLines: i, hits };
                }
            }
            return best;
        } finally {
            await fh.close();
        }
    }

    static async parseCSV(filepath) {
        const { separator, skipLines } = await this.detectFormat(filepath);
        return new Promise((resolve, reject) => {
            const rawRows = [];
            const normalizedRows = [];
            let detectedHeaders = [];
            createReadStream(filepath)
                .pipe(csvParser({
                    separator,
                    skipLines,
                    mapHeaders: ({ header }) => header.replace(/^﻿/, '').trim(),
                }))
                .on('headers', (hs) => { detectedHeaders = hs; })
                .on('data', (r) => {
                    if (rawRows.length < 3) rawRows.push(r);
                    normalizedRows.push(normalizeRow(r));
                })
                .on('end', () => resolve({
                    rows: normalizedRows,
                    meta: { separator, skipLines, detectedHeaders, sample: rawRows[0] || null },
                }))
                .on('error', reject);
        });
    }

    static validateRow(row) {
        const errors = [];
        if (!row.name) errors.push('Name is required');
        if (row.mrp === undefined || row.mrp === '') errors.push('MRP is required');
        else if (parseNumber(row.mrp) === null) errors.push('MRP must be numeric');
        if (row.qty === undefined || row.qty === '') errors.push('Qty is required');
        else if (parseInteger(row.qty) === null || parseInteger(row.qty) < 0) errors.push('Qty must be a non-negative integer');
        if (row.batch && row.expiry && !parseExpiry(row.expiry)) errors.push('Expiry date unrecognized');
        return errors;
    }

    /**
     * Resolve branches once for the whole file so we don't hit DB per row.
     * Matches Store column case-insensitively against Branch.name within the user's hospital.
     * Returns { branchMap: { [storeLowercased]: branchId }, defaultBranchId }
     */
    static async buildBranchMap(userBranchId, hospitalId) {
        const branchMap = {};
        if (hospitalId) {
            const branches = await prisma.branch.findMany({
                where: { hospitalId },
                select: { id: true, name: true },
            });
            for (const b of branches) {
                branchMap[b.name.trim().toLowerCase()] = b.id;
            }
        }
        return { branchMap, defaultBranchId: userBranchId || null };
    }

    static resolveBranchId(row, branchMap, defaultBranchId) {
        if (row.store) {
            const match = branchMap[row.store.trim().toLowerCase()];
            if (match) return match;
        }
        return defaultBranchId;
    }

    /**
     * Upload-phase: parse + validate + preview, no DB writes.
     */
    static async previewImport(filepath, user) {
        const { rows, meta } = await this.parseCSV(filepath);
        logger.info('[MedicineImport] parsed CSV', { separator: JSON.stringify(meta.separator), skipLines: meta.skipLines, headerCount: meta.detectedHeaders.length, rowCount: rows.length });
        const dbUser = await prisma.user.findUnique({ where: { id: user.id }, select: { branchId: true, hospitalId: true } });
        const { branchMap, defaultBranchId } = await this.buildBranchMap(dbUser?.branchId, dbUser?.hospitalId);

        const previews = rows.map((row, i) => {
            const errors = this.validateRow(row);
            const branchId = this.resolveBranchId(row, branchMap, defaultBranchId);
            if (row.store && !branchMap[row.store.trim().toLowerCase()]) {
                errors.push(`Store "${row.store}" not found; will default to your branch`);
            }
            return {
                row: i + 2, // +1 for header, +1 for 1-based
                data: row,
                resolvedBranchId: branchId,
                errors: errors.filter(e => !e.startsWith('Store ')),
                warnings: errors.filter(e => e.startsWith('Store ')),
            };
        });

        return {
            total: previews.length,
            valid: previews.filter(p => p.errors.length === 0).length,
            invalid: previews.filter(p => p.errors.length > 0).length,
            rows: previews,
            meta: {
                separator: meta.separator,
                skipLines: meta.skipLines,
                detectedHeaders: meta.detectedHeaders,
                sampleRow: meta.sample,
                unmappedHeaders: meta.detectedHeaders.filter(h => !HEADER_ALIASES[normalizeKey(h)]),
            },
        };
    }

    /**
     * Execute-phase: bulk-upsert Medicine by sku (or by name+manufacturer), then bulk-upsert
     * MedicineStock on the (medicineId, branchId, batchNumber) unique key.
     *
     * Strategy: pre-fetch existing rows in 2 queries, classify everything in memory, then
     * createMany for inserts + parallel-batched update for edits. For a 2910-row file this
     * takes ~10s vs ~24min with the old row-by-row approach.
     */
    static async executeImport(userId, rows) {
        const t0 = Date.now();
        const dbUser = await prisma.user.findUnique({ where: { id: userId }, select: { branchId: true, hospitalId: true } });
        const { branchMap, defaultBranchId } = await this.buildBranchMap(dbUser?.branchId, dbUser?.hospitalId);

        const summary = { created: 0, updated: 0, stockCreated: 0, stockUpdated: 0, failed: [] };
        if (rows.length === 0) return summary;

        // 1) Stage every row: build medicine & stock payloads + resolved branchId.
        const staged = [];
        for (let i = 0; i < rows.length; i++) {
            try {
                const row = rows[i] || {};
                if (!row.name) {
                    summary.failed.push({ row: i + 2, data: row, error: 'Name is required' });
                    continue;
                }
                const branchId = this.resolveBranchId(row, branchMap, defaultBranchId) || null;
                staged.push({
                    i,
                    branchId,
                    nameMfrKey: `${row.name}||${row.manufacturer || ''}`,
                    medicineData: {
                        name: row.name,
                        sku: row.pcode || null,
                        manufacturer: row.manufacturer || null,
                        category: row.category || null,
                        hsn: row.hsn || null,
                        pharmacologicalName: row.pharmacologicalName || null,
                        riskLevel: row.riskLevel || null,
                        price: parseNumber(row.mrp) ?? 0,
                        maxSalesDiscount: parseNumber(row.maxSalesDiscount),
                        tax: parseNumber(row.tax),
                        purchaseUnit: row.purchaseUnit || null,
                        qtyPerPurchaseUnit: parseInteger(row.qtyPerPurchaseUnit),
                    },
                    stockData: {
                        batchNumber: row.batch || `BATCH-${Date.now()}-${i}`,
                        quantity: parseInteger(row.qty) ?? 0,
                        expiryDate: parseExpiry(row.expiry) || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
                        location: row.tray || null,
                        purchasePrice: parseNumber(row.purchasePrice),
                    },
                });
            } catch (err) {
                summary.failed.push({ row: i + 2, data: rows[i], error: err.message });
            }
        }

        // 2) Pre-fetch existing Medicine rows matching any sku OR any name (single query each).
        const skus = [...new Set(staged.map(s => s.medicineData.sku).filter(Boolean))];
        const names = [...new Set(staged.map(s => s.medicineData.name))];
        const existing = await prisma.medicine.findMany({
            where: {
                OR: [
                    skus.length ? { sku: { in: skus } } : undefined,
                    names.length ? { name: { in: names } } : undefined,
                ].filter(Boolean),
            },
            select: { id: true, sku: true, name: true, manufacturer: true },
        });
        const bySku = new Map();
        const byNameMfr = new Map();
        for (const m of existing) {
            if (m.sku) bySku.set(m.sku, m);
            byNameMfr.set(`${m.name}||${m.manufacturer || ''}`, m);
        }

        // 3) Classify: update existing vs create new. bySku / byNameMfr are seeded from DB
        // and then extended per-create, so later rows in the same file that reference the
        // same medicine (different batches) find a hit and skip the duplicate insert.
        const medToCreate = [];
        const medToUpdate = [];
        const updateSeen = new Set();
        for (const s of staged) {
            let match = null;
            if (s.medicineData.sku) match = bySku.get(s.medicineData.sku);
            if (!match) match = byNameMfr.get(s.nameMfrKey);

            if (match) {
                s.medicineId = match.id;
                // Don't enqueue the same update twice (CSV may list a medicine across N rows).
                if (!updateSeen.has(match.id)) {
                    updateSeen.add(match.id);
                    medToUpdate.push({ id: match.id, data: s.medicineData });
                }
            } else {
                const newId = randomUUID();
                s.medicineId = newId;
                medToCreate.push({ id: newId, ...s.medicineData });
                const cached = { id: newId, sku: s.medicineData.sku, name: s.medicineData.name, manufacturer: s.medicineData.manufacturer };
                if (s.medicineData.sku) bySku.set(s.medicineData.sku, cached);
                byNameMfr.set(s.nameMfrKey, cached);
            }
        }

        // 4) Bulk-insert new medicines.
        if (medToCreate.length > 0) {
            const r = await prisma.medicine.createMany({ data: medToCreate, skipDuplicates: true });
            summary.created = r.count;
        }

        // 5) Parallel-batched medicine updates.
        const CONCURRENCY = 10;
        for (let i = 0; i < medToUpdate.length; i += CONCURRENCY) {
            const chunk = medToUpdate.slice(i, i + CONCURRENCY);
            await Promise.all(chunk.map(u =>
                prisma.medicine.update({ where: { id: u.id }, data: u.data })
                    .catch(err => { summary.failed.push({ row: -1, data: u.data, error: `medicine update: ${err.message}` }); })
            ));
            summary.updated += chunk.length;
        }

        // 6) Pre-fetch existing stocks for the involved medicineIds.
        const medIds = [...new Set(staged.map(s => s.medicineId).filter(Boolean))];
        const existingStocks = medIds.length
            ? await prisma.medicineStock.findMany({
                where: { medicineId: { in: medIds } },
                select: { id: true, medicineId: true, branchId: true, batchNumber: true },
            })
            : [];
        const stockKey = (medicineId, branchId, batch) => `${medicineId}||${branchId || ''}||${batch}`;
        const stockByKey = new Map();
        for (const st of existingStocks) {
            stockByKey.set(stockKey(st.medicineId, st.branchId, st.batchNumber), st);
        }

        // 7) Classify stocks.
        const stockToCreate = [];
        const stockToUpdate = [];
        for (const s of staged) {
            if (!s.medicineId) continue;
            const key = stockKey(s.medicineId, s.branchId, s.stockData.batchNumber);
            const match = stockByKey.get(key);
            if (match) {
                stockToUpdate.push({ id: match.id, data: s.stockData });
            } else {
                const newId = randomUUID();
                stockToCreate.push({
                    id: newId,
                    medicineId: s.medicineId,
                    branchId: s.branchId,
                    ...s.stockData,
                });
                stockByKey.set(key, { id: newId, medicineId: s.medicineId, branchId: s.branchId, batchNumber: s.stockData.batchNumber });
            }
        }

        // 8) Bulk-insert new stocks.
        if (stockToCreate.length > 0) {
            const r = await prisma.medicineStock.createMany({ data: stockToCreate, skipDuplicates: true });
            summary.stockCreated = r.count;
        }

        // 9) Parallel-batched stock updates.
        for (let i = 0; i < stockToUpdate.length; i += CONCURRENCY) {
            const chunk = stockToUpdate.slice(i, i + CONCURRENCY);
            await Promise.all(chunk.map(u =>
                prisma.medicineStock.update({
                    where: { id: u.id },
                    data: {
                        quantity: u.data.quantity,
                        expiryDate: u.data.expiryDate,
                        location: u.data.location,
                        purchasePrice: u.data.purchasePrice,
                    },
                }).catch(err => { summary.failed.push({ row: -1, data: u.data, error: `stock update: ${err.message}` }); })
            ));
            summary.stockUpdated += chunk.length;
        }

        logger.info('[MedicineImport] executeImport done', { ...summary, ms: Date.now() - t0, rows: rows.length });
        return summary;
    }
}
