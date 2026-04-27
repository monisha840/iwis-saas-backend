/**
 * StaffChatService — staff-to-staff DMs and branch group chats.
 *
 * Distinct from the patient/clinician `Conversation` domain. Tenancy is
 * enforced on every read/write via `hospitalId`; cross-hospital access is
 * never allowed even for SUPER_ADMIN through these endpoints (super-admin
 * has its own audit-trail-backed surface).
 *
 * RBAC summary:
 *  - DIRECT thread (1-on-1): only the two participants can send/read.
 *  - GROUP thread:
 *      OWNER  → creator. Can rename / archive / add+remove non-auto members.
 *      ADMIN  → can add+remove non-auto members. Auto-included admin doctors
 *               always receive ADMIN role.
 *      MEMBER → read+write only. Can leave but not remove others.
 *  - System-level ADMIN / ADMIN_DOCTOR users have full management rights on
 *    any group in their hospital, including removing other admin doctors.
 *  - Auto-included admin doctors (`isAutoIncluded=true`) cannot be removed by
 *    OWNER/ADMIN of the group; only system ADMIN can.
 */

import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

const STAFF_ROLES = ['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN', 'DOCTOR', 'THERAPIST', 'PHARMACIST'];
const MANAGE_ROLES = ['ADMIN', 'ADMIN_DOCTOR'];

/**
 * Build the canonical sorted-pair key for DIRECT threads. Sort UUIDs lexically
 * so (a,b) and (b,a) collapse to the same row — DB unique index dedupes.
 */
function buildDirectKey(userIdA, userIdB) {
    const [low, high] = [userIdA, userIdB].sort();
    return `${low}:${high}`;
}

async function loadUserForChat(userId) {
    const u = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            id: true, email: true, role: true, hospitalId: true, branchId: true, deletedAt: true,
            doctor:     { select: { fullName: true, profilePhoto: true } },
            therapist:  { select: { fullName: true, profilePhoto: true } },
            pharmacist: { select: { fullName: true, profilePhoto: true } },
        },
    });
    if (!u) throw httpError(404, 'User not found');
    if (u.deletedAt) throw httpError(403, 'User account is disabled');
    if (u.role === 'PATIENT' || u.role === 'SUPER_ADMIN') {
        throw httpError(403, 'Staff messaging is restricted to clinical and admin staff');
    }
    return u;
}

function displayName(user) {
    return user?.doctor?.fullName || user?.therapist?.fullName || user?.pharmacist?.fullName || user?.email || 'Staff';
}

function httpError(status, message) {
    const err = new Error(message);
    err.statusCode = status;
    return err;
}

export class StaffChatService {
    /* ─── Listing ─────────────────────────────────────────────────────── */

    static async listThreadsForUser(userId) {
        const me = await loadUserForChat(userId);

        const memberships = await prisma.staffThreadMember.findMany({
            where: {
                userId: me.id,
                removedAt: null,
                thread: { hospitalId: me.hospitalId, archivedAt: null },
            },
            include: {
                thread: {
                    include: {
                        members: {
                            where: { removedAt: null },
                            include: {
                                user: {
                                    select: {
                                        id: true, email: true, role: true,
                                        doctor:     { select: { fullName: true, profilePhoto: true } },
                                        therapist:  { select: { fullName: true, profilePhoto: true } },
                                        pharmacist: { select: { fullName: true, profilePhoto: true } },
                                    },
                                },
                            },
                        },
                        messages: {
                            where: { deletedAt: null },
                            orderBy: { createdAt: 'desc' },
                            take: 1,
                            include: { sender: { select: { id: true } } },
                        },
                        branch: { select: { id: true, name: true } },
                    },
                },
            },
            orderBy: { thread: { updatedAt: 'desc' } },
        });

        // Per-thread unread count uses lastReadAt on the membership row.
        const threadIds = memberships.map((m) => m.thread.id);
        const unreadCounts = threadIds.length
            ? await prisma.$queryRaw`
                SELECT m."threadId" AS "threadId", COUNT(*)::int AS unread
                FROM "StaffMessage" m
                INNER JOIN "StaffThreadMember" mem
                  ON mem."threadId" = m."threadId" AND mem."userId" = ${me.id}::uuid
                WHERE m."threadId" = ANY(${threadIds}::uuid[])
                  AND m."deletedAt" IS NULL
                  AND m."senderId" IS DISTINCT FROM ${me.id}::uuid
                  AND (mem."lastReadAt" IS NULL OR m."createdAt" > mem."lastReadAt")
                GROUP BY m."threadId"
              `.catch((err) => { logger.warn('[StaffChat] unread count query failed', { err: err.message }); return []; })
            : [];

        const unreadMap = new Map(unreadCounts.map((r) => [r.threadId, r.unread]));

        return memberships.map((mem) => {
            const t = mem.thread;
            // For DMs, surface the partner's display name as the title.
            let title = t.title;
            let partner = null;
            if (t.kind === 'DIRECT') {
                const other = t.members.find((mm) => mm.userId !== me.id);
                partner = other?.user || null;
                title = partner ? displayName(partner) : 'Direct message';
            }
            return {
                id: t.id,
                kind: t.kind,
                title,
                hospitalId: t.hospitalId,
                branch: t.branch,
                createdById: t.createdById,
                myRole: mem.role,
                myIsAutoIncluded: mem.isAutoIncluded,
                memberCount: t.members.length,
                lastMessage: t.messages[0] || null,
                unreadCount: unreadMap.get(t.id) || 0,
                updatedAt: t.updatedAt,
                createdAt: t.createdAt,
                partner: partner ? {
                    id: partner.id,
                    name: displayName(partner),
                    role: partner.role,
                } : null,
            };
        });
    }

    /* ─── Direct message (1-on-1) get-or-create ───────────────────────── */

    static async getOrCreateDirectThread(currentUserId, partnerUserId) {
        if (currentUserId === partnerUserId) {
            throw httpError(400, "You can't open a DM with yourself");
        }
        const [me, partner] = await Promise.all([
            loadUserForChat(currentUserId),
            loadUserForChat(partnerUserId),
        ]);
        // Cross-hospital DMs blocked. Orphan staff (hospitalId === null) are
        // treated as belonging to the caller's hospital — mirrors the picker
        // behaviour in listAddressableStaff so anyone listed there can be DMed.
        const meHosp = me.hospitalId;
        const partnerHosp = partner.hospitalId;
        const sameOrOrphan =
            meHosp === partnerHosp ||
            (meHosp && partnerHosp === null) ||
            (partnerHosp && meHosp === null);
        if (!sameOrOrphan) {
            throw httpError(403, 'Cross-hospital DMs are not allowed');
        }

        const directKey = buildDirectKey(me.id, partner.id);

        // Upsert via the unique directKey to absorb concurrent first-DM races.
        const thread = await prisma.staffThread.upsert({
            where: { directKey },
            update: {},
            create: {
                kind: 'DIRECT',
                directKey,
                hospitalId: me.hospitalId,
                createdById: me.id,
                members: {
                    create: [
                        { userId: me.id,      role: 'MEMBER', addedById: me.id },
                        { userId: partner.id, role: 'MEMBER', addedById: me.id },
                    ],
                },
            },
            include: { members: true },
        });

        return { id: thread.id };
    }

    /* ─── Group create ────────────────────────────────────────────────── */

    static async createGroupThread(currentUserId, { title, branchId, memberUserIds = [] }) {
        const me = await loadUserForChat(currentUserId);
        const cleanTitle = (title || '').trim();
        if (cleanTitle.length < 2 || cleanTitle.length > 80) {
            throw httpError(400, 'Group name must be 2-80 characters');
        }

        // If branchId is provided, it must belong to the same hospital.
        if (branchId) {
            const branch = await prisma.branch.findFirst({
                where: { id: branchId, hospitalId: me.hospitalId },
                select: { id: true },
            });
            if (!branch) throw httpError(400, 'Invalid branch');
        }

        // Validate every nominated member: same hospital (or orphan), staff
        // role, not deleted. Drop self-id from input — we'll add the creator
        // as OWNER explicitly. Mirrors listAddressableStaff so anyone the
        // picker offered can actually be added.
        const requestedIds = Array.from(new Set(memberUserIds.filter((id) => id && id !== me.id)));
        const memberWhere = {
            id: { in: requestedIds },
            deletedAt: null,
            role: { in: STAFF_ROLES },
        };
        if (me.hospitalId) {
            memberWhere.OR = [
                { hospitalId: me.hospitalId },
                { hospitalId: null },
            ];
        }
        const requested = await prisma.user.findMany({
            where: memberWhere,
            select: { id: true, role: true },
        });
        if (requested.length !== requestedIds.length) {
            throw httpError(400, 'One or more members are invalid (wrong hospital, role, or deleted)');
        }

        // Auto-include all ACTIVE admin doctors in this hospital. If branchId
        // is set, prefer admin doctors whose branchId matches; fall back to
        // any admin doctor in the hospital so oversight always works.
        const adminDoctors = await prisma.user.findMany({
            where: {
                hospitalId: me.hospitalId,
                role: 'ADMIN_DOCTOR',
                deletedAt: null,
            },
            select: { id: true, branchId: true },
        });
        const autoIds = new Set(
            adminDoctors
                .filter((u) => !branchId || !u.branchId || u.branchId === branchId)
                .map((u) => u.id),
        );
        // Defensive — if branch filter excluded everyone, include ALL admin
        // doctors in the hospital so an oversight presence still exists.
        if (autoIds.size === 0 && adminDoctors.length > 0) {
            for (const a of adminDoctors) autoIds.add(a.id);
        }

        const memberCreates = [];
        const seen = new Set();
        // Creator first — OWNER role.
        memberCreates.push({
            userId: me.id,
            role: 'OWNER',
            addedById: me.id,
            isAutoIncluded: false,
        });
        seen.add(me.id);

        // Auto-included admin doctors next — ADMIN role with sticky flag.
        for (const aId of autoIds) {
            if (seen.has(aId)) continue;
            memberCreates.push({
                userId: aId,
                role: 'ADMIN',
                addedById: me.id,
                isAutoIncluded: true,
            });
            seen.add(aId);
        }
        // Requested members next.
        for (const m of requested) {
            if (seen.has(m.id)) continue;
            memberCreates.push({
                userId: m.id,
                role: 'MEMBER',
                addedById: me.id,
                isAutoIncluded: false,
            });
            seen.add(m.id);
        }

        const thread = await prisma.staffThread.create({
            data: {
                kind: 'GROUP',
                title: cleanTitle,
                hospitalId: me.hospitalId,
                branchId: branchId || null,
                createdById: me.id,
                members: { create: memberCreates },
                messages: {
                    create: [
                        {
                            kind: 'SYSTEM',
                            senderId: null,
                            content: `Group "${cleanTitle}" created by ${displayName(me)}`,
                        },
                    ],
                },
            },
            include: { members: true },
        });

        return { id: thread.id };
    }

    /* ─── Thread access guards ───────────────────────────────────────── */

    static async getMembership(threadId, userId, { allowSystemAdmin = false } = {}) {
        const me = await loadUserForChat(userId);
        const thread = await prisma.staffThread.findUnique({
            where: { id: threadId },
            include: {
                members: {
                    where: { userId: me.id },
                    take: 1,
                },
            },
        });
        if (!thread) throw httpError(404, 'Thread not found');
        if (thread.hospitalId !== me.hospitalId) throw httpError(403, 'Forbidden');

        const membership = thread.members[0] && !thread.members[0].removedAt ? thread.members[0] : null;
        if (membership) return { thread, membership, me, isSystemAdmin: false };

        // System admins/admin doctors can manage any group in their hospital
        // even without a membership row, but only when the caller explicitly
        // opted in to system-admin escalation (e.g. management routes).
        if (allowSystemAdmin && MANAGE_ROLES.includes(me.role) && thread.kind === 'GROUP') {
            return { thread, membership: null, me, isSystemAdmin: true };
        }
        throw httpError(403, 'You are not a member of this thread');
    }

    static canManageGroup({ thread, membership, me, isSystemAdmin }) {
        if (thread.kind !== 'GROUP') return false;
        if (isSystemAdmin) return true;
        if (MANAGE_ROLES.includes(me.role)) return true;
        if (!membership) return false;
        return membership.role === 'OWNER' || membership.role === 'ADMIN';
    }

    /* ─── Detail + members ───────────────────────────────────────────── */

    static async getThreadDetail(threadId, userId) {
        const ctx = await this.getMembership(threadId, userId, { allowSystemAdmin: true });
        const { thread, me } = ctx;

        const members = await prisma.staffThreadMember.findMany({
            where: { threadId, removedAt: null },
            include: {
                user: {
                    select: {
                        id: true, email: true, role: true,
                        doctor:     { select: { fullName: true, profilePhoto: true } },
                        therapist:  { select: { fullName: true, profilePhoto: true } },
                        pharmacist: { select: { fullName: true, profilePhoto: true } },
                        branch:     { select: { id: true, name: true } },
                    },
                },
                addedBy: { select: { id: true, email: true } },
            },
            orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
        });

        const branch = thread.branchId
            ? await prisma.branch.findUnique({
                where: { id: thread.branchId },
                select: { id: true, name: true },
            })
            : null;

        return {
            id: thread.id,
            kind: thread.kind,
            title: thread.title,
            branch,
            createdById: thread.createdById,
            archivedAt: thread.archivedAt,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
            myRole: ctx.membership?.role || null,
            isSystemAdminView: ctx.isSystemAdmin,
            canManage: this.canManageGroup(ctx),
            members: members.map((m) => ({
                id: m.id,
                userId: m.userId,
                name: displayName(m.user),
                email: m.user.email,
                role: m.user.role,
                threadRole: m.role,
                isAutoIncluded: m.isAutoIncluded,
                joinedAt: m.joinedAt,
                addedBy: m.addedBy ? { id: m.addedBy.id, email: m.addedBy.email } : null,
                isSelf: m.userId === me.id,
                branch: m.user.branch || null,
            })),
        };
    }

    /* ─── Messages ───────────────────────────────────────────────────── */

    static async listMessages(threadId, userId, { cursor, limit = 50 } = {}) {
        await this.getMembership(threadId, userId, { allowSystemAdmin: true });
        const take = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);

        const where = { threadId };
        if (cursor) where.createdAt = { lt: new Date(cursor) };

        const rows = await prisma.staffMessage.findMany({
            where,
            include: {
                sender: {
                    select: {
                        id: true, role: true,
                        doctor:     { select: { fullName: true, profilePhoto: true } },
                        therapist:  { select: { fullName: true, profilePhoto: true } },
                        pharmacist: { select: { fullName: true, profilePhoto: true } },
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
            take: take + 1,
        });

        const hasMore = rows.length > take;
        if (hasMore) rows.pop();
        rows.reverse();
        return {
            messages: rows.map((m) => ({
                id: m.id,
                threadId: m.threadId,
                senderId: m.senderId,
                senderName: m.sender ? displayName(m.sender) : null,
                senderRole: m.sender?.role || null,
                kind: m.kind,
                content: m.deletedAt ? '' : m.content,
                deletedAt: m.deletedAt,
                editedAt: m.editedAt,
                createdAt: m.createdAt,
            })),
            hasMore,
            nextCursor: hasMore && rows.length > 0 ? rows[0].createdAt.toISOString() : null,
        };
    }

    static async sendMessage(threadId, senderId, content) {
        const ctx = await this.getMembership(threadId, senderId);
        const { thread, membership } = ctx;
        if (thread.archivedAt) throw httpError(409, 'This thread is archived');
        if (!membership) throw httpError(403, 'Only thread members can send messages');

        const clean = (content || '').toString().trim().replace(/<[^>]*>/g, '');
        if (clean.length === 0) throw httpError(400, 'Message cannot be empty');
        if (clean.length > 5000) throw httpError(400, 'Message exceeds 5000 character limit');

        const [message] = await prisma.$transaction([
            prisma.staffMessage.create({
                data: {
                    threadId,
                    senderId,
                    kind: 'TEXT',
                    content: clean,
                },
                include: {
                    sender: {
                        select: {
                            id: true, role: true,
                            doctor:     { select: { fullName: true, profilePhoto: true } },
                            therapist:  { select: { fullName: true, profilePhoto: true } },
                            pharmacist: { select: { fullName: true, profilePhoto: true } },
                        },
                    },
                },
            }),
            prisma.staffThread.update({
                where: { id: threadId },
                data: { updatedAt: new Date() },
            }),
            prisma.staffThreadMember.update({
                where: { threadId_userId: { threadId, userId: senderId } },
                data: { lastReadAt: new Date() },
            }),
        ]);

        return {
            id: message.id,
            threadId: message.threadId,
            senderId: message.senderId,
            senderName: message.sender ? displayName(message.sender) : null,
            senderRole: message.sender?.role || null,
            kind: message.kind,
            content: message.content,
            createdAt: message.createdAt,
        };
    }

    static async markRead(threadId, userId) {
        const ctx = await this.getMembership(threadId, userId);
        if (!ctx.membership) return; // system-admin view doesn't have a member row
        await prisma.staffThreadMember.update({
            where: { threadId_userId: { threadId, userId } },
            data: { lastReadAt: new Date() },
        });
    }

    /* ─── Membership management ──────────────────────────────────────── */

    static async addMember(threadId, actorUserId, addUserId) {
        const ctx = await this.getMembership(threadId, actorUserId, { allowSystemAdmin: true });
        const { thread, me } = ctx;
        if (!this.canManageGroup(ctx)) throw httpError(403, 'You are not allowed to manage this group');
        if (thread.kind !== 'GROUP') throw httpError(400, 'Cannot add members to a direct thread');

        const newUser = await loadUserForChat(addUserId);
        if (newUser.hospitalId !== me.hospitalId) throw httpError(403, 'Cross-hospital members are not allowed');

        // If they were previously removed, restore the row instead of creating a duplicate.
        const existing = await prisma.staffThreadMember.findUnique({
            where: { threadId_userId: { threadId, userId: addUserId } },
        });

        const member = existing
            ? await prisma.staffThreadMember.update({
                where: { id: existing.id },
                data: {
                    removedAt: null,
                    role: existing.isAutoIncluded ? 'ADMIN' : 'MEMBER',
                    addedById: actorUserId,
                    joinedAt: new Date(),
                },
            })
            : await prisma.staffThreadMember.create({
                data: {
                    threadId,
                    userId: addUserId,
                    role: 'MEMBER',
                    addedById: actorUserId,
                },
            });

        await prisma.staffMessage.create({
            data: {
                threadId,
                senderId: null,
                kind: 'SYSTEM',
                content: `${displayName(newUser)} was added by ${displayName(me)}`,
            },
        });
        await prisma.staffThread.update({ where: { id: threadId }, data: { updatedAt: new Date() } });

        return { id: member.id, userId: member.userId, role: member.role };
    }

    static async removeMember(threadId, actorUserId, removeUserId) {
        const ctx = await this.getMembership(threadId, actorUserId, { allowSystemAdmin: true });
        const { thread, me, isSystemAdmin } = ctx;
        if (thread.kind !== 'GROUP') throw httpError(400, 'Cannot remove members from a direct thread');

        const target = await prisma.staffThreadMember.findUnique({
            where: { threadId_userId: { threadId, userId: removeUserId } },
            include: { user: { select: { id: true, email: true, role: true,
                doctor: { select: { fullName: true } },
                therapist: { select: { fullName: true } },
                pharmacist: { select: { fullName: true } } } } },
        });
        if (!target || target.removedAt) throw httpError(404, 'Member not in this group');

        // Self-leave is always allowed except for auto-included admin doctors
        // (their oversight presence is by design). System admin can still remove them.
        const isSelf = removeUserId === actorUserId;
        if (target.isAutoIncluded && !isSystemAdmin && me.role !== 'ADMIN') {
            throw httpError(403, 'Auto-included admin doctors can only be removed by a system admin');
        }
        // Non-self removal needs management rights.
        if (!isSelf && !this.canManageGroup(ctx)) {
            throw httpError(403, 'You are not allowed to remove members from this group');
        }
        // OWNER cannot be removed; they must transfer or archive the thread.
        if (target.role === 'OWNER' && !isSystemAdmin) {
            throw httpError(409, 'The group owner cannot be removed; transfer ownership or archive the group');
        }

        await prisma.staffThreadMember.update({
            where: { id: target.id },
            data: { removedAt: new Date() },
        });
        await prisma.staffMessage.create({
            data: {
                threadId,
                senderId: null,
                kind: 'SYSTEM',
                content: isSelf
                    ? `${displayName(target.user)} left the group`
                    : `${displayName(target.user)} was removed by ${displayName(me)}`,
            },
        });
        await prisma.staffThread.update({ where: { id: threadId }, data: { updatedAt: new Date() } });

        return { ok: true };
    }

    static async archiveThread(threadId, actorUserId) {
        const ctx = await this.getMembership(threadId, actorUserId, { allowSystemAdmin: true });
        if (!this.canManageGroup(ctx)) throw httpError(403, 'You are not allowed to archive this group');
        if (ctx.thread.kind !== 'GROUP') throw httpError(400, 'Only groups can be archived');
        await prisma.staffThread.update({
            where: { id: threadId },
            data: { archivedAt: new Date() },
        });
        return { ok: true };
    }

    /* ─── Directory: who can I message / add ─────────────────────────── */

    static async listAddressableStaff(currentUserId, { branchId, search } = {}) {
        const me = await loadUserForChat(currentUserId);
        const where = {
            deletedAt: null,
            role: { in: STAFF_ROLES },
            id: { not: me.id },
        };
        // Tenancy isolation: when the caller has a hospital, scope to it AND
        // include orphan staff (hospitalId IS NULL) so legacy / pre-binding
        // accounts don't disappear from the picker. When the caller is itself
        // unbound (single-hospital deployment / legacy admin), drop the filter
        // entirely so the full staff directory is reachable.
        if (me.hospitalId) {
            where.OR = [
                { hospitalId: me.hospitalId },
                { hospitalId: null },
            ];
        }
        if (branchId) where.branchId = branchId;
        if (search) {
            const s = String(search).toLowerCase();
            const searchOr = [
                { email: { contains: s, mode: 'insensitive' } },
                { doctor:     { fullName: { contains: s, mode: 'insensitive' } } },
                { therapist:  { fullName: { contains: s, mode: 'insensitive' } } },
                { pharmacist: { fullName: { contains: s, mode: 'insensitive' } } },
            ];
            // Compose with the hospital OR via AND so we don't clobber it.
            if (where.OR) {
                where.AND = [{ OR: where.OR }, { OR: searchOr }];
                delete where.OR;
            } else {
                where.OR = searchOr;
            }
        }
        const rows = await prisma.user.findMany({
            where,
            select: {
                id: true, email: true, role: true,
                doctor:     { select: { fullName: true, profilePhoto: true } },
                therapist:  { select: { fullName: true, profilePhoto: true } },
                pharmacist: { select: { fullName: true, profilePhoto: true } },
                branch:     { select: { id: true, name: true } },
            },
            // Cap raised from 200 → 1000. The picker is a flat list with
            // client-side filtering; 200 was silently truncating large clinics
            // sorted late in the role/email order ("not all staffs fetched").
            take: 1000,
            orderBy: [{ role: 'asc' }, { email: 'asc' }],
        });
        return rows.map((u) => ({
            id: u.id,
            name: displayName(u),
            role: u.role,
            email: u.email,
            branch: u.branch || null,
        }));
    }

    /**
     * Recipients to notify on a new message. Excludes the sender + soft-removed
     * members + the SUPER_ADMIN bypass user (defensive — they shouldn't exist
     * in member tables anyway).
     */
    static async getNotifiableMemberIds(threadId, excludeUserId) {
        const rows = await prisma.staffThreadMember.findMany({
            where: { threadId, removedAt: null, userId: { not: excludeUserId } },
            select: { userId: true },
        });
        return rows.map((r) => r.userId);
    }
}
