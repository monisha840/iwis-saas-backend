/**
 * One-off test — send both WhatsApp appointment templates (OFFLINE + ONLINE)
 * to a hardcoded number, using the "chellakannu" patient's name for personalization.
 *
 * Run once:  node send-test-whatsapp.js
 */

import 'dotenv/config';
import prisma from './lib/prisma.js';
import { WhatsAppService } from './services/whatsapp.service.js';

const TARGET_NUMBER = '917806966124';

async function main() {
    // 1. Find chellakannu (patient)
    const patient = await prisma.patient.findFirst({
        where: { fullName: { contains: 'chellakannu', mode: 'insensitive' } },
        include: { user: { select: { email: true } } },
    });

    const patientName = patient?.fullName || 'Chellakannu';

    // 2. Pick any doctor to use as the clinician in the templates
    const doctor = await prisma.doctor.findFirst({ select: { fullName: true } });
    const clinicianName = doctor?.fullName || 'Dr. Al-Shifa';

    // 3. Appointment datetime — "tomorrow at 10:30 AM" in IST
    const when = new Date();
    when.setDate(when.getDate() + 1);
    when.setHours(10, 30, 0, 0);

    const dateAndTime = when.toLocaleString('en-IN', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
    });

    const estimatedTime = '30 minutes';
    const meetingLink = 'https://meet.jit.si/alshifa-test-chellakannu';

    // 4. Build both templates (same shape as notification.service.js)
    const offlineText = `Dear ${patientName},

This is to formally confirm that your appointment has been successfully scheduled.

You are booked for a consultation with ${clinicianName} on ${dateAndTime}.
Your estimated consultation time is ${estimatedTime}.

Kindly arrive at least 10–15 minutes prior to your scheduled time to complete any required formalities. Please bring any relevant medical records or documents for reference.

Should you require any assistance, rescheduling, or further clarification, please do not hesitate to contact the hospital administration.

Sincerely,
Al-Shifa Group of Hospitals`;

    const onlineText = `Dear ${patientName},

This is to formally confirm that your online consultation has been successfully scheduled.
You are booked for a virtual consultation with ${clinicianName} on ${dateAndTime}. Your estimated consultation time is ${estimatedTime}.
Kindly join the meeting 5–10 minutes prior to your scheduled time to ensure your device, camera, and microphone are functioning properly. Please keep any relevant medical records or documents ready for reference during the session. For the best experience, we recommend using a stable internet connection and a quiet, private space.
Your meeting link: ${meetingLink}
Should you require any assistance, rescheduling, or further clarification, please do not hesitate to contact the hospital administration.
Sincerely,
Al-Shifa Group of Hospitals`;

    console.log('── Test WhatsApp Send ─────────────────────────────');
    console.log('Patient:   ', patientName, patient ? `(user.email=${patient.user?.email})` : '(not found in DB — using fallback name)');
    console.log('Clinician: ', clinicianName);
    console.log('Number:    ', TARGET_NUMBER);
    console.log('Evolution: ', WhatsAppService.enabled ? 'configured' : 'NOT CONFIGURED — messages will be skipped');
    console.log('───────────────────────────────────────────────────');

    // 5. Send OFFLINE
    console.log('\n[1/2] Sending OFFLINE (direct appointment) template...');
    const offlineResult = await WhatsAppService.sendText(TARGET_NUMBER, offlineText);
    console.log('Result:', offlineResult);

    // 6. Send ONLINE
    console.log('\n[2/2] Sending ONLINE (virtual consultation) template...');
    const onlineResult = await WhatsAppService.sendText(TARGET_NUMBER, onlineText);
    console.log('Result:', onlineResult);

    console.log('\n── Done ───────────────────────────────────────────');
}

main()
    .catch((err) => {
        console.error('[send-test-whatsapp] FAILED:', err);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
