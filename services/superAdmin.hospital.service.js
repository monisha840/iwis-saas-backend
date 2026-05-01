import bcrypt from 'bcrypt';
import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { AuthService } from './auth.service.js';
import { SuperAdminAuditService } from './superAdmin.audit.service.js';
import { invalidateHospitalStatusCache } from '../middleware/checkHospitalStatus.js';

const PROVISIONAL_PASSWORD_ROUNDS = 12;

function ensureSlug(slug) {
  return String(slug || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export class SuperAdminHospitalService {
  static async list() {
    const hospitals = await prisma.hospital.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { branches: true, users: true } },
      },
    });
    return hospitals.map((h) => ({
      id: h.id,
      name: h.name,
      slug: h.slug,
      status: h.status,
      plan: h.plan,
      contactEmail: h.contactEmail,
      contactPhone: h.contactPhone,
      country: h.country,
      timezone: h.timezone,
      branchCount: h._count.branches,
      userCount: h._count.users,
      createdAt: h.createdAt,
      suspendedAt: h.suspendedAt,
    }));
  }

  static async getById(id) {
    const hospital = await prisma.hospital.findUnique({
      where: { id },
      include: {
        _count: { select: { branches: true, users: true } },
        branches: { select: { id: true, name: true, isActive: true, createdAt: true } },
      },
    });
    if (!hospital) {
      const e = new Error('Hospital not found');
      e.status = 404;
      throw e;
    }
    return hospital;
  }

  static async create({ actorId, ip, name, slug, contactEmail, contactPhone, address, timezone, plan, adminUser, defaultFeatures = [] }) {
    const cleanSlug = ensureSlug(slug || name);
    if (!cleanSlug) {
      const e = new Error('Valid slug is required');
      e.status = 400;
      throw e;
    }

    const exists = await prisma.hospital.findUnique({ where: { slug: cleanSlug } });
    if (exists) {
      const e = new Error('A hospital with this slug already exists');
      e.status = 409;
      throw e;
    }

    // Step 1: create hospital (PENDING_SETUP until admin is created + features attached)
    const hospital = await prisma.hospital.create({
      data: {
        name,
        slug: cleanSlug,
        contactEmail,
        contactPhone,
        address,
        timezone: timezone || 'Asia/Kolkata',
        plan: plan || 'STARTER',
        status: 'PENDING_SETUP',
      },
    });

    // Step 2: create root ADMIN user for the hospital
    let adminUserRecord = null;
    if (adminUser?.email) {
      const existingUser = await prisma.user.findUnique({ where: { email: adminUser.email } });
      if (existingUser) {
        const e = new Error(`A user with email ${adminUser.email} already exists`);
        e.status = 409;
        throw e;
      }
      // Generate a random provisional password; real password set via reset link.
      const provisional = crypto.randomBytes(24).toString('base64url');
      const hashed = await bcrypt.hash(provisional, PROVISIONAL_PASSWORD_ROUNDS);
      adminUserRecord = await prisma.user.create({
        data: {
          email: adminUser.email,
          password: hashed,
          role: 'ADMIN',
          hospitalId: hospital.id,
          emailVerifiedAt: null,
        },
      });

      // Kick off password-setup flow using the existing forgot-password path.
      try {
        await AuthService.forgotPassword(adminUser.email);
      } catch (err) {
        logger.warn('Hospital admin password-reset email failed', { hospitalId: hospital.id, err: err?.message });
      }
    }

    // Step 3: seed per-hospital feature flags. Every registry row gets a row;
    // defaults from defaultFeatures[] + FeatureRegistry.defaultEnabled + isCore.
    const registry = await prisma.featureRegistry.findMany();
    const planRank = { STARTER: 0, PROFESSIONAL: 1, ENTERPRISE: 2 };
    const hospitalPlanRank = planRank[hospital.plan] ?? 0;

    const wantedKeys = new Set(defaultFeatures || []);
    const flagData = registry.map((f) => {
      const planAllowed = (planRank[f.minPlan] ?? 0) <= hospitalPlanRank;
      const enabled = (f.isCore || f.defaultEnabled || wantedKeys.has(f.key)) && planAllowed;
      return {
        hospitalId: hospital.id,
        featureKey: f.key,
        enabled,
        enabledAt: enabled ? new Date() : null,
        enabledById: enabled ? actorId : null,
      };
    });
    if (flagData.length > 0) {
      await prisma.hospitalFeatureFlag.createMany({ data: flagData, skipDuplicates: true });
    }

    // Step 4: flip to ACTIVE
    const active = await prisma.hospital.update({
      where: { id: hospital.id },
      data: { status: 'ACTIVE' },
    });
    invalidateHospitalStatusCache(hospital.id);

    await SuperAdminAuditService.log({
      superAdminId: actorId,
      action: 'HOSPITAL_CREATED',
      hospitalId: hospital.id,
      details: { name, slug: cleanSlug, plan: hospital.plan, adminEmail: adminUser?.email ?? null },
      ipAddress: ip,
    });

    return {
      hospital: active,
      adminUserId: adminUserRecord?.id ?? null,
    };
  }

  static async update({ actorId, ip, id, patch }) {
    const allowed = ['name', 'contactEmail', 'contactPhone', 'address', 'timezone', 'plan', 'logoUrl'];
    const data = {};
    for (const k of allowed) if (patch[k] !== undefined) data[k] = patch[k];

    const before = await prisma.hospital.findUnique({ where: { id } });
    if (!before) {
      const e = new Error('Hospital not found');
      e.status = 404;
      throw e;
    }
    const updated = await prisma.hospital.update({ where: { id }, data });

    await SuperAdminAuditService.log({
      superAdminId: actorId,
      action: 'HOSPITAL_UPDATED',
      hospitalId: id,
      details: { before: pickAllowed(before, allowed), after: pickAllowed(updated, allowed) },
      ipAddress: ip,
    });

    return updated;
  }

  static async suspend({ actorId, ip, id, reason }) {
    const hospital = await prisma.hospital.findUnique({ where: { id } });
    if (!hospital) {
      const e = new Error('Hospital not found');
      e.status = 404;
      throw e;
    }
    if (hospital.status === 'SUSPENDED') return hospital;

    const updated = await prisma.hospital.update({
      where: { id },
      data: {
        status: 'SUSPENDED',
        suspendedAt: new Date(),
        suspendedById: actorId,
      },
    });

    // Revoke all refresh tokens for users in this hospital (spec §8 step 2).
    // Active users only — soft-deleted users have no live sessions to revoke.
    const users = await prisma.user.findMany({ where: { hospitalId: id, deletedAt: null }, select: { id: true } });
    await Promise.all(users.map((u) => AuthService.logoutAll(u.id).catch(() => null)));

    invalidateHospitalStatusCache(id);

    await SuperAdminAuditService.log({
      superAdminId: actorId,
      action: 'HOSPITAL_SUSPENDED',
      hospitalId: id,
      details: { reason: reason ?? null, revokedUserCount: users.length },
      ipAddress: ip,
    });

    return updated;
  }

  static async reactivate({ actorId, ip, id }) {
    const hospital = await prisma.hospital.findUnique({ where: { id } });
    if (!hospital) {
      const e = new Error('Hospital not found');
      e.status = 404;
      throw e;
    }
    const updated = await prisma.hospital.update({
      where: { id },
      data: { status: 'ACTIVE', suspendedAt: null, suspendedById: null },
    });
    invalidateHospitalStatusCache(id);
    await SuperAdminAuditService.log({
      superAdminId: actorId,
      action: 'HOSPITAL_REACTIVATED',
      hospitalId: id,
      ipAddress: ip,
    });
    return updated;
  }

  static async decommission({ actorId, ip, id }) {
    const hospital = await prisma.hospital.findUnique({ where: { id } });
    if (!hospital) {
      const e = new Error('Hospital not found');
      e.status = 404;
      throw e;
    }
    const updated = await prisma.hospital.update({
      where: { id },
      data: { status: 'DECOMMISSIONED' },
    });
    invalidateHospitalStatusCache(id);
    await SuperAdminAuditService.log({
      superAdminId: actorId,
      action: 'HOSPITAL_DECOMMISSIONED',
      hospitalId: id,
      ipAddress: ip,
    });
    return updated;
  }
}

function pickAllowed(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj?.[k] ?? null;
  return out;
}
