/**
 * Seed a doctor-authored diet package in PENDING status.
 *
 * Used to test the admin approval workflow: after running this, log in as
 * ADMIN or ADMIN_DOCTOR and go to /diet-packages → Pending tab → approve/reject.
 *
 * Usage:
 *   cd alshifa-backend && node scripts/seed-doctor-diet-package.js
 */
import prisma from '../lib/prisma.js';

const SAMPLE = {
    title:        'PITTA Summer Cooling — 21 days',
    description:  'Cooling, sweet, and slightly astringent foods to pacify elevated PITTA. Designed for summer heat and inflammation.',
    doshaTarget:  'PITTA',
    category:     'SATTVIC',
    durationDays: 21,
    notes:        'Avoid spicy, sour, salty, and fermented foods. Prefer cool (not cold) temperatures. Keep meal timings regular, especially lunch.',
    meals: [
        {
            mealTime: 'MORNING_EMPTY',
            foods: [
                { name: 'Room-temperature water with coriander', quantity: '200', unit: 'ml' },
                { name: 'Soaked raisins',                        quantity: '6',   unit: 'pcs' },
            ],
            avoidFoods: [
                { name: 'Hot water with lemon', reason: 'Sour + hot aggravates PITTA' },
                { name: 'Black coffee',         reason: 'Heating and acidic' },
            ],
            instructions: 'Drink cool (not icy) on an empty stomach.',
        },
        {
            mealTime: 'BREAKFAST',
            foods: [
                { name: 'Sweet ripe pear',          quantity: '1',   unit: 'medium' },
                { name: 'Rice porridge with ghee',  quantity: '1',   unit: 'bowl' },
                { name: 'Coconut water',            quantity: '200', unit: 'ml' },
            ],
            avoidFoods: [
                { name: 'Citrus fruits',       reason: 'Sour, heats PITTA' },
                { name: 'Tomatoes',            reason: 'Acidic and heating' },
            ],
            instructions: 'Eat within an hour of waking. Keep it cool-temperature.',
        },
        {
            mealTime: 'MID_MORNING',
            foods: [
                { name: 'Fresh cucumber slices',  quantity: '1',   unit: 'cup' },
                { name: 'Mint water',             quantity: '200', unit: 'ml' },
            ],
            avoidFoods: [
                { name: 'Salted nuts', reason: 'Salt + heat aggravates PITTA' },
            ],
            instructions: 'Small cooling snack only.',
        },
        {
            mealTime: 'LUNCH',
            foods: [
                { name: 'Basmati rice',                         quantity: '1',   unit: 'cup' },
                { name: 'Split moong dal (mild, no chili)',     quantity: '1',   unit: 'bowl' },
                { name: 'Bottle gourd sabzi with coriander',    quantity: '1',   unit: 'cup' },
                { name: 'Cucumber-raita with mint (no garlic)', quantity: '150', unit: 'ml' },
            ],
            avoidFoods: [
                { name: 'Chilies and hot peppers',  reason: 'Highly heating' },
                { name: 'Fermented pickles',        reason: 'Sour, disturbs PITTA' },
                { name: 'Mustard oil',              reason: 'Very heating' },
            ],
            instructions: 'Largest meal of the day — take between 12:00 and 13:00 when digestion is strongest.',
        },
        {
            mealTime: 'EVENING',
            foods: [
                { name: 'Fresh coconut flesh',          quantity: '30',  unit: 'g' },
                { name: 'Rose-petal infused water',     quantity: '200', unit: 'ml' },
            ],
            avoidFoods: [
                { name: 'Deep-fried snacks', reason: 'Oily and heating' },
            ],
            instructions: 'Light cooling snack around 17:00.',
        },
        {
            mealTime: 'DINNER',
            foods: [
                { name: 'Vegetable khichdi (moong + rice) with ghee', quantity: '1', unit: 'bowl' },
                { name: 'Steamed asparagus / zucchini',               quantity: '1', unit: 'cup' },
            ],
            avoidFoods: [
                { name: 'Red meat',      reason: 'Heavy and heating at night' },
                { name: 'Aged cheese',   reason: 'Fermented and sour' },
            ],
            instructions: 'Eat by 19:00. Keep meal simple and cooling.',
        },
        {
            mealTime: 'BEDTIME',
            foods: [
                { name: 'Warm (not hot) milk with rose water', quantity: '150', unit: 'ml' },
            ],
            avoidFoods: [
                { name: 'Spiced chai', reason: 'Heating at night, disturbs sleep for PITTA' },
            ],
            instructions: 'Sip 30 minutes before sleeping.',
        },
    ],
};

async function main() {
    // Pick a DOCTOR user (non-admin) to attribute authorship.
    const creator = await prisma.user.findFirst({
        where: {
            role:      'DOCTOR',
            deletedAt: null,
        },
        select: { id: true, hospitalId: true, email: true, role: true },
    });

    if (!creator) {
        console.error('[seed-doctor-diet-package] No DOCTOR user found. Create one first.');
        process.exit(1);
    }
    console.log(`[seed-doctor-diet-package] Attributing to DOCTOR ${creator.email} (hospital=${creator.hospitalId ?? 'null'})`);

    const existing = await prisma.dietPackage.findFirst({
        where: { title: SAMPLE.title, createdById: creator.id },
        select: { id: true },
    });

    if (existing) {
        await prisma.dietPackageMeal.deleteMany({ where: { packageId: existing.id } });
        const refreshed = await prisma.dietPackage.update({
            where: { id: existing.id },
            data: {
                description:     SAMPLE.description,
                doshaTarget:     SAMPLE.doshaTarget,
                category:        SAMPLE.category,
                durationDays:    SAMPLE.durationDays,
                notes:           SAMPLE.notes,
                status:          'PENDING',
                isActive:        true,
                approvedById:    null,
                approvedAt:      null,
                rejectionReason: null,
                meals: {
                    create: SAMPLE.meals.map((m) => ({
                        mealTime:     m.mealTime,
                        foods:        m.foods,
                        avoidFoods:   m.avoidFoods,
                        instructions: m.instructions,
                    })),
                },
            },
            include: { meals: true },
        });
        console.log(`[seed-doctor-diet-package] Refreshed existing id=${refreshed.id}, meals=${refreshed.meals.length}, status=PENDING`);
        return;
    }

    const pkg = await prisma.dietPackage.create({
        data: {
            title:        SAMPLE.title,
            description:  SAMPLE.description,
            doshaTarget:  SAMPLE.doshaTarget,
            category:     SAMPLE.category,
            durationDays: SAMPLE.durationDays,
            notes:        SAMPLE.notes,
            status:       'PENDING',
            isActive:     true,
            hospitalId:   creator.hospitalId ?? null,
            createdById:  creator.id,
            meals: {
                create: SAMPLE.meals.map((m) => ({
                    mealTime:     m.mealTime,
                    foods:        m.foods,
                    avoidFoods:   m.avoidFoods,
                    instructions: m.instructions,
                })),
            },
        },
        include: { meals: true },
    });

    console.log(`[seed-doctor-diet-package] Created id=${pkg.id}, meals=${pkg.meals.length}, status=${pkg.status}`);
    console.log(`[seed-doctor-diet-package] Log in as ADMIN/ADMIN_DOCTOR → /diet-packages → Pending tab to approve/reject.`);
}

main()
    .catch((err) => { console.error('[seed-doctor-diet-package] Error:', err); process.exit(1); })
    .finally(() => prisma.$disconnect());
