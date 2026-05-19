import prisma from '../lib/prisma.js';
import csvParser from 'csv-parser';
import { createReadStream } from 'fs';
import { unlink } from 'fs/promises';

export class BulkService {
    static async parseCSV(filepath) {
        return new Promise((resolve, reject) => {
            const results = [];
            createReadStream(filepath)
                .pipe(csvParser())
                .on('data', (data) => results.push(data))
                .on('end', () => resolve(results))
                .on('error', reject);
        });
    }

    static validatePatientData(row) {
        const errors = [];
        if (!row.fullName?.trim()) errors.push('Full name is required');
        if (!row.email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) errors.push('Valid email is required');
        if (!row.phoneNumber?.trim() || !/^\+?[\d\s-]{10,}$/.test(row.phoneNumber)) errors.push('Valid phone number is required');
        if (row.age && (isNaN(row.age) || row.age < 0 || row.age > 150)) errors.push('Valid age is required');
        return errors;
    }

    static async initiatePatientImport(userId, filePath, totalRecords) {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        return prisma.bulkOperation.create({
            data: {
                type: 'PATIENT_IMPORT',
                initiatedBy: userId,
                status: 'PENDING',
                totalRecords,
                fileUrl: filePath,
                branchId: user?.branchId || null
            },
        });
    }

    static async executePatientImport(userId, patients) {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        const branchId = user?.branchId || null;

        const bulkOp = await prisma.bulkOperation.create({
            data: {
                type: 'PATIENT_IMPORT',
                initiatedBy: userId,
                status: 'IN_PROGRESS',
                totalRecords: patients.length,
                branchId: branchId
            },
        });

        const results = { success: [], failed: [] };

        for (let i = 0; i < patients.length; i++) {
            const data = patients[i];
            try {
                const existingUser = await prisma.user.findUnique({ where: { email: data.email } });
                if (existingUser) {
                    results.failed.push({ row: i + 1, data, error: 'Email already exists' });
                    continue;
                }

                const user = await prisma.user.create({
                    data: {
                        email: data.email,
                        password: data.password || 'ChangeMe123!',
                        role: 'PATIENT',
                    },
                });

                const patient = await prisma.patient.create({
                    data: {
                        userId: user.id,
                        fullName: data.fullName,
                        phoneNumber: data.phoneNumber,
                        age: data.age ? parseInt(data.age) : null,
                        gender: data.gender || null,
                        // Patient.therapyType is a singular String? column.
                        // CSV rows may carry either `therapyType` (single) or
                        // a comma-separated `therapyTypes` cell; both collapse
                        // to the first non-empty entry. Falls back to null.
                        therapyType: (() => {
                            if (Array.isArray(data.therapyTypes) && data.therapyTypes.length > 0) {
                                return String(data.therapyTypes[0]).trim() || null;
                            }
                            if (typeof data.therapyTypes === 'string' && data.therapyTypes.trim()) {
                                const first = data.therapyTypes.split(',').map((s) => s.trim()).filter(Boolean)[0];
                                return first || null;
                            }
                            if (typeof data.therapyType === 'string' && data.therapyType.trim()) {
                                const first = data.therapyType.split(',').map((s) => s.trim()).filter(Boolean)[0];
                                return first || null;
                            }
                            return null;
                        })(),
                        branchId: branchId // Lockdown to the importer's branch
                    },
                });

                results.success.push({ row: i + 1, patientId: patient.id, email: user.email });
            } catch (error) {
                results.failed.push({ row: i + 1, data, error: error.message });
            }
        }

        await prisma.bulkOperation.update({
            where: { id: bulkOp.id },
            data: {
                status: 'COMPLETED',
                processedRecords: results.success.length,
                failedRecords: results.failed.length,
                completedAt: new Date(),
                errorLog: results.failed.length > 0 ? results.failed : null,
            },
        });

        return { operationId: bulkOp.id, results };
    }

    static async getOperationStatus(id) {
        const operation = await prisma.bulkOperation.findUnique({
            where: { id },
            include: { user: { select: { email: true } } },
        });
        if (!operation) throw new Error('Operation not found');
        return operation;
    }

    static async listOperations() {
        return prisma.bulkOperation.findMany({
            include: { user: { select: { email: true } } },
            orderBy: { createdAt: 'desc' },
            take: 50,
        });
    }
}
