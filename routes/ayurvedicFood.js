/**
 * Ayurvedic Food Database + Recipe Library — HTTP routes (Feature 1).
 *
 * Mounted at /api/ayurvedic-foods. The `authMiddleware` is applied at the
 * mount point in index.js, so every handler here can assume req.user is
 * populated. Each handler also applies a `roleMiddleware` allowlist.
 *
 * Response shape follows the existing codebase convention (raw payload,
 * not { data: ... }) — keeps callers consistent with the rest of /api.
 *
 * Bulk import accepts .csv (parsed via csv-parser) and .xlsx (parsed via
 * xlsx). File is read from a memory buffer; nothing touches disk.
 */

import express from 'express';
import { z } from 'zod';
import multer from 'multer';
import xlsx from 'xlsx';
import { Readable } from 'stream';
import csvParser from 'csv-parser';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import logger from '../lib/logger.js';
import * as svc from '../services/ayurvedicFood.service.js';

const router = express.Router();

// ── Role groups (single source of truth) ─────────────────────────────────────
const ADMIN_ROLES        = ['ADMIN', 'ADMIN_DOCTOR'];
const FOOD_AUTHOR_ROLES  = ['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR'];
const FOOD_VIEWER_ROLES  = ['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST'];
const RECIPE_AUTHOR_ROLES = ['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR'];
const RECIPE_VIEWER_ROLES = ['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST'];
const MEAL_LINK_ROLES    = ['ADMIN_DOCTOR', 'DOCTOR'];

// ── Common Zod fragments ─────────────────────────────────────────────────────
const FoodCategoryEnum = z.enum([
    'GRAIN', 'VEGETABLE', 'FRUIT', 'DAIRY', 'SPICE', 'OIL',
    'LEGUME', 'MEAT', 'HERB', 'BEVERAGE', 'OTHER',
]);
const DoshaEffect      = z.enum(['PACIFYING', 'NEUTRAL', 'AGGRAVATING']);
const Virya            = z.enum(['HOT', 'COLD', 'NEUTRAL']);
const RasaEnum         = z.enum(['SWEET', 'SOUR', 'SALTY', 'PUNGENT', 'BITTER', 'ASTRINGENT']);
const GunaEnum         = z.enum(['HEAVY', 'LIGHT', 'OILY', 'DRY', 'HOT', 'COLD', 'SHARP', 'SOFT', 'STABLE', 'MOBILE']);
const SeasonEnum       = z.enum(['WINTER', 'SUMMER', 'MONSOON', 'AUTUMN', 'SPRING']);
const DoshaTargetEnum  = z.enum(['VATA', 'PITTA', 'KAPHA', 'TRIDOSHA']);

const foodCreateSchema = z.object({
    name:               z.string().min(1).max(200),
    nameInTamil:        z.string().max(200).optional().nullable(),
    nameInSanskrit:     z.string().max(200).optional().nullable(),
    category:           FoodCategoryEnum,
    doshaEffectVata:    DoshaEffect.optional(),
    doshaEffectPitta:   DoshaEffect.optional(),
    doshaEffectKapha:   DoshaEffect.optional(),
    rasa:               z.array(RasaEnum).optional(),
    guna:               z.array(GunaEnum).optional(),
    virya:              Virya.optional(),
    seasons:            z.array(SeasonEnum).optional(),
    preparationMethods: z.array(z.string()).optional(),
    calories:           z.number().nullable().optional(),
    protein:            z.number().nullable().optional(),
    carbs:              z.number().nullable().optional(),
    fat:                z.number().nullable().optional(),
    fiber:              z.number().nullable().optional(),
    commonAllergies:    z.array(z.string()).optional(),
    isActive:           z.boolean().optional(),
});

// PUT accepts a partial — every field optional, but if `category` is sent it
// still has to be a valid enum value (zod's .optional() preserves that).
const foodUpdateSchema = foodCreateSchema.partial();

const recipeIngredientSchema = z.object({
    foodId:    z.string().min(1),
    quantity:  z.coerce.number().nonnegative(),
    unit:      z.string().min(1).max(40),
    notes:     z.string().max(500).optional().nullable(),
    sortOrder: z.coerce.number().int().nonnegative().optional(),
});

const recipeCreateSchema = z.object({
    name:            z.string().min(1).max(200),
    nameInTamil:     z.string().max(200).optional().nullable(),
    description:     z.string().max(2000).optional().nullable(),
    doshaTargets:    z.array(DoshaTargetEnum).optional(),
    prepTimeMinutes: z.coerce.number().int().nonnegative().optional(),
    cookTimeMinutes: z.coerce.number().int().nonnegative().optional(),
    servings:        z.coerce.number().int().positive().optional(),
    instructions:    z.array(z.string()).optional(),
    mealCategory:    z.enum(['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK', 'BEVERAGE', 'GENERAL']).optional(),
    imageUrl:        z.string().url().optional().nullable(),
    isActive:        z.boolean().optional(),
    ingredients:     z.array(recipeIngredientSchema).optional(),
});
const recipeUpdateSchema = recipeCreateSchema.partial();

const linkFoodSchema = z.object({
    foodId:       z.string().min(1).optional(),
    foodNameFree: z.string().min(1).max(200).optional(),
    quantity:     z.coerce.number().nonnegative().optional().nullable(),
    unit:         z.string().max(40).optional().nullable(),
    notes:        z.string().max(500).optional().nullable(),
    isAvoid:      z.boolean().optional(),
}).refine((b) => !!b.foodId || !!b.foodNameFree, {
    message: 'Either foodId or foodNameFree is required',
});

// ── Multer (in-memory) for bulk import ───────────────────────────────────────
const ALLOWED_BULK_MIME = new Set([
    'text/csv',
    'application/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain', // some browsers send CSV as text/plain
]);

const bulkUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 }, // 10 MB
    fileFilter: (_req, file, cb) => {
        const okMime = ALLOWED_BULK_MIME.has(file.mimetype);
        const okExt  = /\.(csv|xlsx)$/i.test(file.originalname || '');
        if (okMime || okExt) return cb(null, true);
        cb(new Error('Only .csv and .xlsx files are accepted'));
    },
});

// Parse a CSV buffer into an array of plain objects.
function parseCsvBuffer(buffer) {
    return new Promise((resolve, reject) => {
        const rows = [];
        Readable.from(buffer)
            .pipe(csvParser())
            .on('data', (row) => rows.push(row))
            .on('end',  () => resolve(rows))
            .on('error', reject);
    });
}

// Parse an XLSX buffer using the first sheet, header row → keys.
function parseXlsxBuffer(buffer) {
    const wb = xlsx.read(buffer, { type: 'buffer' });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return [];
    return xlsx.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
}

// ── Error → response helper ─────────────────────────────────────────────────
function sendServiceError(res, err) {
    const status = err.status || 500;
    const code   = err.code   || (status === 500 ? 'INTERNAL_ERROR' : 'ERROR');
    const message = err.message || 'Unexpected server error';
    if (status >= 500) logger.error('[ayurvedicFood] internal error', { err: message, stack: err.stack });
    return res.status(status).json({ error: { code, message } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Foods
// ─────────────────────────────────────────────────────────────────────────────

// IMPORTANT: route ordering — specific paths (/suggest, /conflict-check,
// /stats, /recipes, /meals/...) must come BEFORE the generic /:id matcher.

router.get('/suggest', roleMiddleware(FOOD_VIEWER_ROLES), async (req, res) => {
    try {
        const result = await svc.suggestFoods({
            query:       typeof req.query.query === 'string' ? req.query.query : '',
            doshaTarget: typeof req.query.doshaTarget === 'string' ? req.query.doshaTarget : undefined,
            branchId:    req.user.branchId,
            limit:       req.query.limit ? Number(req.query.limit) : undefined,
        });
        res.json(result);
    } catch (err) { sendServiceError(res, err); }
});

router.get('/conflict-check', roleMiddleware(FOOD_VIEWER_ROLES), async (req, res) => {
    try {
        // foodIds may arrive as ?foodIds=a,b,c or ?foodIds=a&foodIds=b
        let foodIds = req.query.foodIds;
        if (typeof foodIds === 'string') foodIds = foodIds.split(',').map((s) => s.trim()).filter(Boolean);
        if (!Array.isArray(foodIds)) foodIds = [];
        const result = await svc.checkAllergyConflict({
            foodIds,
            patientId: typeof req.query.patientId === 'string' ? req.query.patientId : '',
        });
        res.json(result);
    } catch (err) { sendServiceError(res, err); }
});

router.get('/stats', roleMiddleware(ADMIN_ROLES), async (req, res) => {
    try {
        res.json(await svc.getFoodDatabaseStats(req.user.branchId));
    } catch (err) { sendServiceError(res, err); }
});

router.get('/', roleMiddleware(FOOD_VIEWER_ROLES), async (req, res) => {
    try {
        const result = await svc.getAllFoods({
            branchId:    req.user.branchId,
            category:    typeof req.query.category === 'string' ? req.query.category : undefined,
            doshaFilter: typeof req.query.doshaFilter === 'string' ? req.query.doshaFilter : undefined,
            season:      typeof req.query.season === 'string' ? req.query.season : undefined,
            query:       typeof req.query.query === 'string' ? req.query.query : undefined,
            page:        req.query.page  ? Number(req.query.page)  : undefined,
            limit:       req.query.limit ? Number(req.query.limit) : undefined,
        });
        res.json(result);
    } catch (err) { sendServiceError(res, err); }
});

router.post('/bulk-import', roleMiddleware(ADMIN_ROLES), (req, res) => {
    bulkUpload.single('file')(req, res, async (multerErr) => {
        if (multerErr) return res.status(400).json({ error: { code: 'UPLOAD_ERROR', message: multerErr.message } });
        if (!req.file) return res.status(400).json({ error: { code: 'FILE_REQUIRED', message: 'A file is required (field name: file)' } });
        try {
            const isXlsx = /\.xlsx$/i.test(req.file.originalname || '') ||
                           req.file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
            const rows = isXlsx
                ? parseXlsxBuffer(req.file.buffer)
                : await parseCsvBuffer(req.file.buffer);
            const result = await svc.bulkImportFoods(rows, req.user.branchId, req.user.id);
            res.status(201).json(result);
        } catch (err) { sendServiceError(res, err); }
    });
});

router.post('/', roleMiddleware(FOOD_AUTHOR_ROLES), validate({ body: foodCreateSchema }), async (req, res) => {
    try {
        const created = await svc.createFood(req.body, req.user.id, req.user.branchId);
        res.status(201).json(created);
    } catch (err) { sendServiceError(res, err); }
});

router.put('/:id', roleMiddleware(FOOD_AUTHOR_ROLES), validate({ body: foodUpdateSchema }), async (req, res) => {
    try {
        const updated = await svc.updateFood(req.params.id, req.body, req.user.id, req.user.role);
        res.json(updated);
    } catch (err) { sendServiceError(res, err); }
});

router.delete('/:id', roleMiddleware(FOOD_AUTHOR_ROLES), async (req, res) => {
    try {
        const result = await svc.deleteFood(req.params.id, req.user.id, req.user.role);
        res.json(result);
    } catch (err) { sendServiceError(res, err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Recipes
// ─────────────────────────────────────────────────────────────────────────────

router.get('/recipes', roleMiddleware(RECIPE_VIEWER_ROLES), async (req, res) => {
    try {
        const result = await svc.getAllRecipes({
            branchId:     req.user.branchId,
            doshaTarget:  typeof req.query.doshaTarget === 'string' ? req.query.doshaTarget : undefined,
            mealCategory: typeof req.query.mealCategory === 'string' ? req.query.mealCategory : undefined,
            query:        typeof req.query.query === 'string' ? req.query.query : undefined,
            page:         req.query.page  ? Number(req.query.page)  : undefined,
            limit:        req.query.limit ? Number(req.query.limit) : undefined,
        });
        res.json(result);
    } catch (err) { sendServiceError(res, err); }
});

router.get('/recipes/:id', roleMiddleware(RECIPE_VIEWER_ROLES), async (req, res) => {
    try {
        res.json(await svc.getRecipeById(req.params.id));
    } catch (err) { sendServiceError(res, err); }
});

router.post('/recipes', roleMiddleware(RECIPE_AUTHOR_ROLES), validate({ body: recipeCreateSchema }), async (req, res) => {
    try {
        const created = await svc.createRecipe(req.body, req.user.id, req.user.branchId);
        res.status(201).json(created);
    } catch (err) { sendServiceError(res, err); }
});

router.put('/recipes/:id', roleMiddleware(RECIPE_AUTHOR_ROLES), validate({ body: recipeUpdateSchema }), async (req, res) => {
    try {
        const updated = await svc.updateRecipe(req.params.id, req.body, req.user.id, req.user.role);
        res.json(updated);
    } catch (err) { sendServiceError(res, err); }
});

router.delete('/recipes/:id', roleMiddleware(RECIPE_AUTHOR_ROLES), async (req, res) => {
    try {
        res.json(await svc.deleteRecipe(req.params.id, req.user.id, req.user.role));
    } catch (err) { sendServiceError(res, err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// DietMeal ↔ Food links
// ─────────────────────────────────────────────────────────────────────────────

router.get('/meals/:mealId/foods', roleMiddleware([...MEAL_LINK_ROLES, 'THERAPIST', 'ADMIN', 'PATIENT']), async (req, res) => {
    // Read-side is broadly accessible — the patient also fetches their own
    // meal links from PatientDiet. Mutating endpoints below remain locked
    // to clinicians.
    try {
        res.json(await svc.getMealFoodLinks(req.params.mealId));
    } catch (err) { sendServiceError(res, err); }
});

router.post('/meals/:mealId/foods', roleMiddleware(MEAL_LINK_ROLES), validate({ body: linkFoodSchema }), async (req, res) => {
    try {
        const link = await svc.linkFoodToMeal(req.params.mealId, req.body);
        res.status(201).json(link);
    } catch (err) { sendServiceError(res, err); }
});

router.delete('/meals/:mealId/foods/:linkId', roleMiddleware(MEAL_LINK_ROLES), async (req, res) => {
    try {
        res.json(await svc.unlinkFoodFromMeal(req.params.linkId));
    } catch (err) { sendServiceError(res, err); }
});

// Single-food fetch — generic /:id matcher MUST come LAST so it doesn't
// shadow /suggest, /conflict-check, /stats, /recipes, or /meals.
router.get('/:id', roleMiddleware(FOOD_VIEWER_ROLES), async (req, res) => {
    try {
        res.json(await svc.getFoodById(req.params.id));
    } catch (err) { sendServiceError(res, err); }
});

export default router;
