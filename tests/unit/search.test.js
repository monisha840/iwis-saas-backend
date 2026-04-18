import { describe, it, expect, vi } from 'vitest';

// Mock prisma to avoid database connections
vi.mock('../../lib/prisma.js', () => ({
    default: {
        patient: { findMany: vi.fn().mockResolvedValue([]) },
        appointment: { findMany: vi.fn().mockResolvedValue([]) },
        prescription: { findMany: vi.fn().mockResolvedValue([]) },
        user: { findUnique: vi.fn().mockResolvedValue(null) },
    }
}));

const { SearchService } = await import('../../services/search.service.js');

describe('Search Service Logic', () => {
    it('should reject queries shorter than 2 characters', async () => {
        const result = await SearchService.globalSearch('a', { userId: 'test', userRole: 'ADMIN' });
        expect(result.patients).toEqual([]);
        expect(result.appointments).toEqual([]);
        expect(result.prescriptions).toEqual([]);
    });

    it('should reject empty queries', async () => {
        const result = await SearchService.globalSearch('', { userId: 'test', userRole: 'ADMIN' });
        expect(result.patients).toEqual([]);
    });

    it('should reject null queries', async () => {
        const result = await SearchService.globalSearch(null, { userId: 'test', userRole: 'ADMIN' });
        expect(result.patients).toEqual([]);
    });

    it('should reject undefined queries', async () => {
        const result = await SearchService.globalSearch(undefined, { userId: 'test', userRole: 'ADMIN' });
        expect(result.patients).toEqual([]);
    });

    it('should reject whitespace-only queries', async () => {
        const result = await SearchService.globalSearch('   ', { userId: 'test', userRole: 'ADMIN' });
        expect(result.patients).toEqual([]);
    });
});
