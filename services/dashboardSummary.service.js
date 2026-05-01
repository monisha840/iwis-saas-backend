/**
 * DashboardSummaryService — single-call aggregators for each role's dashboard.
 *
 * One endpoint per role (spec §9.2) so the UI only makes a single round-trip
 * on load. Each returns a structured payload keyed by dashboard section.
 */

import prisma from '../lib/prisma.js';
import { TodoService } from './todo.service.js';
import { ClinicianXPService } from './clinicianXP.service.js';
import logger from '../lib/logger.js';

function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}

function endOfToday() {
    const d = new Date();
    d.setHours(23, 59, 59, 999);
    return d;
}

function startOfMonth() {
    const d = new Date();
    d.setDate(1); d.setHours(0, 0, 0, 0);
    return d;
}

async function profileDisplayName(user) {
    return user?.doctor?.fullName || user?.therapist?.fullName || user?.email || 'Clinician';
}

async function todoSummary(userId) {
    try { return await TodoService._summarizeInbox(userId); }
    catch { return { pending: 0, completedToday: 0, xpToday: 0, overdue: 0 }; }
}

async function leaderboardRank(userId, branchId) {
    try {
        const board = await ClinicianXPService.getLeaderboard({ branchId, limit: 100 });
        const found = board.find(e => e.userId === userId);
        return found ? { rank: found.rank, totalXP: found.totalXP, level: found.level, title: found.title } : null;
    } catch { return null; }
}

async function xpProfile(userId) {
    try { return await ClinicianXPService.getProfile(userId); }
    catch { return null; }
}

export class DashboardSummaryService {
    /* ─── DOCTOR ─────────────────────────────────────────────────────────── */

    static async doctorSummary(userId, { branchId } = {}) {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true, email: true, branchId: true,
                doctor: { select: { id: true, fullName: true } },
                branch: { select: { id: true, name: true } },
            },
        });
        if (!user || !user.doctor) {
            return { error: 'Doctor profile not found' };
        }
        const doctorId = user.doctor.id;
        const today = startOfToday();
        const tomorrow = endOfToday();
        const monthStart = startOfMonth();
        // Scope is only meaningful for admin-level callers; a plain DOCTOR sees
        // only their own data either way. `branchScoped` is spread into the
        // appointment-count where clauses so that when an admin-doctor uses the
        // shared top-bar scope selector, their own-profile dashboard view
        // narrows to that branch's appointments.
        const scope = (!branchId || branchId === 'ALL') ? null : branchId;
        const branchScoped = scope ? { branchId: scope } : {};

        // Branch scope used for surfacing group sessions on the doctor's My
        // Tasks list. Falls back to the doctor's home branch when the top-bar
        // scope selector says "ALL". Null when neither is available — we then
        // skip the group-session query entirely rather than running an
        // unscoped one.
        const groupSessionBranchId = (!branchId || branchId === 'ALL') ? user.branchId : branchId;

        const [
            appointmentsToday,
            pendingApprovals,
            activePrescriptions,
            assignedPatientsCount,
            todaysSchedule,
            pendingRequests,
            monthlyCompleted,
            monthlyConsults,
            todos,
            xp,
            rank,
            roster,
            groupSessionsTodayOnwards,
        ] = await Promise.all([
            prisma.appointment.count({
                where: {
                    doctorId,
                    ...branchScoped,
                    date: { gte: today, lte: tomorrow },
                    status: { in: ['CONFIRMED', 'IN_PROGRESS', 'ACCEPTED', 'COMPLETED'] },
                },
            }),
            prisma.appointment.count({
                where: { doctorId, ...branchScoped, status: { in: ['REQUESTED', 'PENDING'] } },
            }),
            prisma.prescription.count({
                where: { doctorId },
            }),
            prisma.treatmentJourney.count({
                where: { doctorId: userId, status: 'ACTIVE' },
            }),
            prisma.appointment.findMany({
                where: {
                    doctorId,
                    ...branchScoped,
                    date: { gte: today, lte: tomorrow },
                },
                include: {
                    patient: { select: { id: true, fullName: true, patientId: true } },
                    triageSession: { select: { id: true, urgencyLevel: true, suggestedSpecialty: true } },
                },
                orderBy: { date: 'asc' },
                take: 20,
            }),
            prisma.appointment.findMany({
                where: { doctorId, ...branchScoped, status: { in: ['REQUESTED', 'PENDING'] } },
                include: {
                    patient: { select: { id: true, fullName: true, patientId: true } },
                    triageSession: {
                        select: {
                            id: true, urgencyLevel: true, suggestedSpecialty: true,
                            compositeScore: true, redFlagsMatched: true,
                        },
                    },
                },
                orderBy: { createdAt: 'asc' },
                take: 10,
            }),
            prisma.appointment.count({
                where: { doctorId, ...branchScoped, status: 'COMPLETED', date: { gte: monthStart } },
            }),
            prisma.appointment.count({
                where: { doctorId, ...branchScoped, status: 'COMPLETED', date: { gte: monthStart } },
            }),
            todoSummary(userId),
            xpProfile(userId),
            leaderboardRank(userId, user.branchId),
            prisma.treatmentJourney.findMany({
                where: { doctorId: userId, status: 'ACTIVE' },
                select: {
                    id: true,
                    title: true,
                    condition: true,
                    wellnessScore: true,
                    patientId: true,
                    patient: {
                        select: {
                            id: true,
                            email: true,
                            patient: { select: { id: true, fullName: true, patientId: true } },
                        },
                    },
                    phases: {
                        where: { status: 'ACTIVE' },
                        select: { name: true },
                        take: 1,
                    },
                },
                orderBy: { updatedAt: 'desc' },
                take: 10,
            }).catch(() => []),
            // Upcoming group sessions in the doctor's branch scope, OR any
            // session with a participating appointment owned by this doctor —
            // covers the case where a doctor co-runs a session alongside the
            // lead therapist. OPEN + FULL only; COMPLETED / CANCELLED don't
            // belong on a forward-looking task list.
            groupSessionBranchId
                ? prisma.groupSession.findMany({
                    where: {
                        date: { gte: today },
                        status: { in: ['OPEN', 'FULL'] },
                        OR: [
                            { branchId: groupSessionBranchId },
                            { appointments: { some: { doctorId } } },
                        ],
                    },
                    include: {
                        therapist: { select: { id: true, fullName: true } },
                        room: { select: { id: true, name: true } },
                        _count: { select: { appointments: true } },
                    },
                    orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
                    take: 25,
                }).catch(() => [])
                : Promise.resolve([]),
        ]);

        // Simple care-gap surrogate: recent triage flagged as HIGH/CRITICAL + no follow-up appointment booked.
        const atRiskTriages = await prisma.triageSession.findMany({
            where: {
                branchId: user.branchId,
                urgencyLevel: { in: ['HIGH', 'URGENT', 'CRITICAL'] },
                createdAt: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
            },
            select: {
                id: true, urgencyLevel: true, suggestedSpecialty: true, createdAt: true,
                patient: { select: { id: true, fullName: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: 6,
        }).catch(() => []);

        return {
            greeting: {
                name: user.doctor.fullName || user.email,
                branch: user.branch?.name || null,
                role: 'DOCTOR',
            },
            stats: {
                appointmentsToday,
                pendingApproval: pendingApprovals,
                patientsAtRisk: atRiskTriages.length,
                activePrescriptions,
                activeJourneys: assignedPatientsCount,
                leaderboardRank: rank?.rank || null,
            },
            appointments: {
                pending: pendingRequests,
                today: todaysSchedule,
            },
            careGaps: atRiskTriages.map(t => ({
                id: t.id,
                patient: t.patient,
                type: t.urgencyLevel === 'CRITICAL' ? 'CRITICAL_TRIAGE' : 'HIGH_TRIAGE',
                severity: t.urgencyLevel,
                suggestedSpecialty: t.suggestedSpecialty,
                daysSince: Math.max(0, Math.floor((Date.now() - new Date(t.createdAt).getTime()) / (24 * 60 * 60 * 1000))),
            })),
            roster: roster.map(j => ({
                journeyId: j.id,
                title: j.title,
                condition: j.condition,
                wellnessScore: j.wellnessScore,
                patient: j.patient?.patient ? {
                    id: j.patient.patient.id,
                    fullName: j.patient.patient.fullName,
                    patientId: j.patient.patient.patientId,
                } : { id: j.patientId, fullName: j.patient?.email, patientId: null },
                currentPhase: j.phases?.[0]?.name || null,
            })),
            groupSessions: groupSessionsTodayOnwards.map(s => ({
                id: s.id,
                title: s.title,
                sessionType: s.sessionType,
                date: s.date,
                startTime: s.startTime,
                endTime: s.endTime,
                status: s.status,
                maxCapacity: s.maxCapacity,
                enrolledCount: s._count?.appointments ?? 0,
                room: s.room ? { id: s.room.id, name: s.room.name } : null,
                therapist: s.therapist ? { id: s.therapist.id, fullName: s.therapist.fullName } : null,
                branchId: s.branchId,
            })),
            todos,
            performance: {
                xp,
                rank,
                monthlyCompleted,
                monthlyConsults,
            },
        };
    }

    /* ─── THERAPIST ──────────────────────────────────────────────────────── */

    static async therapistSummary(userId, { branchId } = {}) {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true, email: true, branchId: true,
                therapist: { select: { id: true, fullName: true } },
                branch: { select: { id: true, name: true } },
            },
        });
        if (!user || !user.therapist) {
            return { error: 'Therapist profile not found' };
        }
        const therapistId = user.therapist.id;
        const today = startOfToday();
        const tomorrow = endOfToday();
        const monthStart = startOfMonth();
        // See doctorSummary — branch scope only affects admin-level callers
        // looking at their own-profile dashboard via the shared top-bar.
        const scope = (!branchId || branchId === 'ALL') ? null : branchId;
        const branchScoped = scope ? { branchId: scope } : {};

        const [
            sessionsToday,
            pendingApprovals,
            activeJourneys,
            todaysSchedule,
            pendingRequests,
            completedThisMonth,
            todos,
            xp,
            rank,
            exercisePrescriptions,
        ] = await Promise.all([
            prisma.appointment.count({
                where: {
                    therapistId,
                    ...branchScoped,
                    date: { gte: today, lte: tomorrow },
                    status: { in: ['CONFIRMED', 'IN_PROGRESS', 'ACCEPTED', 'COMPLETED'] },
                },
            }),
            prisma.appointment.count({
                where: { therapistId, ...branchScoped, status: { in: ['REQUESTED', 'PENDING'] } },
            }),
            prisma.appointment.findMany({
                where: { therapistId, ...branchScoped },
                distinct: ['patientId'],
                select: { patientId: true },
            }).then(rows => rows.length).catch(() => 0),
            prisma.appointment.findMany({
                where: { therapistId, ...branchScoped, date: { gte: today, lte: tomorrow } },
                include: {
                    patient: { select: { id: true, fullName: true, patientId: true } },
                    triageSession: { select: { id: true, urgencyLevel: true, suggestedSpecialty: true } },
                },
                orderBy: { date: 'asc' },
                take: 20,
            }),
            prisma.appointment.findMany({
                where: { therapistId, ...branchScoped, status: { in: ['REQUESTED', 'PENDING'] } },
                include: {
                    patient: { select: { id: true, fullName: true, patientId: true } },
                    triageSession: {
                        select: {
                            id: true, urgencyLevel: true, suggestedSpecialty: true,
                            compositeScore: true, redFlagsMatched: true,
                        },
                    },
                },
                orderBy: { createdAt: 'asc' },
                take: 10,
            }),
            prisma.appointment.count({
                where: { therapistId, ...branchScoped, status: 'COMPLETED', date: { gte: monthStart } },
            }),
            todoSummary(userId),
            xpProfile(userId),
            leaderboardRank(userId, user.branchId),
            prisma.videoPrescription.findMany({
                where: { therapistId },
                orderBy: { createdAt: 'desc' },
                take: 20,
                include: {
                    patient: { select: { id: true, fullName: true, userId: true } },
                    video: { select: { id: true, title: true } },
                },
            }).catch(() => []),
        ]);

        // ── Patient progress (wellness score) ──────────────────────────────
        // Resolve the most-recent active TreatmentJourney per patient and use
        // its wellnessScore as the "patient progress" displayed alongside each
        // exercise prescription. Falls back to null when the patient has no
        // active journey, which the UI renders as "—".
        const patientUserIds = Array.from(
            new Set(exercisePrescriptions.map(p => p.patient?.userId).filter(Boolean)),
        );
        const wellnessByUserId = new Map();
        if (patientUserIds.length > 0) {
            const journeys = await prisma.treatmentJourney.findMany({
                where: {
                    patientId: { in: patientUserIds },
                    status: 'ACTIVE',
                },
                select: { patientId: true, wellnessScore: true, updatedAt: true },
                orderBy: { updatedAt: 'desc' },
            });
            // findMany returns in updatedAt-desc order; first hit per patient wins.
            for (const j of journeys) {
                if (!wellnessByUserId.has(j.patientId)) {
                    wellnessByUserId.set(j.patientId, Math.round(j.wellnessScore));
                }
            }
        }

        const exerciseRows = exercisePrescriptions.map(p => ({
            id: p.id,
            patient: p.patient
                ? { id: p.patient.id, fullName: p.patient.fullName }
                : null,
            title: p.video?.title,
            prescribedAt: p.createdAt,
            // 0-100 progress derived from the patient's active TreatmentJourney
            // wellnessScore. null when the patient has no active journey.
            wellnessScore: p.patient?.userId
                ? (wellnessByUserId.get(p.patient.userId) ?? null)
                : null,
        }));

        return {
            greeting: {
                name: user.therapist.fullName || user.email,
                branch: user.branch?.name || null,
                role: 'THERAPIST',
            },
            stats: {
                sessionsToday,
                pendingApproval: pendingApprovals,
                activePatients: activeJourneys,
                prescriptionsDueReview: exerciseRows.length,
                leaderboardRank: rank?.rank || null,
            },
            sessions: {
                pending: pendingRequests,
                today: todaysSchedule,
            },
            exercisePrescriptions: exerciseRows,
            todos,
            performance: {
                xp,
                rank,
                completedThisMonth,
            },
        };
    }

    /* ─── ADMIN DOCTOR ───────────────────────────────────────────────────── */

    static async adminDoctorSummary(userId, { branchId } = {}) {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, email: true, branchId: true, role: true,
                doctor: { select: { fullName: true } },
                branch: { select: { id: true, name: true } },
            },
        });
        // Admin Doctor defaults to ALL branches (cross-branch view is their privilege).
        // A specific branchId narrows it; empty/"ALL" keeps it system-wide.
        const scope = (!branchId || branchId === 'ALL') ? null : branchId;
        const today = startOfToday();
        const tomorrow = endOfToday();
        const monthStart = startOfMonth();

        const baseWhere = scope ? { branchId: scope } : {};
        const [
            totalAppointmentsToday,
            approvalBacklog,
            activeJourneys,
            staffOnDuty,
            unassignedPatients,
            staffTable,
            escalations,
            todos,
            assignedByMe,
            leaderboard,
            scopeMonthlyCompleted,
            scopeMonthlyTotal,
        ] = await Promise.all([
            prisma.appointment.count({
                where: { ...baseWhere, date: { gte: today, lte: tomorrow } },
            }),
            prisma.appointment.count({
                where: { ...baseWhere, status: { in: ['REQUESTED', 'PENDING'] } },
            }),
            prisma.treatmentJourney.count({
                where: { ...(scope ? { branchId: scope } : {}), status: 'ACTIVE' },
            }),
            prisma.staffAttendance.count({
                where: { ...(scope ? { branchId: scope } : {}), date: { gte: today, lte: tomorrow }, clockIn: { not: null } },
            }).catch(() => 0),
            prisma.patient.count({
                where: { ...(scope ? { branchId: scope } : {}), journeys: { none: {} } },
            }).catch(() => 0),
            prisma.user.findMany({
                where: {
                    ...(scope ? { branchId: scope } : {}),
                    role: { in: ['DOCTOR', 'THERAPIST'] },
                    deletedAt: null,
                },
                select: {
                    id: true, email: true, role: true,
                    doctor: { select: { id: true, fullName: true } },
                    therapist: { select: { id: true, fullName: true } },
                    clinicianXP: { select: { totalXP: true, level: true, title: true } },
                },
                take: 200,
            }),
            prisma.triageSession.findMany({
                where: {
                    ...(scope ? { branchId: scope } : {}),
                    urgencyLevel: { in: ['URGENT', 'CRITICAL'] },
                    reviewedAt: null,
                    createdAt: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
                },
                include: { patient: { select: { id: true, fullName: true } } },
                orderBy: { createdAt: 'desc' },
                take: 10,
            }).catch(() => []),
            todoSummary(userId),
            prisma.todo.findMany({
                where: {
                    createdById: userId,
                    assignedToId: { not: userId },
                    status: { in: ['PENDING', 'IN_PROGRESS'] },
                },
                include: {
                    assignedTo: {
                        select: {
                            id: true, email: true,
                            doctor: { select: { fullName: true } },
                            therapist: { select: { fullName: true } },
                        },
                    },
                },
                orderBy: { dueDate: 'asc' },
                take: 15,
            }),
            ClinicianXPService.getLeaderboard({ branchId: scope, limit: 5 }),
            prisma.appointment.count({
                where: { ...baseWhere, status: 'COMPLETED', date: { gte: monthStart } },
            }),
            prisma.appointment.count({
                where: { ...baseWhere, date: { gte: monthStart } },
            }),
        ]);

        // Critical Journey count — exposed as a separate top-level stat
        // on the admin-doctor summary so the dashboard can render a KPI
        // card that links to the detailed list page.
        const adminDocCriticalWhere = { status: 'ACTIVE' };
        if (scope) adminDocCriticalWhere.branchId = scope;
        const criticalPatientsActive = await prisma.patientCriticalFlag
            .count({ where: adminDocCriticalWhere })
            .catch(() => 0);

        // Enrich staffTable with workload + analytics + gamification metrics.
        // Admin doctor has full oversight visibility: they see clinical
        // throughput (completion / no-show rates) AND the gamification
        // signals (XP / level / title) so they can supervise the engagement
        // program without participating in it themselves.
        const enrichedStaff = [];
        for (const u of staffTable) {
            const profileId = u.doctor?.id || u.therapist?.id;
            if (!profileId) continue;
            const isTherapist = u.role === 'THERAPIST';
            const idWhere = isTherapist ? { therapistId: profileId } : { doctorId: profileId };
            const [
                apptsToday,
                pendingApprovals,
                patientLoad,
                monthlyCompleted,
                monthlyTotal,
                monthlyNoShow,
            ] = await Promise.all([
                prisma.appointment.count({
                    where: { ...idWhere, date: { gte: today, lte: tomorrow } },
                }),
                prisma.appointment.count({
                    where: { ...idWhere, status: { in: ['REQUESTED', 'PENDING'] } },
                }),
                prisma.treatmentJourney.count({
                    where: { doctorId: u.id, status: 'ACTIVE' },
                }),
                prisma.appointment.count({
                    where: { ...idWhere, status: 'COMPLETED', date: { gte: monthStart } },
                }),
                prisma.appointment.count({
                    where: { ...idWhere, date: { gte: monthStart } },
                }),
                prisma.appointment.count({
                    where: { ...idWhere, status: 'NO_SHOW', date: { gte: monthStart } },
                }).catch(() => 0),
            ]);
            const completionRate = monthlyTotal > 0
                ? Math.round((monthlyCompleted / monthlyTotal) * 100)
                : null;
            const noShowRate = monthlyTotal > 0
                ? Math.round((monthlyNoShow / monthlyTotal) * 100)
                : null;
            enrichedStaff.push({
                id: u.id,
                name: u.doctor?.fullName || u.therapist?.fullName || u.email,
                role: u.role,
                totalXP: u.clinicianXP?.totalXP || 0,
                level: u.clinicianXP?.level || 1,
                title: u.clinicianXP?.title || 'Intern',
                appointmentsToday: apptsToday,
                pendingApprovals,
                patientLoad,
                monthlyCompleted,
                monthlyTotal,
                completionRate,
                noShowRate,
            });
        }

        // Workload distribution buckets — how many clinicians fall into each
        // monthly-completed band. Replaces the old XP-level histogram.
        const workloadDistribution = (() => {
            const buckets = [
                { label: '0',      min: 0,   max: 0,        count: 0 },
                { label: '1-10',   min: 1,   max: 10,       count: 0 },
                { label: '11-25',  min: 11,  max: 25,       count: 0 },
                { label: '26-50',  min: 26,  max: 50,       count: 0 },
                { label: '51-100', min: 51,  max: 100,      count: 0 },
                { label: '100+',   min: 101, max: Infinity, count: 0 },
            ];
            for (const s of enrichedStaff) {
                const b = buckets.find(bk => s.monthlyCompleted >= bk.min && s.monthlyCompleted <= bk.max);
                if (b) b.count += 1;
            }
            return buckets.map(({ min: _min, max: _max, ...rest }) => rest);
        })();

        // Top 3 performers by monthly completed consults — analytics ranking,
        // not a leaderboard. Ties broken by completion rate.
        const topPerformers = [...enrichedStaff]
            .filter(s => s.monthlyCompleted > 0)
            .sort((a, b) => {
                if (b.monthlyCompleted !== a.monthlyCompleted) return b.monthlyCompleted - a.monthlyCompleted;
                return (b.completionRate || 0) - (a.completionRate || 0);
            })
            .slice(0, 3)
            .map(s => ({
                userId: s.id,
                name: s.name,
                role: s.role,
                monthlyCompleted: s.monthlyCompleted,
                completionRate: s.completionRate,
            }));

        // Weekly delegation-follow-through — how often todos this admin-doctor
        // (or any assigner) hands out actually get finished. Kept because it's
        // an operational KPI for admin oversight, not a gamified score.
        const todoCompletionRate = await (async () => {
            const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            try {
                const rows = await prisma.todo.findMany({
                    where: {
                        ...(scope ? { branchId: scope } : {}),
                        createdAt: { gte: weekAgo },
                    },
                    select: { status: true, createdById: true, assignedToId: true },
                });
                const assigned = rows.filter(r => r.createdById !== r.assignedToId);
                if (assigned.length === 0) return null;
                const completed = assigned.filter(r => r.status === 'COMPLETED').length;
                return Math.round((completed / assigned.length) * 100);
            } catch {
                return null;
            }
        })();

        const scopeCompletionRate = scopeMonthlyTotal > 0
            ? Math.round((scopeMonthlyCompleted / scopeMonthlyTotal) * 100)
            : null;

        return {
            greeting: {
                name: user.doctor?.fullName || user.email,
                branch: user.branch?.name || null,
                role: 'ADMIN_DOCTOR',
                scope: scope || 'ALL',
            },
            stats: {
                totalAppointmentsToday,
                approvalBacklog,
                openCareGaps: escalations.length,
                staffOnDuty,
                unassignedPatients,
                activeJourneys,
                criticalPatients: criticalPatientsActive,
            },
            staff: enrichedStaff,
            escalations: escalations.map(e => ({
                id: e.id,
                type: 'TRIAGE_ESCALATION',
                patient: e.patient,
                urgency: e.urgencyLevel,
                suggestedSpecialty: e.suggestedSpecialty,
                createdAt: e.createdAt,
            })),
            todos,
            assignedByMe: assignedByMe.map(t => ({
                id: t.id,
                title: t.title,
                priority: t.priority,
                status: t.status,
                dueDate: t.dueDate,
                xpReward: t.xpReward,
                isOverdue: !!(t.dueDate && new Date(t.dueDate).getTime() < Date.now()),
                assignee: {
                    id: t.assignedTo.id,
                    name: t.assignedTo.doctor?.fullName || t.assignedTo.therapist?.fullName || t.assignedTo.email,
                },
            })),
            analytics: {
                topPerformers,
                workloadDistribution,
                todoCompletionRate,
                monthlyCompleted: scopeMonthlyCompleted,
                monthlyTotal: scopeMonthlyTotal,
                monthlyCompletionRate: scopeCompletionRate,
            },
            // Gamification oversight for admin doctor — they supervise the
            // program so they need full visibility into leaderboard standings
            // and XP distribution without being participants themselves.
            gamification: {
                topPodium: leaderboard.slice(0, 3),
                xpDistribution: await (async () => {
                    const rows = await prisma.clinicianXP.groupBy({
                        by: ['level'],
                        _count: { userId: true },
                    }).catch(() => []);
                    return rows.map(r => ({ level: r.level, count: r._count.userId }));
                })(),
                todoCompletionRate,
            },
        };
    }

    /* ─── ADMIN ──────────────────────────────────────────────────────────── */

    static async adminSummary(userId, { branchId } = {}) {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, email: true, role: true, hospitalId: true,
                doctor: { select: { fullName: true } },
            },
        });
        const today = startOfToday();
        const tomorrow = endOfToday();
        const scope = (!branchId || branchId === 'ALL') ? null : branchId;
        const branchScoped = scope ? { branchId: scope } : {};

        const [
            totalPatients,
            newPatientsToday,
            appointmentsToday,
            activeStaff,
            branches,
            pendingRewards,
            attendanceToday,
            todos,
            assignedByMe,
            anomalies,
        ] = await Promise.all([
            prisma.patient.count({ where: branchScoped }),
            prisma.patient.count({ where: { ...branchScoped, createdAt: { gte: today } } }),
            prisma.appointment.count({ where: { ...branchScoped, date: { gte: today, lte: tomorrow } } }),
            prisma.user.count({
                where: { ...branchScoped, role: { notIn: ['PATIENT', 'SUPER_ADMIN'] }, deletedAt: null },
            }),
            prisma.branch.findMany({
                where: scope
                    ? { id: scope }
                    : (user.hospitalId ? { hospitalId: user.hospitalId } : {}),
                select: {
                    id: true, name: true, isActive: true,
                    totalBeds: true, availableBeds: true,
                    _count: { select: { patients: true } },
                },
                take: 30,
            }),
            prisma.rewardRedemption.count({ where: { status: 'PENDING' } }).catch(() => 0),
            prisma.staffAttendance.findMany({
                where: { ...branchScoped, date: { gte: today, lte: tomorrow } },
                include: {
                    user: {
                        select: {
                            id: true, email: true, role: true,
                            doctor: { select: { fullName: true } },
                            therapist: { select: { fullName: true } },
                        },
                    },
                    branch: { select: { id: true, name: true } },
                },
                orderBy: { checkInAt: 'desc' },
                take: 50,
            }).catch(() => []),
            todoSummary(userId),
            prisma.todo.findMany({
                where: {
                    createdById: userId,
                    assignedToId: { not: userId },
                    status: { in: ['PENDING', 'IN_PROGRESS'] },
                },
                include: {
                    assignedTo: {
                        select: {
                            id: true, email: true,
                            doctor: { select: { fullName: true } },
                            therapist: { select: { fullName: true } },
                        },
                    },
                },
                orderBy: { dueDate: 'asc' },
                take: 15,
            }),
            prisma.gamificationAnomaly.count({ where: { resolved: false } }).catch(() => 0),
        ]);

        // Critical Journey aggregate — patients currently flagged as
        // non-adherent (missed meds / vital uploads / follow-ups). Scoped
        // to the same branch filter the rest of the summary uses.
        const criticalWhere = { status: 'ACTIVE' };
        if (scope) criticalWhere.branchId = scope;
        const [criticalTotal, criticalBySeverity] = await Promise.all([
            prisma.patientCriticalFlag.count({ where: criticalWhere }).catch(() => 0),
            prisma.patientCriticalFlag.groupBy({
                by: ['severity'],
                where: criticalWhere,
                _count: { _all: true },
            }).catch(() => []),
        ]);
        const criticalSeverityMap = Object.fromEntries(criticalBySeverity.map(s => [s.severity, s._count._all]));

        // Branch health summary — was 2*N queries (one count per branch); now
        // two groupBys total. Latency stays flat as branch count grows.
        const branchIds = branches.map((b) => b.id);
        const [apptCounts, attendanceCounts] = await Promise.all([
            branchIds.length === 0 ? [] : prisma.appointment.groupBy({
                by: ['branchId'],
                where: { branchId: { in: branchIds }, date: { gte: today, lte: tomorrow } },
                _count: { _all: true },
            }),
            branchIds.length === 0 ? [] : prisma.staffAttendance.groupBy({
                by: ['branchId'],
                where: {
                    branchId: { in: branchIds },
                    date: { gte: today, lte: tomorrow },
                    clockIn: { not: null },
                },
                _count: { _all: true },
            }).catch(() => []),
        ]);
        const apptByBranch = new Map(apptCounts.map((r) => [r.branchId, r._count._all]));
        const attendanceByBranch = new Map(attendanceCounts.map((r) => [r.branchId, r._count._all]));

        const branchHealth = branches.map((b) => ({
            id: b.id,
            name: b.name,
            isActive: b.isActive,
            activePatients: b._count.patients,
            staffOnDuty: attendanceByBranch.get(b.id) ?? 0,
            appointmentsToday: apptByBranch.get(b.id) ?? 0,
            bedsAvailable: b.availableBeds ?? null,
            bedsTotal: b.totalBeds ?? null,
        }));

        return {
            greeting: {
                name: user.doctor?.fullName || user.email,
                role: 'ADMIN',
            },
            systemHealth: {
                status: 'OK',
                unresolvedAnomalies: anomalies,
                pendingRewards,
                criticalPatients: criticalTotal,
                criticalPatientsHigh: criticalSeverityMap.HIGH || 0,
                criticalPatientsMedium: criticalSeverityMap.MEDIUM || 0,
                criticalPatientsLow: criticalSeverityMap.LOW || 0,
            },
            stats: {
                totalPatients,
                newPatientsToday,
                appointmentsToday,
                activeStaff,
            },
            branches: branchHealth,
            attendance: attendanceToday.map(a => ({
                id: a.id,
                name: a.user?.doctor?.fullName || a.user?.therapist?.fullName || a.user?.email,
                role: a.user?.role,
                branch: a.branch?.name,
                checkInAt: a.clockIn,
                checkOutAt: a.clockOut,
                status: a.status,
            })),
            todos,
            assignedByMe: assignedByMe.map(t => ({
                id: t.id,
                title: t.title,
                priority: t.priority,
                status: t.status,
                dueDate: t.dueDate,
                xpReward: t.xpReward,
                isOverdue: !!(t.dueDate && new Date(t.dueDate).getTime() < Date.now()),
                assignee: {
                    id: t.assignedTo.id,
                    name: t.assignedTo.doctor?.fullName || t.assignedTo.therapist?.fullName || t.assignedTo.email,
                },
            })),
        };
    }

    /* ─── Staff lookup for assignment dropdown (assigners only) ─────────── */

    static async listAssignableStaff(actor) {
        if (!['ADMIN', 'ADMIN_DOCTOR'].includes(actor.role)) {
            return [];
        }
        // Both ADMIN and ADMIN_DOCTOR can assign across all branches.
        const where = { role: { in: ['DOCTOR', 'THERAPIST', 'ADMIN_DOCTOR', 'ADMIN', 'PHARMACIST'] }, deletedAt: null };

        const users = await prisma.user.findMany({
            where,
            select: {
                id: true, email: true, role: true, branchId: true,
                doctor: { select: { fullName: true } },
                therapist: { select: { fullName: true } },
                branch: { select: { id: true, name: true } },
            },
            take: 300,
            orderBy: [{ role: 'asc' }, { email: 'asc' }],
        });
        return users.map(u => ({
            id: u.id,
            name: u.doctor?.fullName || u.therapist?.fullName || u.email,
            role: u.role,
            branch: u.branch?.name || null,
        }));
    }
}
