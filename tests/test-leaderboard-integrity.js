
import { LeaderboardService } from './services/leaderboard.service.js';
import prisma from './lib/prisma.js';
import crypto from 'crypto';

async function verifyIntegrity() {
    console.log('--- STARTING LEADERBOARD INTEGRITY VERIFICATION ---');

    try {
        console.log('\n1. Fetching Leaderboard...');
        const leaderboard = await LeaderboardService.getLeaderboard();
        console.log(`Found ${leaderboard.length} participants.`);

        if (leaderboard.length === 0) {
            console.log('No participants to verify.');
            return;
        }

        const top = leaderboard[0];
        console.log(`\n2. Verifying Top Participant: ${top.fullName} (Score: ${top.score})`);

        const latestAudit = await prisma.leaderboardAudit.findFirst({
            where: { participantId: top.id },
            orderBy: { calculationDate: 'desc' }
        });

        if (!latestAudit) {
            throw new Error('Audit record not found for top participant.');
        }

        console.log('Audit record found.');
        console.log('Source IDs count:', latestAudit.sourceRecordIds?.length || 0);
        console.log('Integrity Hash:', latestAudit.integrityHash);

        // 3. Manual Hash Verification
        console.log('\n3. Manually Verifying Integrity Hash...');
        const verifyData = {
            participantId: latestAudit.participantId,
            score: latestAudit.score,
            metrics: latestAudit.metrics,
            sourceRecordIds: latestAudit.sourceRecordIds
        };

        const sortedData = JSON.stringify(verifyData, Object.keys(verifyData).sort());
        const manualHash = crypto.createHash('sha256').update(sortedData).digest('hex');

        if (manualHash === latestAudit.integrityHash) {
            console.log('SUCCESS: Integrity hash matches!');
        } else {
            console.warn('WARNING: Integrity hash mismatch!');
            console.log('Manual:', manualHash);
            console.log('Stored:', latestAudit.integrityHash);
        }

        // 4. Checking Metrics Sources
        console.log('\n4. Verifying Metric Sources...');
        console.log('Response Time (min):', latestAudit.metrics.responseTime.value);
        console.log('Consistency (days):', latestAudit.metrics.consistency.value);

        console.log('\n--- VERIFICATION COMPLETED ---');

    } catch (error) {
        console.error('VERIFICATION FAILED:', error.message);
    } finally {
        await prisma.$disconnect();
    }
}

verifyIntegrity();
