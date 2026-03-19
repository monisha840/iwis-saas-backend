import express from 'express';
import multer from 'multer';
import { unlink } from 'fs/promises';
import { BulkService } from '../services/bulk.service.js';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';

const router = express.Router();

const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'text/csv') cb(null, true);
        else cb(new Error('Only CSV files are allowed'));
    },
});

router.post('/patients/upload', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), upload.single('file'), async (req, res, next) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const data = await BulkService.parseCSV(req.file.path);
        const validationResults = data.map((row, index) => ({
            row: index + 1,
            data: row,
            errors: BulkService.validatePatientData(row),
        }));

        const validRows = validationResults.filter((r) => r.errors.length === 0);
        const invalidRows = validationResults.filter((r) => r.errors.length > 0);

        const bulkOp = await BulkService.initiatePatientImport(req.user.id, req.file.path, data.length);
        await unlink(req.file.path);

        res.json({
            success: true,
            operationId: bulkOp.id,
            summary: { total: data.length, valid: validRows.length, invalid: invalidRows.length },
            validRows,
            invalidRows: invalidRows.map((r) => ({ row: r.row, data: r.data, errors: r.errors })),
        });
    } catch (err) {
        if (req.file) await unlink(req.file.path).catch(() => { });
        next(err);
    }
});

router.post('/patients/import', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), async (req, res, next) => {
    try {
        const { patients } = req.body;
        if (!Array.isArray(patients) || patients.length === 0) return res.status(400).json({ error: 'Invalid patient data' });

        const result = await BulkService.executePatientImport(req.user.id, patients);
        res.json({ success: true, ...result });
    } catch (err) {
        next(err);
    }
});

router.get('/operations/:id', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), async (req, res, next) => {
    try {
        const operation = await BulkService.getOperationStatus(req.params.id);
        res.json({ success: true, operation });
    } catch (err) {
        next(err);
    }
});

router.get('/operations', authMiddleware, roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']), async (req, res, next) => {
    try {
        const operations = await BulkService.listOperations();
        res.json({ success: true, operations });
    } catch (err) {
        next(err);
    }
});

export default router;
