import nodemailer from 'nodemailer';
import logger from '../lib/logger.js';
import { prismaBase } from '../lib/prisma.js';
import { getCurrentTenant } from '../lib/tenantContext.js';

// Phase 2d — per-hospital email "from" name. When a request/job tenant is set,
// emails are sent under that hospital's name; otherwise fall back to the global
// APP_NAME. Cached briefly so we don't query Hospital on every send.
const _nameCache = new Map(); // hospitalId -> { name, expires }
const NAME_TTL_MS = 5 * 60 * 1000;
async function resolveFromName() {
  const fallback = process.env.APP_NAME || 'IWIS Healthcare';
  const tenant = getCurrentTenant();
  if (!tenant) return fallback;
  const cached = _nameCache.get(tenant);
  if (cached && cached.expires > Date.now()) return cached.name || fallback;
  try {
    const h = await prismaBase.hospital.findUnique({ where: { id: tenant }, select: { name: true } });
    _nameCache.set(tenant, { name: h?.name, expires: Date.now() + NAME_TTL_MS });
    return h?.name || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Email service using Nodemailer
 * Configure with your SMTP credentials in environment variables
 */
class EmailService {
  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: process.env.SMTP_PORT || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  /**
   * Send a notification email
   */
  async sendNotification(to, title, message, data = {}) {
    try {
      const html = this.getNotificationTemplate(title, message, data);

      const fromName = await resolveFromName();
      const mailOptions = {
        from: `"${fromName}" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
        to,
        subject: title,
        html,
      };

      const info = await this.transporter.sendMail(mailOptions);
      logger.info('[EmailService] Email sent:', info.messageId);
      return info;
    } catch (error) {
      logger.error('[EmailService] Error sending email:', error);
      throw error;
    }
  }

  /**
   * Send appointment reminder email
   */
  async sendAppointmentReminder(to, appointmentDetails) {
    const { patientName, doctorName, date, time, notes } = appointmentDetails;

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #4F46E5; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
          .content { background: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
          .appointment-details { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; }
          .detail-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e5e7eb; }
          .detail-label { font-weight: bold; }
          .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0;">Appointment Reminder</h1>
          </div>
          <div class="content">
            <p>Dear ${patientName},</p>
            <p>This is a friendly reminder about your upcoming appointment.</p>
            
            <div class="appointment-details">
              <div class="detail-row">
                <span class="detail-label">Doctor:</span>
                <span>${doctorName}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Date:</span>
                <span>${date}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Time:</span>
                <span>${time}</span>
              </div>
              ${notes ? `
              <div class="detail-row">
                <span class="detail-label">Notes:</span>
                <span>${notes}</span>
              </div>
              ` : ''}
            </div>
            
            <p>Please arrive 10 minutes early. If you need to reschedule, please contact us as soon as possible.</p>
            <p>We look forward to seeing you!</p>
          </div>
          <div class="footer">
            <p>This is an automated message from ${process.env.APP_NAME || 'IWIS Healthcare'}. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendNotification(to, 'Appointment Reminder', '', { html });
  }

  /**
   * Generic notification template
   */
  getNotificationTemplate(title, message, data = {}) {
    if (data.html) return data.html;

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #4F46E5; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
          .content { background: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
          .message { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; }
          .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0;">${title}</h1>
          </div>
          <div class="content">
            <div class="message">
              <p>${message}</p>
            </div>
          </div>
          <div class="footer">
            <p>This is an automated message from ${process.env.APP_NAME || 'IWIS Healthcare'}.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Verify SMTP connection
   */
  async verify() {
    try {
      await this.transporter.verify();
      logger.info('[EmailService] SMTP connection verified');
      return true;
    } catch (error) {
      logger.error('[EmailService] SMTP verification failed:', error);
      return false;
    }
  }
}

export const emailService = new EmailService();
