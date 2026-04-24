/**
 * Template Renderer
 *
 * Substitutes `{{placeholder}}` tokens in a message body. Used by:
 *   - Daily check-in broadcast (patient name + hospital name)
 *   - Appointment confirmation / reminder (patient + doctor + date + meeting link)
 *   - Any hospital-authored message template in the `MessageTemplate` library.
 *
 * Placeholder syntax:   {{patientName}}  or  {{ patientName }} (whitespace tolerated)
 * Unknown keys render as empty string — NOT as the literal `{{key}}` — so stray
 * placeholders never leak to the patient.
 *
 * This file is intentionally dependency-free so it can be required from tests
 * without pulling in Prisma / config.
 */

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** The canonical list of placeholders the UI should expose in the template editor. */
export const STANDARD_PLACEHOLDERS = [
    { key: 'patientName',         description: 'Patient full name',                    example: 'Chellakannu' },
    { key: 'doctorName',          description: 'Attending doctor name',                example: 'Dr. Saleem' },
    { key: 'therapistName',       description: 'Therapist name (if present)',          example: 'Ms. Devi' },
    { key: 'clinicianName',       description: 'Doctor or therapist, whichever is set', example: 'Dr. Saleem' },
    { key: 'appointmentDate',     description: 'Appointment date (long form)',          example: 'Thursday, 24 April 2026' },
    { key: 'appointmentTime',     description: 'Appointment time',                      example: '10:30 AM' },
    { key: 'appointmentDateTime', description: 'Combined date + time',                  example: 'Thursday, 24 April 2026 at 10:30 AM' },
    { key: 'branchName',          description: 'Branch / clinic name',                  example: 'Al-Shifa Trichy' },
    { key: 'hospitalName',        description: 'Hospital brand name',                   example: 'Al-Shifa Group of Hospitals' },
    { key: 'meetingLink',         description: 'Online meeting link (ONLINE only)',     example: 'https://meet.jit.si/al-shifa-123' },
    { key: 'estimatedTime',       description: 'Estimated consultation duration',       example: '30 minutes' },
    { key: 'checkInLink',         description: 'Deep link to daily check-in screen',    example: 'https://app.alshifa.health/patient' },
];

/**
 * Replace `{{placeholder}}` tokens in `body` with values from `vars`.
 * Missing keys collapse to empty string.
 */
export function renderTemplate(body, vars = {}) {
    if (!body) return '';
    return String(body).replace(PLACEHOLDER_RE, (_, key) => {
        const value = vars[key];
        if (value === null || value === undefined) return '';
        return String(value);
    });
}

/**
 * Extract the distinct placeholder keys used in a body.
 * Returns [] for empty/falsy input.
 */
export function extractPlaceholders(body) {
    if (!body) return [];
    const seen = new Set();
    for (const match of String(body).matchAll(PLACEHOLDER_RE)) {
        seen.add(match[1]);
    }
    return Array.from(seen);
}

/**
 * Build a context dict from an appointment + hospital. Used when rendering
 * appointment-scoped messages. Safe to pass partial records.
 */
export function buildAppointmentContext({ appointment, hospital, patient, doctor, therapist, branch, extras = {} }) {
    const patientName = patient?.fullName || appointment?.patient?.fullName || appointment?.contactDetails?.fullName || '';
    const doctorName = doctor?.fullName || appointment?.doctor?.fullName || '';
    const therapistName = therapist?.fullName || appointment?.therapist?.fullName || '';
    const clinicianName = appointment?.consultationType === 'THERAPIST'
        ? (therapistName || doctorName)
        : (doctorName || therapistName);

    const primaryDate = appointment?.date || appointment?.therapistDate;
    const dt = primaryDate ? new Date(primaryDate) : null;
    const tz = hospital?.timezone || 'Asia/Kolkata';

    const appointmentDate = dt
        ? dt.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: tz })
        : '';
    const appointmentTime = dt
        ? dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: tz })
        : '';
    const appointmentDateTime = dt && appointmentDate && appointmentTime
        ? `${appointmentDate} at ${appointmentTime}`
        : '';

    return {
        patientName,
        doctorName,
        therapistName,
        clinicianName,
        appointmentDate,
        appointmentTime,
        appointmentDateTime,
        branchName: branch?.name || appointment?.branch?.name || '',
        hospitalName: hospital?.name || 'Al-Shifa Group of Hospitals',
        meetingLink: appointment?.meetingLink || '',
        estimatedTime: extras.estimatedTime || '30 minutes',
        checkInLink: extras.checkInLink || '',
        ...extras,
    };
}
