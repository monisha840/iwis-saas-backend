import { PrismaClient } from '@prisma/client';
import { AppointmentService } from './services/appointment.service.js';

const prisma = new PrismaClient();

async function testBookingFixes() {
    console.log('--- Testing Appointment Booking Fixes ---');
    try {
        const patient = await prisma.patient.findFirst();
        const doctor = await prisma.doctor.findFirst({
            include: { user: true },
            where: {
                user: {
                    role: { not: 'ADMIN_DOCTOR' }
                }
            }
        });

        if (!patient || !doctor) {
            console.log('Required data (patient/doctor) not found to test.');
            return;
        }

        const date = new Date();
        date.setHours(date.getHours() + 2, 0, 0, 0); // 2 hours from now

        console.log('1. Testing Valid Booking with SCHEDULED status...');
        const appointment = await AppointmentService.createAppointment(
            { role: 'ADMIN', id: 'admin-id' },
            {
                patientId: patient.id,
                doctorId: doctor.id,
                date: date.toISOString(),
                status: 'SCHEDULED',
                contactDetails: {
                    fullName: patient.fullName,
                    phoneNumber: '1234567890',
                    email: 'test@example.com'
                }
            }
        );
        console.log('✓ Valid booking successful.');

        console.log('2. Testing Duplicate Booking Prevention (Same Patient, Same Doctor, Same Time)...');
        try {
            await AppointmentService.createAppointment(
                { role: 'ADMIN', id: 'admin-id' },
                {
                    patientId: patient.id,
                    doctorId: doctor.id,
                    date: date.toISOString(),
                    status: 'SCHEDULED',
                    contactDetails: {
                        fullName: patient.fullName,
                        phoneNumber: '1234567890',
                        email: 'test@example.com'
                    }
                }
            );
            console.log('✗ FAILED: Duplicate booking was NOT blocked.');
        } catch (e) {
            console.log('✓ Success: Duplicate booking blocked with error:', e.message);
        }

        console.log('3. Testing Doctor Double-booking Prevention...');
        const otherPatient = await prisma.patient.findFirst({ where: { id: { not: patient.id } } });
        if (otherPatient) {
            try {
                await AppointmentService.createAppointment(
                    { role: 'ADMIN', id: 'admin-id' },
                    {
                        patientId: otherPatient.id,
                        doctorId: doctor.id,
                        date: date.toISOString(),
                        status: 'SCHEDULED',
                        contactDetails: {
                            fullName: otherPatient.fullName,
                            phoneNumber: '0987654321',
                            email: 'other@example.com'
                        }
                    }
                );
                console.log('✗ FAILED: Doctor double-booking was NOT blocked.');
            } catch (e) {
                console.log('✓ Success: Doctor double-booking blocked with error:', e.message);
            }
        } else {
            console.log('Skipping step 3: No secondary patient found.');
        }

        console.log('--- Test Completed ---');
    } catch (error) {
        console.error('Test Execution Failed:', error);
        if (error.stack) console.error(error.stack);
    } finally {
        await prisma.$disconnect();
    }
}

testBookingFixes();
