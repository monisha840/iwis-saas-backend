import dotenv from 'dotenv';
dotenv.config();
import { AppointmentService } from './services/appointment.service.js';
import { analyticsService } from './services/analytics.service.js';

async function test() {
    try {
        console.log('Testing getDashboardStats for ADMIN...');
        const user = { id: 'edf2d470-aa1e-40a8-abdc-1e773492fcc7', role: 'ADMIN_DOCTOR' };
        const stats = await analyticsService.getDashboardStats(user.role, user.id);
        console.log('Stats:', JSON.stringify(stats, null, 2));

        console.log('Testing getAppointments for PATIENT...');
        const pUser = { id: '9a9ce89c-caca-418a-9333-21a67803c9c6', role: 'PATIENT' };
        try {
            const resP = await AppointmentService.getAppointments(pUser, {});
            console.log('Success for PATIENT. Count:', resP.appointments.length);
        } catch (err) {
            console.error('PATIENT test failed:', err);
        }

        const tUser = { id: 'cad10bd3-15cb-4393-8742-b3498d87d253', role: 'THERAPIST' };
        console.log('Testing getAppointments with missing page (page=undefined, limit=20)...');
        try {
            const resMissing = await AppointmentService.getAppointments(tUser, { limit: '20' });
            console.log('Success for missing page. Count:', resMissing.appointments.length);
        } catch (err) {
            console.error('Missing page test failed:', err);
        }

        console.log('Testing getAppointments with invalid pagination (page=0)...');
        try {
            const resZero = await AppointmentService.getAppointments(tUser, { page: 0 });
            console.log('Success for page=0. Count:', resZero.appointments.length);
        } catch (err) {
            console.error('Page=0 test failed:', err);
        }

        console.log('Testing getAppointments for THERAPIST...');
        const result = await AppointmentService.getAppointments(tUser, {});
        console.log('Result count:', result.appointments.length);
        console.log('Serialization test...');
        const json = JSON.stringify(result);
        console.log('Serialization success. Length:', json.length);
    } catch (err) {
        console.error('Test failed:', err);
    } finally {
        process.exit();
    }
}

test();
