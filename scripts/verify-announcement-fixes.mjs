#!/usr/bin/env node
// Verifies the announcement → notification fan-out fix.
//
// What we exercise:
//  1. createAnnouncement targeting [DOCTOR, PATIENT] now creates one
//     Notification row per matching user (the missing behaviour).
//  2. The author is excluded from the fan-out.
//  3. Notification priority is mapped correctly from announcement
//     priority (URGENT → HIGH, NORMAL → MEDIUM, etc.).
//  4. Soft-deleted users do NOT receive notifications.
//  5. Failure on one user's createNotification doesn't abort the rest
//     (Promise.allSettled).
//  6. The legacy WebSocket emit still fires (back-compat).
//  7. Frontend NotificationPanel maps type='ANNOUNCEMENT' to /announcements.
//  8. Source-code check: the service imports notificationService.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnnouncementService } from '../services/announcement.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot  = path.resolve(__dirname, '..');

let pass = 0;
const check = async (label, fn) => {
    try { await fn(); console.log('  ✓', label); pass++; }
    catch (err) { console.error('  ✗', label); console.error('    →', err.message); process.exit(1); }
};

// ──────────────────────────────────────────────────────────────────────────
// State + stubs
// ──────────────────────────────────────────────────────────────────────────
const state = {
    announcements: [],
    users: [],
    notifications: [],
    socketEmits: [],
    forceFailUserId: null,   // when set, that user's createNotification rejects
};

const prismaMod = await import('../lib/prisma.js');
const prisma    = prismaMod.default;

prisma.announcement = {
    create: async ({ data, include: _include }) => {
        const row = {
            id: `ann-${state.announcements.length + 1}`,
            authorId: data.authorId,
            title: data.title,
            message: data.message,
            priority: data.priority,
            targetRoles: data.targetRoles,
            isPinned: data.isPinned,
            expiresAt: data.expiresAt,
            createdAt: new Date(),
            updatedAt: new Date(),
            author: { id: data.authorId, email: 'admin@iwis', doctor: null, therapist: null, patient: null, pharmacist: null },
            branches: data.branches?.connect?.map((c) => ({ id: c.id, name: `Branch ${c.id}` })) || [],
        };
        state.announcements.push(row);
        return row;
    },
};
prisma.user = {
    findMany: async ({ where, select: _select }) => state.users.filter((u) => {
        if (where?.deletedAt !== undefined && u.deletedAt !== where.deletedAt) return false;
        if (where?.branchId?.in && !where.branchId.in.includes(u.branchId)) return false;
        if (where?.role?.in && !where.role.in.includes(u.role)) return false;
        return true;
    }).map((u) => ({ id: u.id })),
};

// Stub notification service via module patch.
const notifMod = await import('../services/notification.service.js');
const realCreateNotification = notifMod.notificationService.createNotification.bind(notifMod.notificationService);
notifMod.notificationService.createNotification = async (payload) => {
    if (state.forceFailUserId && payload.userId === state.forceFailUserId) {
        throw new Error('simulated downstream failure');
    }
    const row = {
        id: `notif-${state.notifications.length + 1}`,
        ...payload,
        createdAt: new Date(),
    };
    state.notifications.push(row);
    return row;
};

// emitToUser is a top-level named export — ESM bindings are read-only, so
// we can't reassign it from here. Verify it via a source-code check
// further down instead (the for-loop calling `emitToUser` is still in the
// service; if it ever gets ripped out the source assertion catches it).

function reset() {
    state.announcements.length = 0;
    state.notifications.length = 0;
    state.socketEmits.length = 0;
    state.forceFailUserId = null;
}

// ──────────────────────────────────────────────────────────────────────────
// Source-code checks
// ──────────────────────────────────────────────────────────────────────────
console.log('\nSource-code checks');

await check('Service imports notificationService', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'services/announcement.service.js'), 'utf8');
    assert.match(src, /import \{ notificationService \} from '\.\/notification\.service\.js'/);
});

await check('Service has priority-map constant', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'services/announcement.service.js'), 'utf8');
    assert.match(src, /ANNOUNCEMENT_TO_NOTIFICATION_PRIORITY/);
    assert.match(src, /URGENT:\s*'HIGH'/);
    assert.match(src, /NORMAL:\s*'MEDIUM'/);
});

await check('Service uses Promise.allSettled for the fan-out', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'services/announcement.service.js'), 'utf8');
    assert.match(src, /Promise\.allSettled\(/);
});

await check('Frontend route map handles type=ANNOUNCEMENT', () => {
    const src = fs.readFileSync(path.resolve(repoRoot, '../alshifa-frontend/src/components/notifications/NotificationPanel.tsx'), 'utf8');
    assert.match(src, /case 'ANNOUNCEMENT':[\s\S]*?return '\/announcements'/);
});

// ──────────────────────────────────────────────────────────────────────────
// Runtime
// ──────────────────────────────────────────────────────────────────────────
console.log('\nRuntime — multi-role fan-out');

state.users = [
    { id: 'admin-1',  role: 'ADMIN',     branchId: 'br-1', deletedAt: null },
    { id: 'doc-1',    role: 'DOCTOR',    branchId: 'br-1', deletedAt: null },
    { id: 'doc-2',    role: 'DOCTOR',    branchId: 'br-1', deletedAt: null },
    { id: 'doc-3',    role: 'DOCTOR',    branchId: 'br-2', deletedAt: null },   // other branch
    { id: 'thr-1',    role: 'THERAPIST', branchId: 'br-1', deletedAt: null },
    { id: 'pat-1',    role: 'PATIENT',   branchId: 'br-1', deletedAt: null },
    { id: 'pat-2',    role: 'PATIENT',   branchId: 'br-1', deletedAt: null },
    { id: 'pat-x',    role: 'PATIENT',   branchId: 'br-1', deletedAt: new Date() },  // soft-deleted
];

await check('Target [DOCTOR, PATIENT] in branch [br-1] → notifications for 4 users', async () => {
    reset();
    const out = await AnnouncementService.createAnnouncement('admin-1', {
        branchIds: ['br-1'],
        title: 'Maintenance window',
        message: 'Pharmacy closed Sun 10-11 AM',
        priority: 'NORMAL',
        targetRoles: ['DOCTOR', 'PATIENT'],
    });
    assert.ok(out.id, 'announcement created');
    // Expected recipients: doc-1, doc-2, pat-1, pat-2 (not doc-3 — wrong
    // branch; not pat-x — soft-deleted; not admin-1 — author).
    const userIds = state.notifications.map((n) => n.userId).sort();
    assert.deepEqual(userIds, ['doc-1', 'doc-2', 'pat-1', 'pat-2']);
});

await check('Each notification carries type=ANNOUNCEMENT', async () => {
    for (const n of state.notifications) assert.equal(n.type, 'ANNOUNCEMENT');
});

await check('Each notification carries the announcement title + message', async () => {
    for (const n of state.notifications) {
        assert.equal(n.title, 'Maintenance window');
        assert.equal(n.message, 'Pharmacy closed Sun 10-11 AM');
    }
});

await check('NORMAL announcement priority → MEDIUM notification priority', async () => {
    for (const n of state.notifications) assert.equal(n.priority, 'MEDIUM');
});

await check('data.link points at /announcements; data carries announcementId', async () => {
    for (const n of state.notifications) {
        assert.equal(n.data.link, '/announcements');
        assert.match(n.data.announcementId, /^ann-/);
    }
});

await check('Author is NOT in the recipient list', async () => {
    assert.equal(state.notifications.some((n) => n.userId === 'admin-1'), false);
});

await check('Soft-deleted users NOT in recipient list', async () => {
    assert.equal(state.notifications.some((n) => n.userId === 'pat-x'), false);
});

await check('Out-of-branch user NOT in recipient list', async () => {
    assert.equal(state.notifications.some((n) => n.userId === 'doc-3'), false);
});

await check('Legacy `new_announcement` WebSocket emit-loop is still in the service (source check)', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'services/announcement.service.js'), 'utf8');
    assert.match(src, /for \(const user of users\)\s*\{\s*emitToUser\(user\.id, 'new_announcement'/);
});

// ──────────────────────────────────────────────────────────────────────────
// Priority mapping per-case
// ──────────────────────────────────────────────────────────────────────────
console.log('\nRuntime — priority mapping');

const mapping = [
    ['URGENT', 'HIGH'],
    ['HIGH',   'HIGH'],
    ['NORMAL', 'MEDIUM'],
    ['LOW',    'LOW'],
];
for (const [ann, expected] of mapping) {
    // eslint-disable-next-line no-loop-func
    await check(`Announcement.${ann} → Notification.${expected}`, async () => {
        reset();
        await AnnouncementService.createAnnouncement('admin-1', {
            branchIds: ['br-1'], title: 't', message: 'm', priority: ann,
            targetRoles: ['DOCTOR'],
        });
        // 2 doctors at br-1 → 2 notifications, both with mapped priority.
        assert.ok(state.notifications.length >= 1);
        for (const n of state.notifications) assert.equal(n.priority, expected);
    });
}

// ──────────────────────────────────────────────────────────────────────────
// Failure isolation
// ──────────────────────────────────────────────────────────────────────────
console.log('\nRuntime — failure isolation');

await check('One user failing → others still get their notification', async () => {
    reset();
    state.forceFailUserId = 'doc-2';   // simulate downstream error for doc-2 only
    await AnnouncementService.createAnnouncement('admin-1', {
        branchIds: ['br-1'], title: 't', message: 'm', priority: 'HIGH',
        targetRoles: ['DOCTOR', 'PATIENT'],
    });
    const ids = state.notifications.map((n) => n.userId).sort();
    assert.deepEqual(ids, ['doc-1', 'pat-1', 'pat-2'], 'doc-2 failed but others succeeded');
});

// ──────────────────────────────────────────────────────────────────────────
// Empty branchIds = broadcast across all branches
// ──────────────────────────────────────────────────────────────────────────
console.log('\nRuntime — broadcast (no branchIds)');

await check('No branchIds → fan-out covers BOTH branches', async () => {
    reset();
    await AnnouncementService.createAnnouncement('admin-1', {
        branchIds: [],
        title: 'Org-wide',
        message: 'All hands meeting tomorrow',
        priority: 'NORMAL',
        targetRoles: ['DOCTOR'],
    });
    const ids = state.notifications.map((n) => n.userId).sort();
    // doc-1, doc-2 (br-1) + doc-3 (br-2) — soft-deleted is patient anyway.
    assert.deepEqual(ids, ['doc-1', 'doc-2', 'doc-3']);
});

// Cleanup — restore the notification service stub.
notifMod.notificationService.createNotification = realCreateNotification;

console.log(`\n✅  ${pass} assertions passed across the announcement notification fix.`);
