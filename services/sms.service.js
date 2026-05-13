import twilio from 'twilio';
import logger from '../lib/logger.js';

/**
 * SMS service using Twilio
 * Configure with your Twilio credentials in environment variables:
 * - TWILIO_ACCOUNT_SID
 * - TWILIO_AUTH_TOKEN
 * - TWILIO_PHONE_NUMBER
 */
class SMSService {
    constructor() {
        this.accountSid = process.env.TWILIO_ACCOUNT_SID;
        this.authToken = process.env.TWILIO_AUTH_TOKEN;
        this.fromNumber = process.env.TWILIO_PHONE_NUMBER;

        if (this.accountSid && this.authToken) {
            this.client = twilio(this.accountSid, this.authToken);
            logger.info('[SMSService] Twilio client initialized');
        } else {
            logger.warn('[SMSService] Twilio credentials not configured. SMS notifications will be disabled.');
        }
    }

    /**
     * Send notification SMS
     */
    async sendNotification(to, message) {
        if (!this.client) {
            logger.warn('[SMSService] Twilio not configured. Skipping SMS.');
            return null;
        }

        try {
            // Ensure phone number is in correct format (+91XXXXXXXXXX)
            const formattedNumber = this.formatPhoneNumber(to);

            const result = await this.client.messages.create({
                body: message,
                from: this.fromNumber,
                to: formattedNumber,
            });

            logger.info('[SMSService] SMS sent:', result.sid);
            return result;
        } catch (error) {
            logger.error('[SMSService] Error sending SMS:', error);
            throw error;
        }
    }

    /**
     * Send appointment reminder SMS
     */
    async sendAppointmentReminder(to, appointmentDetails) {
        const { patientName, doctorName, date, time } = appointmentDetails;

        const message = `Hi ${patientName}, reminder: You have an appointment with Dr. ${doctorName} on ${date} at ${time}. Please arrive 10 minutes early.`;

        return await this.sendNotification(to, message);
    }

    /**
     * Format phone number to E.164 format
     * Assumes Indian numbers (+91)
     */
    formatPhoneNumber(phoneNumber) {
        // Remove all non-numeric characters
        let cleaned = phoneNumber.replace(/\D/g, '');

        // If it starts with country code, return as is
        if (cleaned.startsWith('91') && cleaned.length === 12) {
            return `+${cleaned}`;
        }

        // If it's 10 digits, assume it's an Indian number
        if (cleaned.length === 10) {
            return `+91${cleaned}`;
        }

        // Otherwise, return the original
        return phoneNumber;
    }

    /**
     * Check if Twilio is configured
     */
    isConfigured() {
        return !!this.client;
    }
}

export const smsService = new SMSService();
