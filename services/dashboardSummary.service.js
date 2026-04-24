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
                },
                orderBy: { date: 'asc' },
                take: 20,
            }),
            prisma.appointment.findMany({
                where: { therapistId, ...branchScoped, status: { in: ['REQUESTED', 'PENDING'] } },
                include: {
                    patient: { select: { id: true, fullName: true, patientId: true } },
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
                    patient: { select: { id: true, fullName: true } },
                    video: { select: { id: true, title: true } },
                },
            }).catch(() => []),
        ]);

        const exerciseRows = exercisePrescriptions.map(p => ({
            id: p.id,
            patient: p.patient,
            title: p.video?.title,
            prescribedAt: p.createdAt,
            // Completion data is out-of-scope for this summary; UI renders as "—".
            completionRate: null,
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
        ]);

        // Critical Journey count — exposed as a separate top-level stat
        // on the admin-doctor summary so the dashboard can render a KPI
        // card that links to the detailed list page.
        const adminDocCriticalWhere = { status: 'ACTIVE' };
        if (scope) adminDocCriticalWhere.branchId = scope;
        const criticalPatientsActive = await prisma.patientCriticalFlag
            .count({ where: adminDocCriticalWhere })
            .catch(() => 0);

        // Enrich staffTable with workload numbers
        const enrichedStaff = [];
        for (const u of staffTable) {
            const profileId = u.doctor?.id || u.therapist?.id;
            if (!profileId) continue;
            const isTherapist = u.role === 'THERAPIST';
            const [apptsToday, pendingApprovals, patientLoad] = await Promise.all([
                prisma.appointment.count({
                    where: isTherapist
                        ? { therapistId: profileId, date: { gte: today, lte: tomorrow } }
                        : { doctorId: profileId, date: { gte: today, lte: tomorrow } },
                }),
                prisma.appointment.count({
                    where: isTherapist
                        ? { therapistId: profileId, status: { in: ['REQUESTED', 'PENDING'] } }
                        : { doctorId: profileId, status: { in: ['REQUESTED', 'PENDING'] } },
                }),
                prisma.treatmentJourney.count({
                    where: { doctorId: u.id, status: 'ACTIVE' },
                }),
            ]);
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
            });
        }

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
            gamification: {
                topPodium: leaderboard.slice(0, 3),
                xpDistribution: await (async () => {
                    const rows = await prisma.clinicianXP.groupBy({
                        by: ['level'],
                        _count: { userId: true },
                    }).catch(() => []);
                    return rows.map(r => ({ level: r.level, count: r._count.userId }));
                })(),
                todoCompletionRate: await (async () => {
                    // "Assigned" = createdBy != assignedTo; we approximate by counting rows
                    // where createdById differs, via raw filter.
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
                })(),
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

        // Branch health summary
        const branchHealth = [];
        for (const b of branches) {
            const [apptsToday, staffToday] = await Promise.all([
                prisma.appointment.count({ where: { branchId: b.id, date: { gte: today, lte: tomorrow } } }),
                prisma.staffAttendance.count({
                    where: { branchId: b.id, date: { gte: today, lte: tomorrow }, clockIn: { not: null } },
                }).catch(() => 0),
            ]);
            branchHealth.push({
                id: b.id,
                name: b.name,
                isActive: b.isActive,
                activePatients: b._count.patients,
                staffOnDuty: staffToday,
                appointmentsToday: apptsToday,
                bedsAvailable: b.availableBeds ?? null,
                bedsTotal: b.totalBeds ?? null,
            });
        }

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
