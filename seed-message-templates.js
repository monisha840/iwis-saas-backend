/**
 * One-off seed — inserts the two hospital-authored appointment confirmation
 * templates (OFFLINE + ONLINE) into MessageTemplate and marks each as the
 * default for APPOINTMENT_CONFIRMATION.
 *
 * Run once:  node seed-message-templates.js
 * Safe to re-run (upserts by hospitalId+name).
 */

import 'dotenv/config';
import prisma from './lib/prisma.js';
import { extractPlaceholders } from './lib/templateRenderer.js';

const OFFLINE_NAME = 'Offline appointment confirmation';
const ONLINE_NAME  = 'Online appointment confirmation';

const OFFLINE_BODY = `Dear {{patientName}},

This is to formally confirm that your appointment has been successfully scheduled.

You are booked for a consultation with {{doctorName}} on {{appointmentDateTime}}.
Your estimated consultation time is 30 minutes.

Kindly arrive at least 10–15 minutes prior to your scheduled time to complete any required formalities. Please bring any relevant medical records or documents for reference.

Should you require any assistance, rescheduling, or further clarification, please do not hesitate to contact the hospital administration.

Sincerely,
Al-Shifa Group of Hospitals`;

const ONLINE_BODY = `Dear {{patientName}},

This is to formally confirm that your online consultation has been successfully scheduled.
You are booked for a virtual consultation with {{doctorName}} on {{appointmentDateTime}}. Your estimated consultation time is 30 minutes.

Kindly join the meeting 5–10 minutes prior to your scheduled time to ensure your device, camera, and microphone are functioning properly. Please keep any relevant medical records or documents ready for reference during the session. For the best experience, we recommend using a stable internet connection and a quiet, private space.

Your meeting link: {{meetingLink}}

Should you require any assistance, rescheduling, or further clarification, please do not hesitate to contact the hospital administration.

Sincerely,
Al-Shifa Group of Hospitals`;

async function main() {
    const hospital = await prisma.hospital.findFirst({
        where: { status: { not: 'DECOMMISSIONED' } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true },
    });
    if (!hospital) {
        throw new Error('No active hospital found — cannot attach templates.');
    }
    console.log(`Seeding templates for hospital: ${hospital.name} (${hospital.id})`);

    // Clear the default flag from any other APPOINTMENT_CONFIRMATION templates in this hospital
    // so the partial-unique index won't conflict (only one isDefault per category allowed).
    // We'll then set the OFFLINE one as default.
    await prisma.messageTemplate.updateMany({
        where: {
            hospitalId: hospital.id,
            category: 'APPOINTMENT_CONFIRMATION',
            isDefault: true,
        },
        data: { isDefault: false },
    });

    const offline = await prisma.messageTemplate.upsert({
        where: { hospitalId_name: { hospitalId: hospital.id, name: OFFLINE_NAME } },
        update: {
            body: OFFLINE_BODY,
            channels: ['WHATSAPP', 'SMS', 'EMAIL', 'IN_APP'],
            placeholders: extractPlaceholders(OFFLINE_BODY),
            isDefault: true,
            isActive: true,
        },
        create: {
            hospitalId: hospital.id,
            name: OFFLINE_NAME,
            category: 'APPOINTMENT_CONFIRMATION',
            body: OFFLINE_BODY,
            subject: 'Appointment confirmed',
            channels: ['WHATSAPP', 'SMS', 'EMAIL', 'IN_APP'],
            placeholders: extractPlaceholders(OFFLINE_BODY),
            isDefault: true,
            isActive: true,
        },
    });

    const online = await prisma.messageTemplate.upsert({
        where: { hospitalId_name: { hospitalId: hospital.id, name: ONLINE_NAME } },
        update: {
            body: ONLINE_BODY,
            channels: ['WHATSAPP', 'SMS', 'EMAIL', 'IN_APP'],
            placeholders: extractPlaceholders(ONLINE_BODY),
            isActive: true,
        },
        create: {
            hospitalId: hospital.id,
            name: ONLINE_NAME,
            category: 'APPOINTMENT_CONFIRMATION',
            body: ONLINE_BODY,
            subject: 'Online consultation confirmed',
            channels: ['WHATSAPP', 'SMS', 'EMAIL', 'IN_APP'],
            placeholders: extractPlaceholders(ONLINE_BODY),
            isDefault: false, // Only one can be isDefault per category; OFFLINE wins
            isActive: true,
        },
    });

    console.log('\n✅ Templates seeded:');
    console.log(`   OFFLINE (default)  id=${offline.id}  placeholders=${offline.placeholders.join(', ')}`);
    console.log(`   ONLINE             id=${online.id}  placeholders=${online.placeholders.join(', ')}`);
}

main()
    .catch((err) => {
        console.error('[seed-message-templates] FAILED:', err);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
