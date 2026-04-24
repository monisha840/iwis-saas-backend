/**
 * Seed a sample diet package for testing.
 *
 * Creates "VATA Pacification — 14 days" in APPROVED status (so it can be
 * assigned immediately) attributed to the first ADMIN or ADMIN_DOCTOR user
 * found. Idempotent: if a package with the same title and creator already
 * exists, it's refreshed rather than duplicated.
 *
 * Usage:
 *   cd alshifa-backend && node scripts/seed-diet-packages.js
 */
import prisma from '../lib/prisma.js';

const SAMPLE = {
    title:        'VATA Pacification — 14 days',
    description:  'Warming, grounding meals to balance VATA dosha. Emphasises cooked, moist, slightly oily foods with warm spices.',
    doshaTarget:  'VATA',
    category:     'SATTVIC',
    durationDays: 14,
    notes:        'Avoid cold, raw, and dry foods. Keep meal timings consistent. Hydrate with warm water through the day.',
    meals: [
        {
            mealTime: 'MORNING_EMPTY',
            foods: [
                { name: 'Warm water with ginger',    quantity: '200',  unit: 'ml' },
                { name: 'Soaked almonds',            quantity: '5',    unit: 'pcs' },
            ],
            avoidFoods: [
                { name: 'Cold water',          reason: 'Aggravates VATA' },
                { name: 'Caffeinated coffee',  reason: 'Dries the body' },
            ],
            instructions: 'Sip slowly on an empty stomach to kindle digestion.',
        },
        {
            mealTime: 'BREAKFAST',
            foods: [
                { name: 'Cooked oatmeal with ghee',   quantity: '1',  unit: 'bowl' },
                { name: 'Cooked apple with cinnamon', quantity: '1',  unit: 'small' },
                { name: 'Warm herbal tea',            quantity: '200',unit: 'ml' },
            ],
            avoidFoods: [
                { name: 'Cold cereal', reason: 'Too dry and cold for VATA' },
                { name: 'Raw fruits',  reason: 'Harder to digest when VATA is high' },
            ],
            instructions: 'Eat within 90 minutes of waking. Add a pinch of cardamom.',
        },
        {
            mealTime: 'MID_MORNING',
            foods: [
                { name: 'Dates',              quantity: '2',   unit: 'pcs' },
                { name: 'Warm ginger tea',    quantity: '150', unit: 'ml' },
            ],
            avoidFoods: [
                { name: 'Cold smoothies', reason: 'Cold + raw aggravates VATA' },
            ],
            instructions: 'Light snack only — don\'t overeat before lunch.',
        },
        {
            mealTime: 'LUNCH',
            foods: [
                { name: 'Basmati rice',                    quantity: '1',   unit: 'cup' },
                { name: 'Moong dal with ghee and cumin',   quantity: '1',   unit: 'bowl' },
                { name: 'Steamed vegetables (carrot, beet)',quantity: '1',  unit: 'cup' },
                { name: 'Buttermilk with rock salt',        quantity: '150',unit: 'ml' },
            ],
            avoidFoods: [
                { name: 'Raw salad',   reason: 'Too dry and rough' },
                { name: 'Cold drinks', reason: 'Extinguishes digestive fire' },
            ],
            instructions: 'Lunch should be the largest meal — eat between 12:00 and 13:30.',
        },
        {
            mealTime: 'EVENING',
            foods: [
                { name: 'Warm almond milk with turmeric', quantity: '200', unit: 'ml' },
                { name: 'Rice crackers with ghee',        quantity: '3',   unit: 'pcs' },
            ],
            avoidFoods: [
                { name: 'Fried snacks',  reason: 'Heavy and oily in excess aggravates digestion' },
            ],
            instructions: 'Light snack around 17:00–17:30 to bridge to dinner.',
        },
        {
            mealTime: 'DINNER',
            foods: [
                { name: 'Vegetable khichdi with ghee',       quantity: '1',   unit: 'bowl' },
                { name: 'Warm cooked greens (spinach, lauki)', quantity: '1', unit: 'cup' },
            ],
            avoidFoods: [
                { name: 'Heavy grains (wheat, barley)', reason: 'Harder to digest at night' },
                { name: 'Yogurt',                       reason: 'Aggravates kapha and disturbs sleep' },
            ],
            instructions: 'Eat by 19:30. Keep the meal light and warm.',
        },
        {
            mealTime: 'BEDTIME',
            foods: [
                { name: 'Warm milk with nutmeg', quantity: '150', unit: 'ml' },
            ],
            avoidFoods: [
                { name: 'Stimulating foods', reason: 'Disturbs VATA-related sleep' },
            ],
            instructions: 'Consume 30–45 minutes before sleeping.',
        },
    ],
};

async function main() {
    // Pick an approver-role user to attribute the seed to.
    const creator = await prisma.user.findFirst({
        where: {
            role:      { in: ['ADMIN', 'ADMIN_DOCTOR'] },
            deletedAt: null,
        },
        select: { id: true, hospitalId: true, email: true, role: true },
    });

    if (!creator) {
        console.error('[seed-diet-packages] No ADMIN or ADMIN_DOCTOR user found. Create one first.');
        process.exit(1);
    }
    console.log(`[seed-diet-packages] Attributing to ${creator.role} ${creator.email} (hospital=${creator.hospitalId ?? 'null'})`);

    // Idempotency: refresh if the same creator already has this titled package.
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
                status:          'APPROVED',
                isActive:        true,
                approvedById:    creator.id,
                approvedAt:      new Date(),
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
        console.log(`[seed-diet-packages] Refreshed existing package id=${refreshed.id}, meals=${refreshed.meals.length}`);
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
            status:       'APPROVED',
            isActive:     true,
            hospitalId:   creator.hospitalId ?? null,
            createdById:  creator.id,
            approvedById: creator.id,
            approvedAt:   new Date(),
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

    console.log(`[seed-diet-packages] Created package id=${pkg.id}, meals=${pkg.meals.length}, status=${pkg.status}`);
}

main()
    .catch((err) => { console.error('[seed-diet-packages] Error:', err); process.exit(1); })
    .finally(() => prisma.$disconnect());
