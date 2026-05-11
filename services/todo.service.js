/**
 * TodoService — cross-role task management layer.
 *
 * See IWIS_Dashboard_Refactor_Spec.md §2 and §7.
 *
 * Roles:
 *   ADMIN, ADMIN_DOCTOR  → can create self-assigned + assign to others
 *   DOCTOR, THERAPIST    → can create self-assigned only
 *
 * Anti-gaming rules (spec §7.2):
 *   - Self-created todos cap at 25 XP regardless of priority
 *   - 500 XP/day/user cap from TODO_COMPLETION
 *   - Assigned todos can be 10..200 XP (override)
 *   - A todo must be open for ≥5 minutes before it can be completed
 *   - >20 completions in a single day triggers a GamificationAnomaly for Admin Doctor review
 */

import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { ClinicianXPService } from './clinicianXP.service.js';
import { notificationService } from './notification.service.js';
import { emitToUser } from '../websocket/index.js';

const DEFAULT_XP_BY_PRIORITY = {
    LOW: 10,
    MEDIUM: 25,
    HIGH: 50,
    URGENT: 100,
};

const MIN_OPEN_MS = 5 * 60 * 1000; // 5 minutes
const MAX_XP_PER_ASSIGNED = 200;
const MIN_XP_PER_ASSIGNED = 10;
const SELF_CREATED_CAP = 25;
const DAILY_TODO_XP_CAP = 500;
const DAILY_COMPLETION_ANOMALY_THRESHOLD = 20;

const ASSIGNER_ROLES = new Set(['ADMIN', 'ADMIN_DOCTOR']);

function httpErr(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
}

export class TodoService {
    /* ──────────────────────────────────────────────────────────────────── *
     *  CREATION
     * ──────────────────────────────────────────────────────────────────── */

    /**
     * Self-assigned todo (any authenticated role).
     */
    static async createSelf(actor, input) {
        const priority = input.priority || 'MEDIUM';
        // Self-created todos do NOT earn XP — only assigner-set rewards count
        // (per user policy override of spec §7.2).
        const xpReward = 0;

        const branchId = actor.branchId;
        if (!branchId) {
            throw httpErr(400, 'No branch associated with user — cannot create todo');
        }

        if (input.relatedPatientId) {
            await this._assertPatientAccessible(input.relatedPatientId, branchId);
        }

        const todo = await prisma.todo.create({
            data: {
                title: this._sanitizeTitle(input.title),
                description: input.description?.trim() || null,
                priority,
                status: 'PENDING',
                dueDate: input.dueDate ? new Date(input.dueDate) : null,
                xpReward,
                createdById: actor.id,
                assignedToId: actor.id,
                relatedPatientId: input.relatedPatientId || null,
                relatedAppointmentId: input.relatedAppointmentId || null,
                branchId,
            },
            include: this._includeBasics(),
        });

        logger.info(`[Todo] Self-created ${todo.id} (${priority}, ${xpReward} XP) by ${actor.id}`);
        return todo;
    }

    /**
     * Assign a todo to another user. ADMIN / ADMIN_DOCTOR only.
     */
    static async assign(actor, input) {
        if (!ASSIGNER_ROLES.has(actor.role)) {
            throw httpErr(403, 'Only ADMIN or ADMIN_DOCTOR can assign todos');
        }
        if (!input.assignedToId) {
            throw httpErr(400, 'assignedToId is required');
        }

        const assignee = await prisma.user.findUnique({
            where: { id: input.assignedToId },
            select: { id: true, branchId: true, role: true, deletedAt: true },
        });
        if (!assignee || assignee.deletedAt) {
            throw httpErr(404, 'Assignee not found');
        }

        // ADMIN_DOCTOR has cross-branch assignment privileges — no branch restriction.

        const priority = input.priority || 'MEDIUM';
        const defaultXP = DEFAULT_XP_BY_PRIORITY[priority] ?? 25;
        const xpOverride = Number.isFinite(Number(input.xpReward)) ? Number(input.xpReward) : defaultXP;
        const xpReward = Math.max(MIN_XP_PER_ASSIGNED, Math.min(MAX_XP_PER_ASSIGNED, xpOverride));

        const branchId = assignee.branchId || actor.branchId;
        if (!branchId) throw httpErr(400, 'No branch to scope todo to');

        // ADMIN_DOCTOR / ADMIN can link any patient across branches.
        if (input.relatedPatientId) {
            const patient = await prisma.patient.findUnique({
                where: { id: input.relatedPatientId },
                select: { id: true },
            });
            if (!patient) throw httpErr(404, 'Related patient not found');
        }

        const todo = await prisma.todo.create({
            data: {
                title: this._sanitizeTitle(input.title),
                description: input.description?.trim() || null,
                priority,
                status: 'PENDING',
                dueDate: input.dueDate ? new Date(input.dueDate) : null,
                xpReward,
                createdById: actor.id,
                assignedToId: assignee.id,
                relatedPatientId: input.relatedPatientId || null,
                relatedAppointmentId: input.relatedAppointmentId || null,
                branchId,
            },
            include: this._includeBasics(),
        });

        // In-app notification for the assignee
        const creatorName = await this._userDisplayName(actor.id);
        await notificationService.createNotification({
            userId: assignee.id,
            type: 'TODO_ASSIGNED',
            title: `New task assigned: ${todo.title}`,
            message: `Assigned by ${creatorName}${todo.dueDate ? ` — due ${new Date(todo.dueDate).toLocaleString()}` : ''}`,
            priority: priority === 'URGENT' ? 'HIGH' : 'INFO',
            data: { todoId: todo.id, priority },
        });

        // URGENT priority used to trigger an SMS via Twilio. SMS support has
        // been removed — URGENT now relies on the in-app notification above
        // plus the WhatsApp / IN_APP fan-out done by DeliveryService for
        // higher-priority kinds. If a louder channel is needed in future,
        // route through DeliveryService rather than reintroducing a direct
        // provider client here.

        logger.info(`[Todo] ${actor.id} assigned ${todo.id} to ${assignee.id} (${priority}, ${xpReward} XP)`);
        return todo;
    }

    /* ──────────────────────────────────────────────────────────────────── *
     *  LIST
     * ──────────────────────────────────────────────────────────────────── */

    /**
     * Todos assigned to the current user (inbox view).
     * Filters: status, priority, tab=assigned|self|done
     */
    static async listForAssignee(userId, { status, priority, tab, page = 1, limit = 50 } = {}) {
        const where = { assignedToId: userId };
        if (status) where.status = status;
        if (priority) where.priority = priority;

        if (tab === 'assigned') {
            where.createdById = { not: userId };
            if (!status) where.status = { in: ['PENDING', 'IN_PROGRESS'] };
        } else if (tab === 'self') {
            where.createdById = userId;
            if (!status) where.status = { in: ['PENDING', 'IN_PROGRESS'] };
        } else if (tab === 'done') {
            where.status = 'COMPLETED';
        } else if (!status) {
            where.status = { in: ['PENDING', 'IN_PROGRESS'] };
        }

        const skip = (Math.max(1, page) - 1) * limit;
        const [items, total] = await Promise.all([
            prisma.todo.findMany({
                where,
                include: this._includeBasics(),
                orderBy: [
                    { status: 'asc' },
                    { priority: 'desc' },
                    { dueDate: 'asc' },
                    { createdAt: 'desc' },
                ],
                skip,
                take: limit,
            }),
            prisma.todo.count({ where }),
        ]);

        const now = Date.now();
        const summary = await this._summarizeInbox(userId);

        return {
            items: items.map(t => this._serialize(t, now)),
            total,
            summary,
        };
    }

    /**
     * Todos created by the current user and assigned to others
     * (management view for ADMIN / ADMIN_DOCTOR).
     */
    static async listAssignedByMe(actor, { status, page = 1, limit = 50 } = {}) {
        if (!ASSIGNER_ROLES.has(actor.role)) {
            throw httpErr(403, 'Only ADMIN or ADMIN_DOCTOR can view assigned tasks');
        }
        const where = { createdById: actor.id, assignedToId: { not: actor.id } };
        if (status) where.status = status;

        const skip = (Math.max(1, page) - 1) * limit;
        const [items, total] = await Promise.all([
            prisma.todo.findMany({
                where,
                include: this._includeBasics(),
                orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { createdAt: 'desc' }],
                skip,
                take: limit,
            }),
            prisma.todo.count({ where }),
        ]);

        const now = Date.now();
        const summary = {
            total,
            completed: await prisma.todo.count({ where: { ...where, status: 'COMPLETED' } }),
            pending: await prisma.todo.count({ where: { ...where, status: 'PENDING' } }),
            inProgress: await prisma.todo.count({ where: { ...where, status: 'IN_PROGRESS' } }),
            overdue: await prisma.todo.count({
                where: {
                    ...where,
                    status: { in: ['PENDING', 'IN_PROGRESS'] },
                    dueDate: { lt: new Date() },
                },
            }),
        };

        return { items: items.map(t => this._serialize(t, now)), total, summary };
    }

    /* ──────────────────────────────────────────────────────────────────── *
     *  UPDATE / STATUS
     * ──────────────────────────────────────────────────────────────────── */

    /**
     * Change status. Only the assignee can do this.
     * PENDING → IN_PROGRESS, IN_PROGRESS → COMPLETED, → DISMISSED (pending only).
     */
    static async updateStatus(actor, todoId, nextStatus) {
        const allowed = new Set(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'DISMISSED']);
        if (!allowed.has(nextStatus)) throw httpErr(400, 'Invalid status');

        const todo = await prisma.todo.findUnique({ where: { id: todoId }, include: this._includeBasics() });
        if (!todo) throw httpErr(404, 'Todo not found');
        if (todo.assignedToId !== actor.id) {
            throw httpErr(403, 'Only the assignee can update this todo');
        }
        if (todo.status === 'COMPLETED' || todo.status === 'DISMISSED') {
            throw httpErr(400, `Todo is ${todo.status.toLowerCase()} and cannot change status`);
        }

        // Assignee cannot DISMISS an externally-assigned todo — only the assigner.
        if (nextStatus === 'DISMISSED' && todo.createdById !== actor.id) {
            throw httpErr(403, 'Assigned todos can only be completed or escalated, not dismissed');
        }

        // 5-minute open rule guards self-created XP farming only. Externally-assigned
        // todos can be completed immediately — the assigner controls timing there.
        if (nextStatus === 'COMPLETED' && todo.createdById === actor.id) {
            const openMs = Date.now() - new Date(todo.createdAt).getTime();
            if (openMs < MIN_OPEN_MS) {
                throw httpErr(400, 'Self-created todos must be open for at least 5 minutes before completion');
            }
        }

        const data = { status: nextStatus, updatedAt: new Date() };
        if (nextStatus === 'COMPLETED') data.completedAt = new Date();
        if (nextStatus === 'DISMISSED') data.dismissedAt = new Date();

        const updated = await prisma.todo.update({
            where: { id: todoId },
            data,
            include: this._includeBasics(),
        });

        // XP + badge + anomaly pipeline on completion
        if (nextStatus === 'COMPLETED') {
            await this._awardCompletionXP(actor, updated);
        }

        // Real-time push to assignee (UI refresh)
        emitToUser(actor.id, 'todo:updated', { todoId: updated.id, status: nextStatus });

        // If the creator is someone else, let them know a completion happened.
        if (nextStatus === 'COMPLETED' && updated.createdById !== actor.id) {
            emitToUser(updated.createdById, 'todo:completed_by_assignee', {
                todoId: updated.id,
                title: updated.title,
            });
        }

        return this._serialize(updated);
    }

    /**
     * Edit fields of a todo. Only the assigner (creator) may edit, and only
     * while it's still PENDING or IN_PROGRESS.
     */
    static async edit(actor, todoId, patch) {
        const todo = await prisma.todo.findUnique({ where: { id: todoId } });
        if (!todo) throw httpErr(404, 'Todo not found');
        if (todo.createdById !== actor.id) throw httpErr(403, 'Only the creator can edit this todo');
        if (todo.status === 'COMPLETED' || todo.status === 'DISMISSED') {
            throw httpErr(400, 'Cannot edit a finished todo');
        }

        const data = {};
        if (patch.title !== undefined) data.title = this._sanitizeTitle(patch.title);
        if (patch.description !== undefined) data.description = patch.description?.trim() || null;
        if (patch.priority !== undefined) data.priority = patch.priority;
        if (patch.dueDate !== undefined) data.dueDate = patch.dueDate ? new Date(patch.dueDate) : null;

        if (patch.xpReward !== undefined) {
            if (todo.createdById === todo.assignedToId) {
                // Self-created todos are always 0 XP — ignore override attempts.
                data.xpReward = 0;
            } else if (ASSIGNER_ROLES.has(actor.role)) {
                const n = Number(patch.xpReward);
                if (Number.isFinite(n)) {
                    data.xpReward = Math.max(MIN_XP_PER_ASSIGNED, Math.min(MAX_XP_PER_ASSIGNED, n));
                }
            }
        }

        const updated = await prisma.todo.update({
            where: { id: todoId },
            data,
            include: this._includeBasics(),
        });
        return this._serialize(updated);
    }

    /**
     * Permanently delete an assigned todo. The creator may delete their own
     * todo at any status, and ADMIN_DOCTOR (oversight role) may delete any
     * todo regardless of creator. Used by both:
     *   - Revoke button (PENDING tasks the creator wants to take back)
     *   - Hover trash on the "Tasks I've Assigned" panel (any status)
     */
    static async revoke(actor, todoId) {
        const todo = await prisma.todo.findUnique({ where: { id: todoId } });
        if (!todo) throw httpErr(404, 'Todo not found');
        const isCreator = todo.createdById === actor.id;
        const isAdminDoctor = actor.role === 'ADMIN_DOCTOR';
        if (!isCreator && !isAdminDoctor) {
            throw httpErr(403, 'Only the creator or an admin doctor can delete this task');
        }

        await prisma.todo.delete({ where: { id: todoId } });
        logger.info(`[Todo] ${actor.id} deleted ${todoId} (status=${todo.status})`);
        return { ok: true };
    }

    /**
     * Send a nudge reminder to the assignee. Only the creator can nudge.
     */
    static async remind(actor, todoId) {
        const todo = await prisma.todo.findUnique({ where: { id: todoId } });
        if (!todo) throw httpErr(404, 'Todo not found');
        if (todo.createdById !== actor.id) throw httpErr(403, 'Only the creator can send reminders');
        if (todo.status === 'COMPLETED' || todo.status === 'DISMISSED') {
            throw httpErr(400, 'Todo is finished — nothing to remind');
        }

        const creatorName = await this._userDisplayName(actor.id);
        await notificationService.createNotification({
            userId: todo.assignedToId,
            type: 'TODO_REMINDER',
            title: `Reminder: ${todo.title}`,
            message: `${creatorName} is following up on this task${todo.dueDate ? ` (due ${new Date(todo.dueDate).toLocaleDateString()})` : ''}`,
            priority: todo.priority === 'URGENT' ? 'HIGH' : 'INFO',
            data: { todoId: todo.id },
        });
        await prisma.todo.update({ where: { id: todoId }, data: { reminderSentAt: new Date() } });
        return { ok: true };
    }

    /* ──────────────────────────────────────────────────────────────────── *
     *  CROSS-DASHBOARD HELPERS
     * ──────────────────────────────────────────────────────────────────── */

    /**
     * Summary for a user's Todo panel footer (3 pending · 1 completed today · +175 XP)
     */
    static async _summarizeInbox(userId) {
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        const [pending, completedToday, xpToday, overdue] = await Promise.all([
            prisma.todo.count({
                where: { assignedToId: userId, status: { in: ['PENDING', 'IN_PROGRESS'] } },
            }),
            prisma.todo.count({
                where: { assignedToId: userId, status: 'COMPLETED', completedAt: { gte: startOfToday } },
            }),
            prisma.todo.aggregate({
                where: { assignedToId: userId, status: 'COMPLETED', completedAt: { gte: startOfToday } },
                _sum: { xpReward: true },
            }),
            prisma.todo.count({
                where: {
                    assignedToId: userId,
                    status: { in: ['PENDING', 'IN_PROGRESS'] },
                    dueDate: { lt: new Date() },
                },
            }),
        ]);

        return {
            pending,
            completedToday,
            xpToday: xpToday._sum.xpReward || 0,
            overdue,
        };
    }

    /**
     * Recent overdue reminder batch — used by the scheduled job.
     * For each todo where dueDate < now + 60min and not yet reminded and not finished,
     * push a reminder notification to the assignee.
     */
    static async runOverdueReminderSweep() {
        const now = new Date();
        const oneHourOut = new Date(now.getTime() + 60 * 60 * 1000);
        const candidates = await prisma.todo.findMany({
            where: {
                status: { in: ['PENDING', 'IN_PROGRESS'] },
                dueDate: { lte: oneHourOut, gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
                reminderSentAt: null,
            },
            take: 200,
            include: { assignedTo: { select: { id: true } } },
        });

        let sent = 0;
        for (const t of candidates) {
            try {
                await notificationService.createNotification({
                    userId: t.assignedToId,
                    type: 'TODO_DUE_SOON',
                    title: `Task due soon: ${t.title}`,
                    message: `Due ${new Date(t.dueDate).toLocaleString()} — ${t.priority} priority`,
                    priority: t.priority === 'URGENT' ? 'HIGH' : 'INFO',
                    data: { todoId: t.id },
                });
                await prisma.todo.update({ where: { id: t.id }, data: { reminderSentAt: now } });
                sent += 1;
            } catch (err) {
                logger.warn(`[Todo] reminder sweep failed for ${t.id}: ${err.message}`);
            }
        }
        logger.info(`[Todo] overdue reminder sweep: ${sent} notifications sent (candidates=${candidates.length})`);
        return { sent, candidates: candidates.length };
    }

    /* ──────────────────────────────────────────────────────────────────── *
     *  INTERNAL
     * ──────────────────────────────────────────────────────────────────── */

    static async _awardCompletionXP(actor, todo) {
        // Self-created todos never earn XP — only assigner-rewarded tasks do.
        if (todo.createdById === todo.assignedToId) {
            emitToUser(actor.id, 'todo:completed', {
                todoId: todo.id,
                title: todo.title,
                xpAwarded: 0,
                cappedAtDaily: false,
                selfCreated: true,
            });
            // Still run badge check (streak / starter badges don't require XP).
            try { await this._checkTodoBadges(actor.id); } catch {}
            return;
        }

        let xp = Math.max(MIN_XP_PER_ASSIGNED, Math.min(MAX_XP_PER_ASSIGNED, todo.xpReward));

        // Daily cap check
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const earnedToday = await prisma.xPLedger.aggregate({
            where: { userId: actor.id, action: 'TODO_COMPLETION', createdAt: { gte: startOfToday } },
            _sum: { xpAmount: true },
        });
        const already = earnedToday._sum.xpAmount || 0;
        const room = Math.max(0, DAILY_TODO_XP_CAP - already);
        const awarded = Math.min(xp, room);

        if (awarded > 0) {
            try {
                await ClinicianXPService.awardXP(actor.id, 'TODO_COMPLETION', awarded, todo.id, {
                    todoTitle: todo.title,
                    priority: todo.priority,
                    assignedBy: todo.createdById === actor.id ? null : todo.createdById,
                });
            } catch (err) {
                // ClinicianXP is clinician-only; patients / admins without profile are acceptable.
                logger.warn(`[Todo] XP award skipped for ${actor.id}: ${err.message}`);
            }
        }

        // Anomaly detection: > N completions today
        const todayCompletions = await prisma.todo.count({
            where: {
                assignedToId: actor.id,
                status: 'COMPLETED',
                completedAt: { gte: startOfToday },
            },
        });
        if (todayCompletions >= DAILY_COMPLETION_ANOMALY_THRESHOLD) {
            try {
                await prisma.gamificationAnomaly.create({
                    data: {
                        participantId: actor.id,
                        participantRole: actor.role || 'DOCTOR',
                        anomalyType: 'TODO_SPAM',
                        details: {
                            completionsToday: todayCompletions,
                            threshold: DAILY_COMPLETION_ANOMALY_THRESHOLD,
                            lastTodoId: todo.id,
                        },
                    },
                });
            } catch (err) {
                // GamificationAnomaly may not exist for all envs — log and move on.
                logger.warn(`[Todo] Anomaly record skipped: ${err.message}`);
            }
        }

        // Badge hooks
        try {
            await this._checkTodoBadges(actor.id);
        } catch (err) {
            logger.warn(`[Todo] Badge check failed: ${err.message}`);
        }

        // Pop-up event
        emitToUser(actor.id, 'todo:completed', {
            todoId: todo.id,
            title: todo.title,
            xpAwarded: awarded,
            cappedAtDaily: xp > awarded,
        });
    }

    static async _checkTodoBadges(userId) {
        const [existingAwards, badgeDefs, completedTotal, completedByOthers, selfCount] = await Promise.all([
            prisma.userBadge.findMany({ where: { userId }, select: { badgeId: true } }),
            prisma.badge.findMany({
                where: {
                    isActive: true,
                    code: {
                        in: ['TASK_STARTER', 'TASK_CONSISTENT_7', 'TASK_CONSISTENT_30',
                             'TASK_MASTER_50', 'TASK_MASTER_200', 'DELEGATION_PRO'],
                    },
                },
            }),
            prisma.todo.count({ where: { assignedToId: userId, status: 'COMPLETED' } }),
            prisma.todo.count({
                where: { assignedToId: userId, status: 'COMPLETED', createdById: { not: userId } },
            }),
            prisma.todo.count({
                where: { createdById: userId, assignedToId: { not: userId } },
            }),
        ]);

        const owned = new Set(existingAwards.map(a => a.badgeId));
        const checkStreak = async (days) => {
            // A todo-per-day streak check.
            const from = new Date();
            from.setDate(from.getDate() - days);
            const rows = await prisma.todo.findMany({
                where: { assignedToId: userId, status: 'COMPLETED', completedAt: { gte: from } },
                select: { completedAt: true },
            });
            const activeDays = new Set(rows.map(r => new Date(r.completedAt).toISOString().slice(0, 10)));
            return activeDays.size >= days;
        };

        for (const b of badgeDefs) {
            if (owned.has(b.id)) continue;
            let meets = false;
            if (b.code === 'TASK_STARTER') meets = completedTotal >= 1;
            else if (b.code === 'TASK_CONSISTENT_7') meets = await checkStreak(7);
            else if (b.code === 'TASK_CONSISTENT_30') meets = await checkStreak(30);
            else if (b.code === 'TASK_MASTER_50') meets = completedByOthers >= 50;
            else if (b.code === 'TASK_MASTER_200') meets = completedByOthers >= 200;
            else if (b.code === 'DELEGATION_PRO') meets = selfCount >= 50;

            if (meets) {
                try {
                    await prisma.userBadge.create({ data: { userId, badgeId: b.id } });
                    emitToUser(userId, 'badge_earned', {
                        badge: { code: b.code, name: b.name, icon: b.icon, tier: b.tier },
                        message: `You earned the "${b.name}" badge!`,
                    });
                } catch (err) {
                    if (!err.code?.includes('P2002')) {
                        logger.warn(`[Todo] Badge ${b.code} award failed: ${err.message}`);
                    }
                }
            }
        }
    }

    static async _assertPatientAccessible(patientId, branchId) {
        const p = await prisma.patient.findUnique({
            where: { id: patientId },
            select: { branchId: true },
        });
        if (!p) throw httpErr(404, 'Related patient not found');
        if (p.branchId && branchId && p.branchId !== branchId) {
            throw httpErr(403, 'Related patient is in a different branch');
        }
    }

    static _sanitizeTitle(title) {
        const s = (title || '').trim();
        if (!s) throw httpErr(400, 'Title is required');
        return s.slice(0, 120);
    }

    static _includeBasics() {
        return {
            createdBy: {
                select: {
                    id: true, email: true, role: true,
                    doctor: { select: { fullName: true } },
                    therapist: { select: { fullName: true } },
                },
            },
            assignedTo: {
                select: {
                    id: true, email: true, role: true,
                    doctor: { select: { fullName: true } },
                    therapist: { select: { fullName: true } },
                },
            },
            relatedPatient: { select: { id: true, fullName: true, patientId: true } },
            relatedAppointment: { select: { id: true, date: true } },
        };
    }

    static _serialize(t, now = Date.now()) {
        const overdue = !!(t.dueDate && new Date(t.dueDate).getTime() < now &&
            t.status !== 'COMPLETED' && t.status !== 'DISMISSED');
        return {
            id: t.id,
            title: t.title,
            description: t.description,
            priority: t.priority,
            status: t.status,
            dueDate: t.dueDate,
            xpReward: t.xpReward,
            completedAt: t.completedAt,
            createdAt: t.createdAt,
            createdBy: t.createdBy ? {
                id: t.createdBy.id,
                name: t.createdBy.doctor?.fullName || t.createdBy.therapist?.fullName || t.createdBy.email,
                role: t.createdBy.role,
            } : null,
            assignedTo: t.assignedTo ? {
                id: t.assignedTo.id,
                name: t.assignedTo.doctor?.fullName || t.assignedTo.therapist?.fullName || t.assignedTo.email,
                role: t.assignedTo.role,
            } : null,
            relatedPatient: t.relatedPatient,
            relatedAppointment: t.relatedAppointment,
            isSelfCreated: t.createdById === t.assignedToId,
            isOverdue: overdue,
        };
    }

    static async _userDisplayName(userId) {
        const u = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                email: true,
                doctor: { select: { fullName: true } },
                therapist: { select: { fullName: true } },
            },
        });
        return u?.doctor?.fullName || u?.therapist?.fullName || u?.email || 'A colleague';
    }

}
