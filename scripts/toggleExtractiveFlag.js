// Toggle the VOICE_COACH_EXTRACTIVE_ONLY hospital feature flag without
// touching the Supabase SQL editor. Uses the same Prisma connection the
// backend uses (DATABASE_URL from .env).
//
//   node scripts/toggleExtractiveFlag.js status
//   node scripts/toggleExtractiveFlag.js on
//   node scripts/toggleExtractiveFlag.js off
//
// By default targets the lone hospital in the DB (typical dev setup).
// Pass --hospitalId=<id> to target a specific one when multiple exist.

import 'dotenv/config';
import prisma from '../lib/prisma.js';

const FLAG_KEY = 'VOICE_COACH_EXTRACTIVE_ONLY';

const [, , cmd, ...rest] = process.argv;
const hospitalIdArg = rest
    .find(a => a.startsWith('--hospitalId='))
    ?.split('=')[1];

async function resolveHospitalId() {
    if (hospitalIdArg) return hospitalIdArg;
    const hospitals = await prisma.hospital.findMany({ select: { id: true, name: true, slug: true } });
    if (hospitals.length === 0) throw new Error('No hospital rows found.');
    if (hospitals.length > 1) {
        console.log('Multiple hospitals detected:');
        for (const h of hospitals) console.log(`  ${h.id}  ${h.slug}  ${h.name}`);
        throw new Error('Pass --hospitalId=<id> to choose one.');
    }
    return hospitals[0].id;
}

async function main() {
    const hospitalId = await resolveHospitalId();
    const registry = await prisma.featureRegistry.findUnique({ where: { key: FLAG_KEY } });
    if (!registry) {
        console.log(`[toggleExtractiveFlag] FeatureRegistry row for '${FLAG_KEY}' is missing.`);
        console.log('  Boot the backend once (npm run dev) — the seed step will register it.');
        process.exit(1);
    }

    if (cmd === 'status' || !cmd) {
        const row = await prisma.hospitalFeatureFlag.findUnique({
            where: { hospitalId_featureKey: { hospitalId, featureKey: FLAG_KEY } },
            select: { enabled: true, enabledAt: true, notes: true },
        });
        console.log(`[toggleExtractiveFlag] hospital=${hospitalId} flag=${FLAG_KEY}`);
        if (!row) console.log('  state: NO ROW (effectively off — LLM path in use)');
        else console.log(`  state: ${row.enabled ? 'ON (extractive)' : 'OFF (LLM)'} (set ${row.enabledAt?.toISOString() ?? 'never'})`);
        return;
    }

    if (cmd !== 'on' && cmd !== 'off') {
        console.error('Usage: node scripts/toggleExtractiveFlag.js {status|on|off} [--hospitalId=<id>]');
        process.exit(1);
    }

    const enabled = cmd === 'on';
    await prisma.hospitalFeatureFlag.upsert({
        where: { hospitalId_featureKey: { hospitalId, featureKey: FLAG_KEY } },
        update: { enabled, enabledAt: enabled ? new Date() : null },
        create: { hospitalId, featureKey: FLAG_KEY, enabled, enabledAt: enabled ? new Date() : null },
    });
    console.log(`[toggleExtractiveFlag] hospital=${hospitalId} flag=${FLAG_KEY} -> ${enabled ? 'ON' : 'OFF'}`);
    console.log('  Restart the backend if you want to drop any cached state. Voice coach picks up the change on the next turn.');
}

main()
    .catch(err => {
        console.error('[toggleExtractiveFlag] FATAL', err);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
