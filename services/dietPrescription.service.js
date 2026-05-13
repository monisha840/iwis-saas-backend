import prisma from '../lib/prisma.js';

/**
 * Diet Prescription (IWIS competitor feature 2)
 * Structured Pathya-Apathya per patient with per-meal guidance + adherence log.
 */
export class DietPrescriptionService {
    static async create({ patientId, doctorId, title, doshaTarget, category, startDate, endDate, notes, journeyId, meals = [] }) {
        return prisma.dietPrescription.create({
            data: {
                patientId, doctorId, title, doshaTarget, category,
                startDate: new Date(startDate),
                endDate: endDate ? new Date(endDate) : null,
                notes, journeyId,
                meals: {
                    create: meals.map((m) => ({
                        mealTime: m.mealTime,
                        foods: m.foods || [],
                        avoidFoods: m.avoidFoods || [],
                        instructions: m.instructions || null,
                    }))
                }
            },
            include: { meals: true },
        });
    }

    /** Append a new meal slot to an existing prescription. Refuses to
     *  create a duplicate slot (the same MealTime twice on one prescription
     *  is meaningless — DietAdherenceLog keys on (prescriptionId, mealTime)). */
    static async addMeal(prescriptionId, { mealTime, foods = [], avoidFoods = [], instructions }) {
        const exists = await prisma.dietMeal.findFirst({
            where: { dietPrescriptionId: prescriptionId, mealTime },
            select: { id: true },
        });
        if (exists) {
            throw Object.assign(
                new Error(`A ${mealTime} slot already exists on this prescription`),
                { status: 409, code: 'DUPLICATE_MEAL_SLOT' },
            );
        }
        return prisma.dietMeal.create({
            data: {
                dietPrescriptionId: prescriptionId,
                mealTime,
                foods,
                avoidFoods,
                instructions: instructions || null,
            },
        });
    }

    /** Update a single DietMeal slot (foods, avoidFoods, instructions).
     *  Verifies the meal belongs to the supplied prescription so a stray
     *  mealId can't be edited via the wrong parent. mealTime is fixed
     *  (the slot identity) — change it by deleting + recreating. */
    static async updateMeal(prescriptionId, mealId, { foods, avoidFoods, instructions }) {
        const meal = await prisma.dietMeal.findUnique({
            where: { id: mealId },
            select: { dietPrescriptionId: true },
        });
        if (!meal || meal.dietPrescriptionId !== prescriptionId) {
            throw Object.assign(new Error('Meal not found in this prescription'), { status: 404 });
        }
        return prisma.dietMeal.update({
            where: { id: mealId },
            data: {
                ...(Array.isArray(foods) ? { foods } : {}),
                ...(Array.isArray(avoidFoods) ? { avoidFoods } : {}),
                ...(typeof instructions === 'string' ? { instructions } : {}),
            },
        });
    }

    /** Delete a DietMeal slot. Refuses to leave the prescription with zero
     *  meals — caller should delete the prescription itself in that case. */
    static async deleteMeal(prescriptionId, mealId) {
        const meal = await prisma.dietMeal.findUnique({
            where: { id: mealId },
            select: { dietPrescriptionId: true },
        });
        if (!meal || meal.dietPrescriptionId !== prescriptionId) {
            throw Object.assign(new Error('Meal not found in this prescription'), { status: 404 });
        }
        const remaining = await prisma.dietMeal.count({
            where: { dietPrescriptionId: prescriptionId },
        });
        if (remaining <= 1) {
            throw Object.assign(
                new Error('A diet prescription must have at least one meal. Delete the entire prescription instead.'),
                { status: 400, code: 'LAST_MEAL' },
            );
        }
        return prisma.dietMeal.delete({ where: { id: mealId } });
    }

    static async listForPatient(patientId) {
        return prisma.dietPrescription.findMany({
            where: { patientId },
            include: { meals: true, doctor: { select: { fullName: true } } },
            orderBy: { createdAt: 'desc' },
        });
    }

    /**
     * Delete a prescription. Soft-deletes (isActive=false) when adherence
     * logs reference it — we keep the row so historical compliance data
     * stays intact. Hard-deletes when no logs exist (a typo or test row
     * the doctor wants gone).
     *
     * Returns { mode: 'soft' | 'hard' } so the route can pick the right
     * toast copy.
     */
    static async delete(id) {
        const logCount = await prisma.dietAdherenceLog.count({
            where: { dietPrescriptionId: id },
        });
        if (logCount > 0) {
            await prisma.dietPrescription.update({
                where: { id },
                data: { isActive: false },
            });
            return { mode: 'soft', adherenceLogs: logCount };
        }
        await prisma.$transaction([
            prisma.dietMeal.deleteMany({ where: { dietPrescriptionId: id } }),
            prisma.dietPrescription.delete({ where: { id } }),
        ]);
        return { mode: 'hard' };
    }

    static async update(id, data) {
        const { meals, ...rest } = data;
        return prisma.$transaction(async (tx) => {
            const updated = await tx.dietPrescription.update({ where: { id }, data: rest });
            if (Array.isArray(meals)) {
                await tx.dietMeal.deleteMany({ where: { dietPrescriptionId: id } });
                await tx.dietMeal.createMany({
                    data: meals.map((m) => ({
                        dietPrescriptionId: id,
                        mealTime: m.mealTime,
                        foods: m.foods || [],
                        avoidFoods: m.avoidFoods || [],
                        instructions: m.instructions || null,
                    }))
                });
            }
            return tx.dietPrescription.findUnique({ where: { id }, include: { meals: true } });
        });
    }

    static async getTodayPlan(prescriptionId) {
        const p = await prisma.dietPrescription.findUnique({
            where: { id: prescriptionId },
            include: { meals: { orderBy: { mealTime: 'asc' } } },
        });
        if (!p) return null;
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const logs = await prisma.dietAdherenceLog.findMany({
            where: { dietPrescriptionId: prescriptionId, date: { gte: today } },
        });
        const meals = p.meals.map((m) => ({
            ...m,
            loggedToday: logs.find((l) => l.mealTime === m.mealTime) || null,
        }));
        return { prescription: p, meals };
    }

    static async logAdherence({ prescriptionId, patientId, mealTime, followed, notes, date }) {
        // Normalize to UTC midnight so the unique key is timezone-independent.
        // Using setHours(0,0,0,0) would shift the day boundary with the server
        // TZ and cause duplicate rows for users in other zones.
        const src = date ? new Date(date) : new Date();
        const d = new Date(Date.UTC(src.getUTCFullYear(), src.getUTCMonth(), src.getUTCDate()));
        return prisma.dietAdherenceLog.upsert({
            where: {
                dietPrescriptionId_patientId_mealTime_date: {
                    dietPrescriptionId: prescriptionId,
                    patientId,
                    mealTime,
                    date: d,
                },
            },
            update: { followed, notes, loggedAt: new Date() },
            create: { dietPrescriptionId: prescriptionId, patientId, mealTime, followed, notes, date: d },
        });
    }

    /**
     * Compute adherence % over a look-back window. Feeds the wellness score's
     * Task Adherence dimension and the care-gap detector.
     */
    static async getAdherenceSummary(prescriptionId, days = 30) {
        const since = new Date(); since.setDate(since.getDate() - days);
        const logs = await prisma.dietAdherenceLog.findMany({
            where: { dietPrescriptionId: prescriptionId, date: { gte: since } },
        });
        const followed = logs.filter((l) => l.followed).length;
        const adherencePct = logs.length ? Math.round((followed / logs.length) * 100) : 0;
        return { totalLogs: logs.length, followed, missed: logs.length - followed, adherencePct, days };
    }
}
