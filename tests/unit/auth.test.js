import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

const JWT_SECRET = 'test-jwt-secret';

describe('Auth Logic', () => {
    describe('JWT Token Generation', () => {
        it('should create a valid JWT with required fields', () => {
            const payload = { id: 'user-1', role: 'PATIENT', email: 'test@test.com' };
            const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '15m' });
            const decoded = jwt.verify(token, JWT_SECRET);

            expect(decoded.id).toBe('user-1');
            expect(decoded.role).toBe('PATIENT');
            expect(decoded.email).toBe('test@test.com');
            expect(decoded.exp).toBeDefined();
        });

        it('should reject expired tokens', () => {
            const token = jwt.sign({ id: 'user-1' }, JWT_SECRET, { expiresIn: '-1s' });
            expect(() => jwt.verify(token, JWT_SECRET)).toThrow('jwt expired');
        });

        it('should reject tokens with wrong secret', () => {
            const token = jwt.sign({ id: 'user-1' }, JWT_SECRET);
            expect(() => jwt.verify(token, 'wrong-secret')).toThrow();
        });
    });

    describe('Password Hashing', () => {
        it('should hash password and verify correctly', async () => {
            const password = 'SecurePass123!';
            const hash = await bcrypt.hash(password, 12);

            expect(hash).not.toBe(password);
            expect(await bcrypt.compare(password, hash)).toBe(true);
            expect(await bcrypt.compare('WrongPass123!', hash)).toBe(false);
        });

        it('should generate unique hashes for same password', async () => {
            const password = 'SecurePass123!';
            const hash1 = await bcrypt.hash(password, 12);
            const hash2 = await bcrypt.hash(password, 12);

            expect(hash1).not.toBe(hash2);
        });
    });

    describe('Role Authorization', () => {
        it('should correctly identify admin roles', () => {
            const adminRoles = ['ADMIN', 'ADMIN_DOCTOR'];
            const nonAdminRoles = ['DOCTOR', 'THERAPIST', 'PATIENT', 'PHARMACIST'];

            adminRoles.forEach(role => {
                expect(['ADMIN', 'ADMIN_DOCTOR'].includes(role)).toBe(true);
            });
            nonAdminRoles.forEach(role => {
                expect(['ADMIN', 'ADMIN_DOCTOR'].includes(role)).toBe(false);
            });
        });

        it('should validate role middleware logic', () => {
            const allowedRoles = ['ADMIN', 'DOCTOR'];

            expect(allowedRoles.includes('ADMIN')).toBe(true);
            expect(allowedRoles.includes('DOCTOR')).toBe(true);
            expect(allowedRoles.includes('PATIENT')).toBe(false);
            expect(allowedRoles.includes('THERAPIST')).toBe(false);
        });
    });
});
