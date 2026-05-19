/**
 * Ayurvedic Food Database + Recipe Library — service layer (Feature 1).
 *
 * Branch-scoped catalogue of foods (with dosha effects, rasa/guna metadata,
 * nutrition and allergy hints) and reusable recipes built from them.
 *
 * Design notes:
 *  - Soft-delete semantics for AyurvedicFood: if a food is referenced by a
 *    RecipeIngredient or DietMealFoodLink we flip `isActive=false` instead
 *    of deleting, so historical links still resolve.
 *  - All queries scope by `branchId` — admins land here from a branch-
 *    selected dashboard. Cross-branch reads happen only via the explicit
 *    list-with-branch-id path (no implicit org-wide aggregation).
 *  - Errors throw plain Error with .status + .code so the route layer can
 *    surface them as { error: { code, message } }.
 */

import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

// Throw helper — keeps the route handlers' try/catch simple.
function httpError(status, code, message) {
    const err = new Error(message);
    err.status = status;
    err.code = code;
    return err;
}

const VALID_FOOD_CATEGORIES = new Set([
    'GRAIN', 'VEGETABLE', 'FRUIT', 'DAIRY', 'SPICE', 'OIL',
    'LEGUME', 'MEAT', 'HERB', 'BEVERAGE', 'OTHER',
]);

const VALID_DOSHA_EFFECTS = new Set(['PACIFYING', 'NEUTRAL', 'AGGRAVATING']);
const VALID_VIRYA = new Set(['HOT', 'COLD', 'NEUTRAL']);
const VALID_RASA = new Set(['SWEET', 'SOUR', 'SALTY', 'PUNGENT', 'BITTER', 'ASTRINGENT']);
const VALID_GUNA = new Set(['HEAVY', 'LIGHT', 'OILY', 'DRY', 'HOT', 'COLD', 'SHARP', 'SOFT', 'STABLE', 'MOBILE']);
const VALID_SEASONS = new Set(['WINTER', 'SUMMER', 'MONSOON', 'AUTUMN', 'SPRING']);

// ── Foods ────────────────────────────────────────────────────────────────────

/**
 * Paginated list of foods scoped to a branch.
 *
 * @param {object} args
 * @param {string} args.branchId
 * @param {string=} args.category — single FoodCategory enum value
 * @param {('VATA'|'PITTA'|'KAPHA')=} args.doshaFilter — keep only foods that PACIFY this dosha
 * @param {string=} args.season — single Season enum value
 * @param {string=} args.query — case-insensitive name / nameInTamil search
 * @param {number=} args.page (default 1)
 * @param {number=} args.limit (default 20, max 100)
 */
export async function getAllFoods({ branchId, category, doshaFilter, season, query, page = 1, limit = 20 }) {
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));

    const where = { branchId, isActive: true };
    if (category) where.category = category;
    if (season) where.seasons = { has: season };
    if (doshaFilter === 'VATA')  where.doshaEffectVata  = 'PACIFYING';
    if (doshaFilter === 'PITTA') where.doshaEffectPitta = 'PACIFYING';
    if (doshaFilter === 'KAPHA') where.doshaEffectKapha = 'PACIFYING';
    if (query && query.trim().length > 0) {
        where.OR = [
            { name:        { contains: query, mode: 'insensitive' } },
            { nameInTamil: { contains: query, mode: 'insensitive' } },
        ];
    }

    const [total, data] = await Promise.all([
        prisma.ayurvedicFood.count({ where }),
        prisma.ayurvedicFood.findMany({
            where,
            orderBy: [{ name: 'asc' }],
            skip: (safePage - 1) * safeLimit,
            take: safeLimit,
        }),
    ]);
    return {
        data,
        pagination: {
            page: safePage,
            limit: safeLimit,
            total,
            totalPages: Math.max(1, Math.ceil(total / safeLimit)),
        },
    };
}

export async function getFoodById(foodId) {
    const food = await prisma.ayurvedicFood.findUnique({ where: { id: foodId } });
    if (!food) throw httpError(404, 'NOT_FOUND', 'Food not found');
    return food;
}

function _normaliseFoodInput(raw) {
    if (!raw || typeof raw !== 'object') {
        throw httpError(400, 'INVALID_PAYLOAD', 'Food payload is required');
    }
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) throw httpError(400, 'NAME_REQUIRED', 'Food name is required');
    if (!raw.category || !VALID_FOOD_CATEGORIES.has(raw.category)) {
        throw httpError(400, 'INVALID_CATEGORY', 'Invalid food category');
    }
    function pickEffect(v) {
        if (v === undefined || v === null) return 'NEUTRAL';
        if (!VALID_DOSHA_EFFECTS.has(v)) {
            throw httpError(400, 'INVALID_DOSHA_EFFECT', `Invalid dosha effect: ${v}`);
        }
        return v;
    }
    function pickEnumArray(arr, valid, label) {
        if (arr === undefined || arr === null) return [];
        if (!Array.isArray(arr)) throw httpError(400, 'INVALID_ARRAY', `${label} must be an array`);
        for (const v of arr) {
            if (!valid.has(v)) throw httpError(400, 'INVALID_ENUM', `Invalid ${label} value: ${v}`);
        }
        return arr;
    }
    const virya = raw.virya ?? 'NEUTRAL';
    if (!VALID_VIRYA.has(virya)) throw httpError(400, 'INVALID_VIRYA', `Invalid virya: ${virya}`);

    return {
        name,
        nameInTamil:        typeof raw.nameInTamil === 'string' ? raw.nameInTamil.trim() : null,
        nameInSanskrit:     typeof raw.nameInSanskrit === 'string' ? raw.nameInSanskrit.trim() : null,
        category:           raw.category,
        doshaEffectVata:    pickEffect(raw.doshaEffectVata),
        doshaEffectPitta:   pickEffect(raw.doshaEffectPitta),
        doshaEffectKapha:   pickEffect(raw.doshaEffectKapha),
        rasa:               pickEnumArray(raw.rasa, VALID_RASA, 'rasa'),
        guna:               pickEnumArray(raw.guna, VALID_GUNA, 'guna'),
        virya,
        seasons:            pickEnumArray(raw.seasons, VALID_SEASONS, 'seasons'),
        preparationMethods: Array.isArray(raw.preparationMethods) ? raw.preparationMethods.filter((s) => typeof s === 'string') : [],
        calories:           raw.calories === undefined || raw.calories === null ? null : Number(raw.calories),
        protein:            raw.protein === undefined  || raw.protein === null  ? null : Number(raw.protein),
        carbs:              raw.carbs === undefined    || raw.carbs === null    ? null : Number(raw.carbs),
        fat:                raw.fat === undefined      || raw.fat === null      ? null : Number(raw.fat),
        fiber:              raw.fiber === undefined    || raw.fiber === null    ? null : Number(raw.fiber),
        commonAllergies:    Array.isArray(raw.commonAllergies) ? raw.commonAllergies.filter((s) => typeof s === 'string') : [],
        isActive:           typeof raw.isActive === 'boolean' ? raw.isActive : true,
    };
}

export async function createFood(data, createdById, branchId) {
    if (!branchId) throw httpError(400, 'BRANCH_REQUIRED', 'branchId is required');
    if (!createdById) throw httpError(400, 'USER_REQUIRED', 'createdById is required');
    const normalised = _normaliseFoodInput(data);
    return prisma.ayurvedicFood.create({
        data: { ...normalised, branchId, createdById },
    });
}

/** ADMIN / ADMIN_DOCTOR / original creator only. */
export async function updateFood(foodId, data, requestingUserId, requestingUserRole) {
    const existing = await prisma.ayurvedicFood.findUnique({
        where: { id: foodId },
        select: { id: true, createdById: true },
    });
    if (!existing) throw httpError(404, 'NOT_FOUND', 'Food not found');
    const isAdmin = requestingUserRole === 'ADMIN' || requestingUserRole === 'ADMIN_DOCTOR';
    if (!isAdmin && existing.createdById !== requestingUserId) {
        throw httpError(403, 'FORBIDDEN', 'You can only update foods you created');
    }
    // Allow partial updates: only re-validate the fields the caller sent.
    const patch = _normaliseFoodInput({ ...data, name: data?.name ?? 'placeholder', category: data?.category ?? 'OTHER' });
    // Drop the placeholders so we don't overwrite the persisted values
    // when the caller didn't send them.
    if (data?.name === undefined)     delete patch.name;
    if (data?.category === undefined) delete patch.category;
    return prisma.ayurvedicFood.update({ where: { id: foodId }, data: patch });
}

/**
 * Smart delete:
 *  - if any RecipeIngredient or DietMealFoodLink references the food → soft delete (isActive=false)
 *  - else hard delete
 */
export async function deleteFood(foodId, requestingUserId, requestingUserRole) {
    const existing = await prisma.ayurvedicFood.findUnique({
        where: { id: foodId },
        select: { id: true, createdById: true },
    });
    if (!existing) throw httpError(404, 'NOT_FOUND', 'Food not found');
    const isAdmin = requestingUserRole === 'ADMIN' || requestingUserRole === 'ADMIN_DOCTOR';
    if (!isAdmin && existing.createdById !== requestingUserId) {
        throw httpError(403, 'FORBIDDEN', 'You can only delete foods you created');
    }

    const [ingredientCount, linkCount] = await Promise.all([
        prisma.recipeIngredient.count({ where: { foodId } }),
        prisma.dietMealFoodLink.count({ where: { foodId } }),
    ]);
    if (ingredientCount > 0 || linkCount > 0) {
        await prisma.ayurvedicFood.update({ where: { id: foodId }, data: { isActive: false } });
        return { mode: 'soft', message: 'Food deactivated' };
    }
    await prisma.ayurvedicFood.delete({ where: { id: foodId } });
    return { mode: 'hard', message: 'Food deleted' };
}

/**
 * Autocomplete: top `limit` foods matching the query, prioritising those
 * that PACIFY the doshaTarget (when provided).
 */
export async function suggestFoods({ query, doshaTarget, branchId, limit = 8 }) {
    if (!branchId) throw httpError(400, 'BRANCH_REQUIRED', 'branchId is required');
    const safeLimit = Math.min(50, Math.max(1, Number(limit) || 8));
    const trimmed = (query || '').trim();
    const where = { branchId, isActive: true };
    if (trimmed.length > 0) {
        where.OR = [
            { name:        { contains: trimmed, mode: 'insensitive' } },
            { nameInTamil: { contains: trimmed, mode: 'insensitive' } },
        ];
    }

    // First, try to fetch pacifying matches when a target dosha was given.
    let pacifying = [];
    if (doshaTarget === 'VATA' || doshaTarget === 'PITTA' || doshaTarget === 'KAPHA') {
        const field = `doshaEffect${doshaTarget.charAt(0)}${doshaTarget.slice(1).toLowerCase()}`;
        pacifying = await prisma.ayurvedicFood.findMany({
            where: { ...where, [field]: 'PACIFYING' },
            orderBy: [{ name: 'asc' }],
            take: safeLimit,
            select: {
                id: true, name: true, nameInTamil: true, category: true,
                doshaEffectVata: true, doshaEffectPitta: true, doshaEffectKapha: true,
                calories: true,
            },
        });
    }
    if (pacifying.length >= safeLimit) return pacifying;

    // Top up with any-effect matches, excluding ids we already have.
    const excludeIds = pacifying.map((f) => f.id);
    const filler = await prisma.ayurvedicFood.findMany({
        where: { ...where, id: { notIn: excludeIds.length ? excludeIds : ['__none__'] } },
        orderBy: [{ name: 'asc' }],
        take: safeLimit - pacifying.length,
        select: {
            id: true, name: true, nameInTamil: true, category: true,
            doshaEffectVata: true, doshaEffectPitta: true, doshaEffectKapha: true,
            calories: true,
        },
    });
    return [...pacifying, ...filler];
}

/**
 * Cross-reference a list of food IDs against a patient's stored allergy list.
 * Returns { hasConflict, conflicts: [{ foodId, foodName, allergen }] }.
 */
export async function checkAllergyConflict({ foodIds, patientId }) {
    if (!patientId) throw httpError(400, 'PATIENT_REQUIRED', 'patientId is required');
    if (!Array.isArray(foodIds) || foodIds.length === 0) {
        return { hasConflict: false, conflicts: [] };
    }
    const [patient, foods] = await Promise.all([
        prisma.patient.findUnique({ where: { id: patientId }, select: { allergies: true } }),
        prisma.ayurvedicFood.findMany({
            where: { id: { in: foodIds } },
            select: { id: true, name: true, commonAllergies: true },
        }),
    ]);
    const patientAllergies = (patient?.allergies || []).map((a) => a.toUpperCase());
    if (patientAllergies.length === 0) return { hasConflict: false, conflicts: [] };
    const conflicts = [];
    for (const food of foods) {
        for (const allergen of food.commonAllergies || []) {
            if (patientAllergies.includes(allergen.toUpperCase())) {
                conflicts.push({ foodId: food.id, foodName: food.name, allergen });
            }
        }
    }
    return { hasConflict: conflicts.length > 0, conflicts };
}

/**
 * Bulk import from a parsed CSV/XLSX row array. Validates each row, skips
 * invalid ones, collects per-row errors. Returns counts + the error list.
 *
 * Expected row keys (case-insensitive — caller normalises):
 *   name, nameInTamil?, nameInSanskrit?, category, doshaEffectVata?,
 *   doshaEffectPitta?, doshaEffectKapha?, rasa? (comma-sep), guna? (comma-sep),
 *   virya?, seasons? (comma-sep), preparationMethods? (comma-sep),
 *   calories?, protein?, carbs?, fat?, fiber?, commonAllergies? (comma-sep).
 */
export async function bulkImportFoods(rows, branchId, createdById) {
    if (!branchId) throw httpError(400, 'BRANCH_REQUIRED', 'branchId is required');
    if (!createdById) throw httpError(400, 'USER_REQUIRED', 'createdById is required');
    if (!Array.isArray(rows)) throw httpError(400, 'INVALID_ROWS', 'rows must be an array');

    const valid = [];
    const errors = [];

    function splitList(v) {
        if (Array.isArray(v)) return v.filter((s) => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim());
        if (typeof v !== 'string') return [];
        return v.split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
    }

    rows.forEach((raw, idx) => {
        try {
            const rowIdx = idx + 1; // 1-indexed for human-readable errors
            const normalised = _normaliseFoodInput({
                name:               raw.name,
                nameInTamil:        raw.nameInTamil,
                nameInSanskrit:     raw.nameInSanskrit,
                category:           typeof raw.category === 'string' ? raw.category.trim().toUpperCase() : raw.category,
                doshaEffectVata:    raw.doshaEffectVata,
                doshaEffectPitta:   raw.doshaEffectPitta,
                doshaEffectKapha:   raw.doshaEffectKapha,
                rasa:               splitList(raw.rasa).map((s) => s.toUpperCase()),
                guna:               splitList(raw.guna).map((s) => s.toUpperCase()),
                virya:              raw.virya,
                seasons:            splitList(raw.seasons).map((s) => s.toUpperCase()),
                preparationMethods: splitList(raw.preparationMethods),
                calories:           raw.calories,
                protein:            raw.protein,
                carbs:              raw.carbs,
                fat:                raw.fat,
                fiber:              raw.fiber,
                commonAllergies:    splitList(raw.commonAllergies),
            });
            valid.push({ ...normalised, branchId, createdById });
            void rowIdx;
        } catch (err) {
            errors.push({ row: idx + 1, error: err.message, code: err.code || 'INVALID_ROW' });
        }
    });

    if (valid.length === 0) {
        return { imported: 0, skipped: errors.length, errors };
    }

    // createMany skips relation-shape inference — we already include scalar
    // FKs (branchId, createdById). skipDuplicates: true is unsafe on this
    // schema (no unique index on name+branch), so we just insert.
    const created = await prisma.ayurvedicFood.createMany({ data: valid });
    return { imported: created.count, skipped: errors.length, errors };
}

// ── Recipes ──────────────────────────────────────────────────────────────────

export async function getAllRecipes({ branchId, doshaTarget, mealCategory, query, page = 1, limit = 20 }) {
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const where = { branchId, isActive: true };
    if (mealCategory) where.mealCategory = mealCategory;
    if (doshaTarget) where.doshaTargets = { has: doshaTarget };
    if (query && query.trim().length > 0) {
        where.OR = [
            { name:        { contains: query, mode: 'insensitive' } },
            { nameInTamil: { contains: query, mode: 'insensitive' } },
        ];
    }
    const [total, data] = await Promise.all([
        prisma.ayurvedicRecipe.count({ where }),
        prisma.ayurvedicRecipe.findMany({
            where,
            orderBy: [{ name: 'asc' }],
            skip: (safePage - 1) * safeLimit,
            take: safeLimit,
            include: { _count: { select: { ingredients: true } } },
        }),
    ]);
    return {
        data,
        pagination: {
            page: safePage,
            limit: safeLimit,
            total,
            totalPages: Math.max(1, Math.ceil(total / safeLimit)),
        },
    };
}

export async function getRecipeById(recipeId) {
    const recipe = await prisma.ayurvedicRecipe.findUnique({
        where: { id: recipeId },
        include: {
            ingredients: {
                orderBy: [{ sortOrder: 'asc' }],
                include: {
                    food: { select: { id: true, name: true, nameInTamil: true, category: true } },
                },
            },
        },
    });
    if (!recipe) throw httpError(404, 'NOT_FOUND', 'Recipe not found');
    return recipe;
}

/**
 * Recipe typeahead — mirrors suggestFoods so the diet-meal "Link Food"
 * dropdown can render foods and recipes side by side. Returns a lean
 * shape with just enough metadata to render a result row and explain
 * what gets linked when the user picks it.
 */
export async function suggestRecipes({ query, doshaTarget, branchId, limit = 8 }) {
    if (!branchId) throw httpError(400, 'BRANCH_REQUIRED', 'branchId is required');
    const safeLimit = Math.min(50, Math.max(1, Number(limit) || 8));
    const trimmed = (query || '').trim();
    const where = { branchId, isActive: true };
    if (trimmed.length > 0) {
        where.OR = [
            { name:        { contains: trimmed, mode: 'insensitive' } },
            { nameInTamil: { contains: trimmed, mode: 'insensitive' } },
        ];
    }
    if (doshaTarget === 'VATA' || doshaTarget === 'PITTA' || doshaTarget === 'KAPHA' || doshaTarget === 'TRIDOSHA') {
        // Recipes carry their pacifying targets as a string array, so we
        // bump matches to the top via a separate query (no compound where
        // is needed — the AND would over-filter and miss good matches).
        const targeted = await prisma.ayurvedicRecipe.findMany({
            where: { ...where, doshaTargets: { has: doshaTarget } },
            orderBy: [{ name: 'asc' }],
            take: safeLimit,
            select: {
                id: true, name: true, nameInTamil: true, doshaTargets: true,
                mealCategory: true,
                _count: { select: { ingredients: true } },
            },
        });
        if (targeted.length >= safeLimit) return targeted;
        const excludeIds = targeted.map((r) => r.id);
        const filler = await prisma.ayurvedicRecipe.findMany({
            where: { ...where, id: { notIn: excludeIds.length ? excludeIds : ['__none__'] } },
            orderBy: [{ name: 'asc' }],
            take: safeLimit - targeted.length,
            select: {
                id: true, name: true, nameInTamil: true, doshaTargets: true,
                mealCategory: true,
                _count: { select: { ingredients: true } },
            },
        });
        return [...targeted, ...filler];
    }
    return prisma.ayurvedicRecipe.findMany({
        where,
        orderBy: [{ name: 'asc' }],
        take: safeLimit,
        select: {
            id: true, name: true, nameInTamil: true, doshaTargets: true,
            mealCategory: true,
            _count: { select: { ingredients: true } },
        },
    });
}

function _normaliseRecipeInput(raw) {
    if (!raw || typeof raw !== 'object') throw httpError(400, 'INVALID_PAYLOAD', 'Recipe payload is required');
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) throw httpError(400, 'NAME_REQUIRED', 'Recipe name is required');
    return {
        name,
        nameInTamil:     typeof raw.nameInTamil === 'string' ? raw.nameInTamil.trim() : null,
        description:     typeof raw.description === 'string' ? raw.description.trim() : null,
        doshaTargets:    Array.isArray(raw.doshaTargets) ? raw.doshaTargets.filter((s) => typeof s === 'string') : [],
        prepTimeMinutes: Number.isFinite(Number(raw.prepTimeMinutes)) ? Number(raw.prepTimeMinutes) : 0,
        cookTimeMinutes: Number.isFinite(Number(raw.cookTimeMinutes)) ? Number(raw.cookTimeMinutes) : 0,
        servings:        Number.isFinite(Number(raw.servings)) ? Number(raw.servings) : 2,
        instructions:    Array.isArray(raw.instructions) ? raw.instructions.filter((s) => typeof s === 'string') : [],
        mealCategory:    typeof raw.mealCategory === 'string' ? raw.mealCategory : 'GENERAL',
        imageUrl:        typeof raw.imageUrl === 'string' ? raw.imageUrl : null,
        isActive:        typeof raw.isActive === 'boolean' ? raw.isActive : true,
    };
}

export async function createRecipe(data, createdById, branchId) {
    if (!branchId) throw httpError(400, 'BRANCH_REQUIRED', 'branchId is required');
    if (!createdById) throw httpError(400, 'USER_REQUIRED', 'createdById is required');
    const normalised = _normaliseRecipeInput(data);
    const ingredients = Array.isArray(data?.ingredients) ? data.ingredients : [];
    return prisma.$transaction(async (tx) => {
        const recipe = await tx.ayurvedicRecipe.create({
            data: { ...normalised, branchId, createdById },
        });
        if (ingredients.length > 0) {
            await tx.recipeIngredient.createMany({
                data: ingredients.map((ing, idx) => ({
                    recipeId: recipe.id,
                    foodId:   ing.foodId,
                    quantity: Number(ing.quantity) || 0,
                    unit:     ing.unit || '',
                    notes:    ing.notes || null,
                    sortOrder: Number(ing.sortOrder) || idx,
                })),
            });
        }
        return tx.ayurvedicRecipe.findUnique({
            where: { id: recipe.id },
            include: {
                ingredients: {
                    orderBy: [{ sortOrder: 'asc' }],
                    include: { food: { select: { id: true, name: true, nameInTamil: true, category: true } } },
                },
            },
        });
    });
}

export async function updateRecipe(recipeId, data, requestingUserId, requestingUserRole) {
    const existing = await prisma.ayurvedicRecipe.findUnique({
        where: { id: recipeId },
        select: { id: true, createdById: true },
    });
    if (!existing) throw httpError(404, 'NOT_FOUND', 'Recipe not found');
    const isAdmin = requestingUserRole === 'ADMIN' || requestingUserRole === 'ADMIN_DOCTOR';
    if (!isAdmin && existing.createdById !== requestingUserId) {
        throw httpError(403, 'FORBIDDEN', 'You can only update recipes you created');
    }
    const patch = _normaliseRecipeInput({ ...data, name: data?.name ?? 'placeholder' });
    if (data?.name === undefined) delete patch.name;
    const ingredients = Array.isArray(data?.ingredients) ? data.ingredients : null;

    return prisma.$transaction(async (tx) => {
        await tx.ayurvedicRecipe.update({ where: { id: recipeId }, data: patch });
        if (ingredients) {
            await tx.recipeIngredient.deleteMany({ where: { recipeId } });
            if (ingredients.length > 0) {
                await tx.recipeIngredient.createMany({
                    data: ingredients.map((ing, idx) => ({
                        recipeId,
                        foodId:   ing.foodId,
                        quantity: Number(ing.quantity) || 0,
                        unit:     ing.unit || '',
                        notes:    ing.notes || null,
                        sortOrder: Number(ing.sortOrder) || idx,
                    })),
                });
            }
        }
        return tx.ayurvedicRecipe.findUnique({
            where: { id: recipeId },
            include: {
                ingredients: {
                    orderBy: [{ sortOrder: 'asc' }],
                    include: { food: { select: { id: true, name: true, nameInTamil: true, category: true } } },
                },
            },
        });
    });
}

export async function deleteRecipe(recipeId, requestingUserId, requestingUserRole) {
    const existing = await prisma.ayurvedicRecipe.findUnique({
        where: { id: recipeId },
        select: { id: true, createdById: true },
    });
    if (!existing) throw httpError(404, 'NOT_FOUND', 'Recipe not found');
    const isAdmin = requestingUserRole === 'ADMIN' || requestingUserRole === 'ADMIN_DOCTOR';
    if (!isAdmin && existing.createdById !== requestingUserId) {
        throw httpError(403, 'FORBIDDEN', 'You can only delete recipes you created');
    }
    // Cascade handles RecipeIngredient (FK has onDelete: Cascade).
    await prisma.ayurvedicRecipe.delete({ where: { id: recipeId } });
    return { message: 'Recipe deleted' };
}

// ── DietMeal ↔ Food links ────────────────────────────────────────────────────

export async function linkFoodToMeal(mealId, { foodId, foodNameFree, quantity, unit, notes, isAvoid }) {
    if (!mealId) throw httpError(400, 'MEAL_REQUIRED', 'mealId is required');
    const hasFoodId = typeof foodId === 'string' && foodId.length > 0;
    const hasFreeText = typeof foodNameFree === 'string' && foodNameFree.trim().length > 0;
    if (!hasFoodId && !hasFreeText) {
        throw httpError(400, 'FOOD_REFERENCE_REQUIRED', 'Either foodId or foodNameFree must be provided');
    }
    // Verify the meal exists so we don't dangle orphaned links.
    const meal = await prisma.dietMeal.findUnique({ where: { id: mealId }, select: { id: true } });
    if (!meal) throw httpError(404, 'NOT_FOUND', 'Diet meal not found');

    if (hasFoodId) {
        const food = await prisma.ayurvedicFood.findUnique({ where: { id: foodId }, select: { id: true } });
        if (!food) throw httpError(404, 'FOOD_NOT_FOUND', 'Food not found');
    }

    // Order new links to the bottom of the existing list.
    const last = await prisma.dietMealFoodLink.findFirst({
        where: { mealId, isAvoid: !!isAvoid },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
    });
    const nextOrder = (last?.sortOrder ?? -1) + 1;

    return prisma.dietMealFoodLink.create({
        data: {
            mealId,
            foodId:       hasFoodId ? foodId : null,
            foodNameFree: hasFoodId ? null : foodNameFree.trim(),
            quantity:     quantity === undefined || quantity === null ? null : Number(quantity),
            unit:         typeof unit === 'string' ? unit : null,
            notes:        typeof notes === 'string' ? notes : null,
            isAvoid:      !!isAvoid,
            sortOrder:    nextOrder,
        },
        include: {
            food: { select: { id: true, name: true, nameInTamil: true, category: true, calories: true,
                              doshaEffectVata: true, doshaEffectPitta: true, doshaEffectKapha: true } },
        },
    });
}

/**
 * Link an entire recipe to a meal by expanding each of its ingredients
 * into a DietMealFoodLink row. No DietMealRecipeLink table exists — the
 * recipe is treated as a "shortcut" for bulk-adding food links, which
 * keeps the data model identical to manual linking and avoids a schema
 * migration. Each generated link's `notes` records the source recipe so
 * later edits can still see where the row came from.
 *
 * Returns { added, links } where `added` is the count of created rows.
 */
export async function linkRecipeToMeal(mealId, { recipeId, isAvoid }) {
    if (!mealId)   throw httpError(400, 'MEAL_REQUIRED',   'mealId is required');
    if (!recipeId) throw httpError(400, 'RECIPE_REQUIRED', 'recipeId is required');

    const [meal, recipe] = await Promise.all([
        prisma.dietMeal.findUnique({ where: { id: mealId }, select: { id: true } }),
        prisma.ayurvedicRecipe.findUnique({
            where: { id: recipeId },
            include: {
                ingredients: {
                    orderBy: [{ sortOrder: 'asc' }],
                    include: { food: { select: { id: true } } },
                },
            },
        }),
    ]);
    if (!meal)   throw httpError(404, 'NOT_FOUND',        'Diet meal not found');
    if (!recipe) throw httpError(404, 'RECIPE_NOT_FOUND', 'Recipe not found');
    if (!recipe.ingredients || recipe.ingredients.length === 0) {
        throw httpError(409, 'EMPTY_RECIPE', 'This recipe has no ingredients to link');
    }

    // Append new links after any existing ones on the same isAvoid bucket
    // so the sort order stays stable.
    const last = await prisma.dietMealFoodLink.findFirst({
        where: { mealId, isAvoid: !!isAvoid },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
    });
    let nextOrder = (last?.sortOrder ?? -1) + 1;

    const noteTag = `from recipe: ${recipe.name}`;

    return prisma.$transaction(async (tx) => {
        const created = [];
        for (const ing of recipe.ingredients) {
            if (!ing.foodId) continue; // defensive — ingredient without a Food row can't be linked
            const link = await tx.dietMealFoodLink.create({
                data: {
                    mealId,
                    foodId:       ing.foodId,
                    foodNameFree: null,
                    quantity:     ing.quantity ?? null,
                    unit:         ing.unit || null,
                    notes:        ing.notes ? `${noteTag} · ${ing.notes}` : noteTag,
                    isAvoid:      !!isAvoid,
                    sortOrder:    nextOrder++,
                },
                include: {
                    food: { select: { id: true, name: true, nameInTamil: true, category: true, calories: true,
                                      doshaEffectVata: true, doshaEffectPitta: true, doshaEffectKapha: true } },
                },
            });
            created.push(link);
        }
        return { added: created.length, recipeId, recipeName: recipe.name, links: created };
    });
}

export async function unlinkFoodFromMeal(linkId) {
    const link = await prisma.dietMealFoodLink.findUnique({ where: { id: linkId }, select: { id: true } });
    if (!link) throw httpError(404, 'NOT_FOUND', 'Link not found');
    await prisma.dietMealFoodLink.delete({ where: { id: linkId } });
    return { message: 'Link removed' };
}

export async function getMealFoodLinks(mealId) {
    if (!mealId) throw httpError(400, 'MEAL_REQUIRED', 'mealId is required');
    const links = await prisma.dietMealFoodLink.findMany({
        where: { mealId },
        orderBy: [{ isAvoid: 'asc' }, { sortOrder: 'asc' }],
        include: {
            food: { select: { id: true, name: true, nameInTamil: true, category: true, calories: true,
                              doshaEffectVata: true, doshaEffectPitta: true, doshaEffectKapha: true } },
        },
    });
    return {
        foods:      links.filter((l) => !l.isAvoid),
        avoidFoods: links.filter((l) =>  l.isAvoid),
    };
}

// ── Stats ────────────────────────────────────────────────────────────────────

export async function getFoodDatabaseStats(branchId) {
    if (!branchId) {
        // Admin viewing without a branch context — return zeros rather than 400
        // so the dashboard widget renders cleanly while branch is being chosen.
        logger.info('[ayurvedicFood.service] stats called without branchId — returning empty stats');
        return { totalFoods: 0, totalRecipes: 0, byCategory: {} };
    }
    const [totalFoods, totalRecipes, grouped] = await Promise.all([
        prisma.ayurvedicFood.count({ where: { branchId, isActive: true } }),
        prisma.ayurvedicRecipe.count({ where: { branchId, isActive: true } }),
        prisma.ayurvedicFood.groupBy({
            by: ['category'],
            where: { branchId, isActive: true },
            _count: { _all: true },
        }),
    ]);
    const byCategory = {};
    for (const cat of VALID_FOOD_CATEGORIES) byCategory[cat] = 0;
    for (const row of grouped) byCategory[row.category] = row._count._all;
    return { totalFoods, totalRecipes, byCategory };
}
