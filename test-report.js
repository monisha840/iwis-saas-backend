import { PrismaClient } from '@prisma/client';
import { analyticsService } from './services/analytics.service.js';

const prisma = new PrismaClient();

async function testReport() {
    console.log('--- Testing Progress Report ---');
    try {
        const patient = await prisma.patient.findFirst();
        if (!patient) {
            console.log('No patient found to test.');
            return;
        }

        console.log(`Testing for patient: ${patient.fullName} (${patient.id})`);

        const report = await analyticsService.getClientProgressReport(patient.id);

        console.log('Report Data:');
        console.log(`- Total Previous Sittings: ${report.totalPreviousSittings}`);
        console.log(`- Prev Avg Pain: ${report.previousData.averages.avgPain}`);
        console.log(`- Current Pain: ${report.currentSession.metrics.pain}`);
        console.log(`- Analysis: ${report.progressAnalysis.summary}`);

        console.log('--- Test Successful ---');
    } catch (error) {
        console.error('Test Failed:', error);
    } finally {
        await prisma.$disconnect();
    }
}

testReport();
