import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';

// Create a test JWT token for a given user
export function createTestToken(user = {}) {
    const payload = {
        id: user.id || 'test-user-id',
        email: user.email || 'test@example.com',
        role: user.role || 'PATIENT',
        branchId: user.branchId || null,
    };
    return jwt.sign(payload, process.env.JWT_SECRET || 'test-jwt-secret', { expiresIn: '1h' });
}

// Create tokens for different roles
export function createTokens() {
    return {
        admin: createTestToken({ id: 'admin-1', role: 'ADMIN', email: 'admin@test.com' }),
        adminDoctor: createTestToken({ id: 'admin-doc-1', role: 'ADMIN_DOCTOR', email: 'admindoc@test.com' }),
        doctor: createTestToken({ id: 'doc-1', role: 'DOCTOR', email: 'doc@test.com' }),
        therapist: createTestToken({ id: 'therapist-1', role: 'THERAPIST', email: 'therapist@test.com' }),
        patient: createTestToken({ id: 'patient-1', role: 'PATIENT', email: 'patient@test.com' }),
        pharmacist: createTestToken({ id: 'pharmacist-1', role: 'PHARMACIST', email: 'pharmacist@test.com' }),
    };
}

export { describe, it, expect, beforeAll, afterAll };
